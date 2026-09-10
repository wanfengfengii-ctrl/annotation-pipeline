import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import {
  SOLO_ORIGIN,
  SoloClient,
  savePrivateJSON,
  readAuthentication,
} from './solo-client.mjs';
import { syncRecords } from './solo-sync.mjs';
import { recordKey, parseRound } from './solo-records.mjs';
import { sanitizeExportRows } from '../lib/export-safety.mjs';
import { verifyTerminalFinalization } from './terminal-finalization.mjs';
import { applyUploadHolds, assertUploadNotHeld } from './solo-upload-holds.mjs';
import { createSoloNativeAttachment } from './solo-native-attachment.mjs';
import { resolveSoloNativeIdentity } from './solo-native-identity.mjs';
import {
  applyManualAdmissions,
  manualAttachment,
} from './solo-manual-admission.mjs';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const root = path.join(project, '.runner');
const stateDir = path.join(root, 'solo-upload');
const authPath = path.join(stateDir, 'auth.json');
const statePath = path.join(stateDir, 'state.json');
const local = 'http://localhost:3000';

function submissionSecrets() {
  let configured = {};
  let runnerToken = process.env.RUNNER_TOKEN;
  try {
    configured =
      JSON.parse(
        readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8'),
      ).env || {};
  } catch {}
  try {
    runnerToken ||= readFileSync(path.join(project, '.dev.vars'), 'utf8').match(
      /^RUNNER_TOKEN=(.+)$/m,
    )?.[1];
  } catch {}
  return [
    runnerToken,
    process.env.apikey,
    configured.ANTHROPIC_AUTH_TOKEN,
    configured.ANTHROPIC_API_KEY,
  ].filter((value) => typeof value === 'string' && value.length >= 12);
}

async function readLocal(route) {
  const r = await fetch(local + route, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error('本地流水线接口不可用');
  return r.json();
}

export async function records(projectId = '') {
  const rows = [],
    seen = new Set();
  let headers;
  for (let page = 1; page <= 1000; page++) {
    const r = await readLocal(
      '/api/records?' +
        new URLSearchParams({
          source: 'ai',
          page: String(page),
          pageSize: '100',
          ...(projectId ? { projectId } : {}),
        }),
    );
    if (
      !Array.isArray(r.rows) ||
      !Array.isArray(r.headers) ||
      !Number.isInteger(r.totalPages)
    )
      throw Error('本地导出列表格式无效');
    if (headers && JSON.stringify(headers) !== JSON.stringify(r.headers))
      throw Error('读取时导出字段发生变化');
    headers = r.headers;
    for (const row of r.rows)
      if (!seen.has(recordKey(row))) {
        rows.push(row);
        seen.add(recordKey(row));
      }
    if (page >= r.totalPages) {
      const safetyOptions = { knownSecrets: submissionSecrets() };
      const safe = rows.map((row) => ({
        ...row,
        values: sanitizeExportRows([row.values], safetyOptions).rows[0],
      }));
      if (
        sanitizeExportRows(
          safe.map((r) => r.values),
          safetyOptions,
        ).safety.findings
      )
        throw Error('提交字段复查仍包含敏感内容');
      const currentTasks = (await readLocal('/api/tasks')).tasks;
      const promptIndex = headers.indexOf('TurnID/PromptID');
      const mapped = applyUploadHolds(safe).map((row) => {
        if (row.uploadHold) return row;
        const task = currentTasks.find((t) => t.id === row.taskId);
        const turn = task?.turns.find((t) => t.id === row.turnId);
        if (
          !turn?.container ||
          (turn.harness || task.harness || 'Claude Code') !== 'Claude Code'
        )
          return row;
        try {
          if (promptIndex < 0) throw Error('缺少原生 PromptID 导出字段');
          const nativeIdentity = resolveSoloNativeIdentity({
            dir: path.join(root, row.taskId),
            traceExport: turn.traceExport,
            containerId: turn.container.containerId,
            sessionId: turn.sessionId,
            messageUuid: turn.promptId,
          });
          const values = [...row.values];
          values[promptIndex] = nativeIdentity.promptId;
          return { ...row, values, nativeIdentity };
        } catch (error) {
          return { ...row, eligible: false, nativeIdIssue: error.message };
        }
      });
      return { rows: applyManualAdmissions(mapped), headers };
    }
  }
  throw Error('本地数据量超过单次分页范围');
}

function lock() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'sync.lock');
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isInteger(old.pid) || old.pid < 1)
      throw Error('上传锁无效，请人工核对');
    try {
      process.kill(old.pid, 0);
      throw Error('已有上传进程运行，跳过并发执行');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
    unlinkSync(file);
  }
  const fd = openSync(file, 'wx', 0o600);
  writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
  );
  closeSync(fd);
  return () => {
    if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid)
      unlinkSync(file);
  };
}

async function login() {
  if (!process.stdin.isTTY)
    throw Error('请在本机交互终端运行 --login，密码不会保存');
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, next) {
      if (!hidden) process.stdout.write(chunk, encoding);
      next();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const username = (await rl.question('SOLO 账号：')).trim();
    process.stdout.write('SOLO 密码（不显示）：');
    hidden = true;
    let password = await rl.question('');
    hidden = false;
    process.stdout.write('\n');
    const client = new SoloClient({
      saveAuth: (a) => savePrivateJSON(authPath, a),
    });
    const user = await client.login(username, password);
    password = '';
    return {
      status: 'authenticated',
      userId: user.id,
      note: '仅保存登录会话，密码未保存',
    };
  } finally {
    rl.close();
  }
}

export function requireUploadFinalization(
  finalization,
  { taskId, questionId, containerId, sessionId },
) {
  if (!finalization) throw Error('等待本题原终端最终导出和容器清理完成');
  if (finalization.commandTransport !== 'original-mac-terminal')
    throw Error('旧协议收尾记录需核对，不自动作为原终端最终导出提交');
  if (
    finalization.status !== 'removed' ||
    finalization.taskId !== taskId ||
    finalization.questionId !== questionId ||
    finalization.containerId !== containerId ||
    !sessionId ||
    finalization.sessionId !== sessionId ||
    finalization.emptyWithoutCalls ||
    !finalization.traceExport?.sha256
  )
    throw Error('最终导出回执与本题容器或原生轨迹不符');
}

export async function attachment(row, schema = {}) {
  assertUploadNotHeld(row);
  if (row.manualAdmission) return manualAttachment(row, submissionSecrets());
  assertUploadNotHeld(row);
  const knownSecrets = submissionSecrets();
  const tasks = await readLocal('/api/tasks');
  const t = tasks.tasks.find((t) => t.id === row.taskId),
    turn = t?.turns.find((q) => q.id === row.turnId);
  if (
    !turn?.automation?.delivery?.value?.passed ||
    turn.permissionAudit?.passed !== true
  )
    throw Error('提交前权限或内部交付核验未通过');
  const modulePath = path.join(project, 'scripts/submission-package.mjs');
  if (!existsSync(modulePath))
    throw Error('完整轨迹提交包功能正在接入，暂不上传旧内部归档');
  const api = await import(pathToFileURL(modulePath).href);
  if (typeof api.verifySubmissionPackage !== 'function')
    throw Error('完整轨迹包验证接口尚未就绪');
  const dir = path.join(root, row.taskId);
  const questionId = turn.questionRootId || turn.id;
  const finalization = verifyTerminalFinalization({
    taskDir: dir,
    questionId,
    terminal: turn.container?.terminal,
  });
  requireUploadFinalization(finalization, {
    taskId: row.taskId,
    questionId,
    containerId: turn.container?.containerId,
    sessionId: turn.sessionId,
  });
  const traceExport = finalization.traceExport;
  let sourceArchive = turn.automation.archive;
  if (!sourceArchive) {
    const result = JSON.parse(
      readFileSync(path.join(dir, row.turnId + '.result.json'), 'utf8'),
    );
    if (
      result.taskId !== row.taskId ||
      result.turnId !== row.turnId ||
      result.success !== true
    )
      throw Error('归档回执与当前记录不一致');
    sourceArchive = result.automation.archive;
  }
  const packageCache = path.join(
    stateDir,
    'packages',
    row.taskId + '_' + row.turnId + '.json',
  );
  const previous = existsSync(packageCache)
    ? JSON.parse(readFileSync(packageCache, 'utf8'))
    : null;
  const matches = (p) =>
    p?.version === api.submissionPackageVersion &&
    p?.sourceArchiveSha256 === sourceArchive.sha256 &&
    p?.traceExportSha256 === traceExport.sha256 &&
    p?.finalization?.receiptSha256 === finalization.receiptSha256;
  let submission = [turn.automation.submission, previous].find(matches);
  if (!submission) {
    if (typeof api.createSubmissionPackage !== 'function')
      throw Error('完整轨迹包构建接口尚未就绪');
    submission = await api.createSubmissionPackage({
      dir,
      turnId: row.turnId,
      archive: sourceArchive,
      traceExport,
      knownSecrets,
      finalization,
    });
    savePrivateJSON(packageCache, submission);
  }
  if (submission.status !== 'passed')
    throw Error('提交副本包含需人工核查的内容');
  const verified = await api.verifySubmissionPackage(submission, {
    dir,
    sourceArchive,
    traceExport,
    knownSecrets,
  });
  if (!verified || verified.status !== 'passed')
    throw Error('完整轨迹提交包校验失败');
  return {
    ...createSoloNativeAttachment({
      dir,
      turnId: row.turnId,
      traceExport,
      containerId: turn.container.containerId,
      sessionId: turn.sessionId,
      promptId: row.nativeIdentity?.promptId,
      knownSecrets,
      maxBytes: (schema.attachment_max_mb || 20) * 1024 * 1024,
    }),
    submission,
  };
}

export async function main(action) {
  if (action === '--login') return login();
  if (!['--plan', '--once', '--status'].includes(action))
    throw Error(
      '用法：node scripts/solo-upload.mjs --login | --plan | --once | --status',
    );
  if (action === '--status') {
    const state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : {};
    return {
      configured: existsSync(authPath),
      schedule: 'Asia/Shanghai 08:00,20:00',
      lastRun: state.lastRun,
      entries: Object.values(state.entries || {}).map(
        ({ taskId, turnId, state, remoteId, remoteStatus, message }) => ({
          taskId,
          turnId,
          state,
          remoteId,
          remoteStatus,
          message,
        }),
      ),
    };
  }
  const release = lock();
  try {
    if (action === '--once' && existsSync(path.join(stateDir, 'ui-state.json')))
      throw Error(
        '本系统已启用浏览器上传台账，禁止混用 API 写入；请使用早晚浏览器任务',
      );
    const source = await records();
    const sessionIndex = source.headers.indexOf('SessionID'),
      roundIndex = source.headers.indexOf('当前对话轮次排序');
    source.rows.sort(
      (a, b) =>
        String(a.values[sessionIndex]).localeCompare(
          String(b.values[sessionIndex]),
        ) ||
        parseRound(a.values[roundIndex]) - parseRound(b.values[roundIndex]),
    );
    const eligible = source.rows.filter((r) => r.eligible);
    if (!existsSync(authPath))
      return {
        status: 'awaiting_login',
        eligible: eligible.length,
        excluded: source.rows.length - eligible.length,
        uploaded: 0,
      };
    const client = new SoloClient({
      auth: readAuthentication(authPath),
      saveAuth: (a) => savePrivateJSON(authPath, a),
    });
    const user = await client.me(),
      schema = await client.schema();
    if (action === '--plan')
      return {
        status: 'ready',
        eligible: eligible.length,
        excluded: source.rows.length - eligible.length,
        schemaFingerprint: schema.fingerprint,
        userId: user.id,
        uploaded: 0,
      };
    const ledger = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : { version: 1, origin: SOLO_ORIGIN, userId: user.id, entries: {} };
    if (
      ledger.origin !== SOLO_ORIGIN ||
      String(ledger.userId) !== String(user.id)
    )
      throw Error('上传台账与当前账号不匹配');
    const counts = await syncRecords({
      client,
      ...source,
      schema,
      ledger,
      save: (x) => savePrivateJSON(statePath, x),
      prepareAttachment: attachment,
      currentRow: async (row) => {
        const fresh = (await records(row.taskId)).rows.find(
          (r) => r.turnId === row.turnId,
        );
        if (!fresh?.eligible) throw Error('记录已不符合当前导出条件');
        return fresh;
      },
    });
    return { status: 'finished', ...counts };
  } finally {
    release();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
