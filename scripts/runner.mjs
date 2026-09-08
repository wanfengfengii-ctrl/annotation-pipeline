import { workflow, scoreInstructions } from '../lib/workflow.mjs';
import {
  verifyScoreEvidence,
  createEvidenceArchive,
  reviewEvidence,
} from './evidence.mjs';
import { acquireLock, journalChild, livingChildren } from './recovery.mjs';
import {
  rules,
  policyInstructions,
  candidateDigest,
  assertPolicyAudit,
} from '../lib/task-policy.mjs';
import { githubSnapshot, githubStatus } from './github-snapshot.mjs';
import { resources, fingerprint, supplyDecision } from './scheduler.mjs';
import { codexStage } from './codex-stages.mjs';
import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  copyFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token =
  process.env.RUNNER_TOKEN ||
  readFileSync(path.join(root, '.dev.vars'), 'utf8').match(
    /^RUNNER_TOKEN=(.+)$/m,
  )?.[1];
const base = process.env.PIPELINE_API_URL || 'http://localhost:3000';
const workRoot = path.resolve(
  process.env.RUNNER_WORK_ROOT || path.join(root, '.runner'),
);
mkdirSync(workRoot, { recursive: true });
const lock = path.join(workRoot, 'runner.lock');
acquireLock(lock);
let stopping = false;
const children = new Set();
function track(p) {
  if (!p) return;
  children.add(p);
  p.once('close', () => children.delete(p));
  if (stopping) p.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    for (const p of children) p.kill('SIGTERM');
    const hard = setTimeout(() => {
      for (const p of children) p.kill('SIGKILL');
    }, 10000);
    hard.unref();
  });
process.on('exit', () => {
  try {
    unlinkSync(lock);
  } catch {}
});
const command = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  }).trim();
const version = command('claude', ['--version'], root);
const codexVersion = command('codex', ['--version'], root);
let github = githubStatus(),
  githubChecked = Date.now();
async function api(body) {
  const r = await fetch(base + '/api/runner', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
let schedulerStatus = {};
const beat = () =>
  api({
    action: 'heartbeat',
    version,
    codexVersion,
    scheduler: schedulerStatus,
    github,
  });
const heartbeat = setInterval(() => beat().catch(() => {}), 10000);
function transcript(sessionId, prompt) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return {};
  for (const name of readdirSync(projects)) {
    const p = path.join(projects, name, `${sessionId}.jsonl`);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    for (const line of lines.reverse()) {
      try {
        const j = JSON.parse(line);
        const content = j.message?.content;
        const txt =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((x) => x.type === 'text')
                  .map((x) => x.text)
                  .join('')
              : '';
        if (j.type === 'user' && txt === prompt && j.uuid)
          return { promptId: j.uuid, nativeTrace: p };
      } catch {}
    }
  }
  return {};
}
async function executeClaude({ task, turn, onChild = track }) {
  const dir = path.join(workRoot, task.id);
  mkdirSync(dir, { recursive: true });
  const tracePath = path.join(dir, (turn.traceKey || turn.id) + '.jsonl');
  const stderrPath = path.join(dir, (turn.traceKey || turn.id) + '.stderr.log');
  const result = {
    action: 'finish',
    taskId: task.id,
    turnId: turn.id,
    jobToken: turn.jobToken,
    success: false,
    tracePath,
    output: '',
    error: '',
    harnessVersion: version,
    os: `${os.platform()} ${os.release()}`,
    workDir: task.workDir || path.join(dir, 'workspace'),
    snapshot: task.snapshot,
    githubSnapshot: task.githubSnapshot,
    sessionId: task.sessionId || randomUUID(),
  };
  try {
    if (!task.workDir) {
      const repo = task.repoPath;
      const evidence = githubSnapshot(repo, {
        expectedSha: task.githubSnapshot?.sha,
      });
      result.snapshot = evidence.url;
      result.githubSnapshot = evidence;
      const head = evidence.sha;
      command(
        'git',
        ['worktree', 'add', '--detach', result.workDir, head],
        repo,
      );
      const localSettings = path.join(repo, '.claude', 'settings.local.json');
      if (existsSync(localSettings)) {
        mkdirSync(path.join(result.workDir, '.claude'), { recursive: true });
        copyFileSync(
          localSettings,
          path.join(result.workDir, '.claude', 'settings.local.json'),
        );
      }
    }
    const args = [
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      ...(task.sessionId
        ? ['--resume', task.sessionId]
        : ['--session-id', result.sessionId]),
    ];
    // No --model / --settings / permission override: honor the installed CLI configuration.
    const requestedId = randomUUID();
    writeFileSync(tracePath, '');
    writeFileSync(stderrPath, '');
    const outFd = openSync(tracePath, 'a'),
      errFd = openSync(stderrPath, 'a');
    let buffer = '',
      final = null;
    await new Promise((resolve, reject) => {
      const child = spawn('claude', args, {
        cwd: result.workDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      onChild(child);
      let hardLimit;
      const limit = setTimeout(
        () => {
          child?.kill('SIGTERM');
          hardLimit = setTimeout(() => child?.kill('SIGKILL'), 10000);
        },
        Number(process.env.RUNNER_TIMEOUT_MS || 1800000),
      );
      child.stdout.on('data', (chunk) => {
        writeFileSync(outFd, chunk);
        buffer += chunk.toString();
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          try {
            const e = JSON.parse(line);
            if (e.type === 'system' && e.subtype === 'init') {
              result.model = e.model;
              result.sessionId = e.session_id || result.sessionId;
            }
            if (e.type === 'result') final = e;
            if (
              e.type === 'user' &&
              e.uuid &&
              (e.message?.content === turn.prompt ||
                JSON.stringify(e.message?.content).includes(
                  JSON.stringify(turn.prompt),
                ))
            )
              result.promptId = e.uuid;
          } catch {}
        }
      });
      child.stderr.on('data', (chunk) => writeFileSync(errFd, chunk));
      child.on('error', (e) => {
        clearTimeout(limit);
        reject(e);
      });
      child.on('close', (code, signal) => {
        clearTimeout(limit);
        clearTimeout(hardLimit);
        closeSync(outFd);
        closeSync(errFd);
        if (!final || code !== 0 || final.is_error) {
          result.error =
            final?.errors?.join('\n') ||
            final?.result ||
            `Claude CLI 未正常完成（退出码 ${code}，信号 ${signal || '无'}）。查看 ${stderrPath}`;
        }
        result.output = final?.result || '';
        result.executionOutcome =
          final?.subtype === 'error_max_turns'
            ? 'truncated'
            : final?.is_error
              ? 'error'
              : 'complete';
        result.success =
          Boolean(final) &&
          ((code === 0 && !final.is_error) ||
            final.subtype === 'error_max_turns');
        resolve();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(
        JSON.stringify({
          type: 'user',
          uuid: requestedId,
          session_id: result.sessionId,
          message: { role: 'user', content: turn.prompt },
          parent_tool_use_id: null,
        }) + '\n',
      );
    });
    const native = transcript(result.sessionId, turn.prompt);
    if (native.promptId) {
      result.promptId = native.promptId;
      copyFileSync(
        native.nativeTrace,
        path.join(dir, turn.id + '.native.jsonl'),
      );
    }
  } catch (e) {
    result.error = e.message;
    result.success = false;
    if (!existsSync(result.workDir)) delete result.workDir;
    if (!existsSync(tracePath)) writeFileSync(tracePath, '');
    if (!task.sessionId && !result.output && !result.promptId)
      delete result.sessionId;
  }
  result.finishedAt = new Date().toISOString();
  return result;
}
async function execute({ task, turn }) {
  const dir = path.join(workRoot, task.id);
  mkdirSync(dir, { recursive: true });
  const cachePath = path.join(dir, turn.id + '.stages.json');
  const cached = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf8'))
    : {};
  const persist = () =>
    writeFileSync(cachePath, JSON.stringify(cached, null, 2), { mode: 0o600 });
  if (cached.workflowVersion !== workflow.version) {
    delete cached.score;
    delete cached.delivery;
    delete cached.next;
  }
  cached.workflowVersion = workflow.version;
  cached.attempt = (cached.attempt || 0) + 1;
  persist();
  const automation = { workflowVersion: workflow.version };
  const journal = path.join(dir, turn.id + '.job.json');
  const onChild = (p) => {
    track(p);
    if (p) journalChild(journal, p);
  };
  let stage = 'prepare';
  let result = {
    action: 'finish',
    taskId: task.id,
    turnId: turn.id,
    jobToken: turn.jobToken,
    success: false,
    automation,
  };
  async function step(name, prompt, cwd) {
    if (stopping) throw Error('执行器正在停止');
    stage = name;
    await api({
      action: 'stage',
      taskId: task.id,
      turnId: turn.id,
      jobToken: turn.jobToken,
      stage: name,
    });
    if (cached[name] && name !== 'policy' && name !== 'snapshot')
      return cached[name];
    const value = await codexStage({
      stage: name,
      prompt,
      cwd,
      dir,
      turnId: turn.id + '.attempt-' + (cached.attempt || 1),
      onChild,
    });
    return value;
  }
  try {
    if (
      task.sessionId &&
      task.os &&
      task.os !== `${os.platform()} ${os.release()}`
    )
      throw Error('操作系统环境发生变化，请新建会话');
    if (
      task.sessionId &&
      task.harnessVersion &&
      task.harnessVersion !== version
    )
      throw Error(
        'Claude CLI 版本已变化，请新建会话，不能混用同一会话的运行环境',
      );
    const index = task.turns.findIndex((r) => r.id === turn.id);
    const previousTurns = task.turns
      .slice(0, Math.max(0, index))
      .filter((r) => !r.excluded && ['review', 'submitted'].includes(r.status));
    const firstTurn = previousTurns.length === 0;
    const previousTurn = previousTurns.at(-1);
    const allowFollowupFix = !!(
      task.workDir &&
      existsSync(task.workDir) &&
      previousTurn?.tracePath &&
      existsSync(previousTurn.tracePath) &&
      previousTurn?.output
    );
    const roundContext = JSON.stringify({
      firstTurn,
      allowFollowupFix,
      previousGoal: previousTurn?.prompt,
      previousGoals: previousTurns.map((r) => ({
        requestedGoal: r.requestedPrompt,
        preparedGoal: r.prompt.slice(0, 4000),
      })),
      previousTrace: previousTurn?.tracePath,
      previousOutput: previousTurn?.output?.slice(0, 8000),
      currentGoal: turn.requestedPrompt || turn.prompt,
    });
    const preparation = await step(
      'prepare',
      `用户任务目标：${turn.requestedPrompt || turn.prompt}\n请读取当前仓库，准备交给 Claude 的完整任务 Prompt、分类、难度、技术栈和验收条件。保留用户约束，不擅自增加业务需求。${firstTurn ? '这是首轮，禁止简单题。' : '这是后续轮次，须结合前序目标与产物判断。'}\n轮次上下文：${roundContext}\n这是 AI 自动评测任务，不得声称是人工标注。\n${policyInstructions()}`,
      task.workDir || task.repoPath,
    );
    cached.prepare = preparation;
    persist();
    automation.preparation = preparation;
    result.preparedPrompt = preparation.value.prompt;
    result.preparation = preparation.value;
    const candidate = {
      repoPath: task.repoPath,
      title: task.title,
      prompt: preparation.value.prompt,
      category: preparation.value.category,
      difficulty: preparation.value.difficulty,
    };
    const context = await api({ action: 'supply-context' });
    const history = context.history
      .filter((t) => t.id !== task.id)
      .slice(0, 200);
    const audit = await step(
      'policy',
      `${policyInstructions()}\n轮次上下文：${roundContext}\n独立审核用户原目标与准备后的实际任务，两个都必须合规。若当前输入仅为继续或续写，必须根据前序原始目标判断。用户原目标：${turn.requestedPrompt || turn.prompt}\n候选题：${JSON.stringify(candidate)}\n跨仓库历史题目：${JSON.stringify(history)}\n逐类检查并在 checkedGroups 返回所有组 ID。allowed 只有无禁出项、无实质雷同且难度合格时才为 true。matchedRuleIds 使用组 ID 或 general；duplicateTaskIds 使用实际历史 ID。reason 给出实质判断依据。`,
      task.workDir || task.repoPath,
    );
    audit.proposedDifficulty = candidate.difficulty;
    candidate.difficulty = audit.value.assessedDifficulty;
    preparation.value.difficulty = audit.value.assessedDifficulty;
    audit.roundContext = {
      firstTurn,
      allowFollowupFix,
      previousTurnId: previousTurn?.id,
    };
    audit.ruleVersion = rules.version;
    audit.candidateDigest = await candidateDigest(candidate);
    automation.policy = audit;
    assertPolicyAudit(audit, audit.candidateDigest, {
      firstTurn,
      allowFollowupFix,
    });
    cached.policy = audit;
    persist();
    const snap = await step(
      'snapshot',
      `只读检查此仓库的 Git 环境。读取 HEAD 完整 SHA 和 origin URL、工作区状态、依赖与可复现性。不得修改、提交或推送。${task.workDir ? '这是后续轮次，允许模型已有改动；初始快照必须继续引用 ' + task.snapshot : '这是首轮，若工作区不干净或缺少 GitHub origin，请返回 ready=false。'} 返回实际 head、remote 和检查说明。\n环境等级只能是：${workflow.environmentLevels.join('；')}。根据真实依赖、配置与启动文件判断，列出 dependencies、startup 和 verification；只读检查未实际运行时必须说明未运行，不能仅因为有 Dockerfile 就声称可一键复现。`,
      task.workDir || task.repoPath,
    );
    if (!snap.value.ready)
      throw new Error('Codex 环境检查未通过：' + snap.value.notes.join('；'));
    if (
      !task.workDir &&
      snap.value.head !== command('git', ['rev-parse', 'HEAD'], task.repoPath)
    )
      throw new Error('Codex 检查的 HEAD 与仓库不一致');
    const githubEvidence = githubSnapshot(task.workDir || task.repoPath, {
      expectedSha: snap.value.head,
      existingSnapshot: task.workDir ? task.snapshot : undefined,
    });
    result.reproducibility = task.snapshot
      ? task.reproducibility
      : snap.value.environmentLevel;
    result.githubSnapshot = githubEvidence;
    result.snapshot = githubEvidence.url;
    task = { ...task, githubSnapshot: githubEvidence };
    writeFileSync(
      path.join(dir, turn.id + '.github-snapshot.json'),
      JSON.stringify(githubEvidence, null, 2),
    );
    cached.snapshot = snap;
    persist();
    automation.snapshot = snap;
    stage = 'claude';
    await api({
      action: 'stage',
      taskId: task.id,
      turnId: turn.id,
      jobToken: turn.jobToken,
      stage,
    });
    if (stopping) throw Error('执行器正在停止');
    if (!cached.claude?.success) {
      const previous = cached.claude || {};
      cached.claude = await executeClaude({
        onChild,
        task: {
          ...task,
          ...(previous.workDir
            ? {
                workDir: previous.workDir,
                snapshot: previous.snapshot,
                sessionId: previous.sessionId,
              }
            : {}),
        },
        turn: {
          ...turn,
          traceKey: turn.id + '.attempt-' + (cached.attempt || 1),
          prompt: preparation.value.prompt,
        },
      });
      persist();
    }
    result = {
      ...result,
      ...cached.claude,
      githubSnapshot: githubEvidence,
      jobToken: turn.jobToken,
      automation,
    };
    if (!result.success) throw new Error(result.error || 'Claude 执行失败');
    const score = await step(
      'score',
      ` ${scoreInstructions()}\n你是 Codex 自动评分器。只读分析当前产物和本轮原始轨迹。\n任务：${preparation.value.prompt}\n验收条件：${JSON.stringify(preparation.value.acceptance)}\n本轮轨迹文件：${result.tracePath}\n初始快照：${result.snapshot}\n请用 git diff 和实际文件核对结果。按交付完整性、指令遵循、任务规划、推理能力、执行能力依次评分 1–5，并为每项提供具体步骤、文件或工具调用的证据和影响。不要修改、修复产物或编造测试；没有执行的测试不能声称通过。评分来源必须为 AI。other 无其他问题时写“无”。`,
      result.workDir,
    );
    try {
      score.value = verifyScoreEvidence(score.value, result.workDir, dir);
    } catch (e) {
      delete cached.score;
      delete cached.delivery;
      persist();
      throw e;
    }
    cached.score = score;
    persist();
    automation.score = score;
    result.review = {
      ...score.value,
      source: 'codex',
      attested: false,
      reviewer: 'Codex CLI（AI）',
    };
    if (task.sessionId && result.sessionId !== task.sessionId)
      throw Error('Claude 返回的 SessionID 与原会话不一致');
    if (
      task.turns.some(
        (r) =>
          r.id !== turn.id &&
          !r.excluded &&
          r.promptId &&
          r.promptId === result.promptId,
      )
    )
      throw Error('本轮 PromptID 与历史轮次重复，请检查原始轨迹');
    if (
      !result.promptId ||
      !result.sessionId ||
      !result.tracePath ||
      !existsSync(result.tracePath) ||
      !/^https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]{40}$/i.test(
        result.snapshot || '',
      )
    )
      throw new Error(
        '自动交付缺少真实会话、轮次、轨迹或完整快照，不能生成合格交付包',
      );
    const delivery = await step(
      'delivery',
      `对以下 AI 评测数据做交付校验：${JSON.stringify({ snapshot: result.snapshot, sessionId: result.sessionId, promptId: result.promptId, tracePath: result.tracePath, prompt: preparation.value.prompt, review: result.review, processFindings: score.value.processFindings, artifactFindings: score.value.artifactFindings })}\n逐项核对 When/What/Impact/正确做法、过程与产物证据、模型归因和分数分档一致性；检查五维分数与证据是否一致、是否具体可追溯、是否存在虚假成功。基于实际轨迹与代码。passed 只代表内部 AI 评测数据是否完整一致，不能声称满足原项目人工标注规则。不要向腾讯文档或其他平台提交；返回校验清单和结论。`,
      result.workDir,
    );
    automation.delivery = delivery;
    if (!delivery.value.passed)
      throw new Error('Codex 交付校验未通过：' + delivery.value.summary);
    cached.delivery = delivery;
    persist();
    if (
      context.config.autoContinue &&
      task.turns.filter((r) => !r.excluded).length < 10
    ) {
      const next = await step(
        'next',
        `只读判断是否需要下一轮。会话最初目标：${task.turns[0]?.requestedPrompt || task.turns[0]?.prompt}\n本轮原始目标：${turn.requestedPrompt || turn.prompt}\n完整任务：${preparation.value.prompt}\n轨迹：${result.tracePath}\n产物目录：${result.workDir}\n本轮评价：${JSON.stringify(result.review)}\n执行结果类型：${result.executionOutcome || 'complete'}\n仅对本题未完成部分或已发现 Bug 提出具体修复，不增加无关功能。需要用户凭据、付费、外部访问或关键决策时 needs_input。完成时 complete；截断未完成时 continue；已证实产物问题时 repair。prompt 必须是可执行的下一轮完整指令，complete/needs_input 时写“无”。reason 给出实际依据。每个会话最多 10 轮，每轮独立评分。`,
        result.workDir,
      );
      if (
        result.executionOutcome === 'truncated' &&
        next.value.action === 'complete'
      )
        throw Error('截断轮次不能直接判定为完整结束');
      cached.next = next;
      persist();
      automation.next = next;
    }
    const bundlePath = path.join(dir, turn.id + '.ai-delivery.json');
    automation.bundlePath = bundlePath;
    writeFileSync(
      bundlePath,
      JSON.stringify(
        {
          provenance: 'AI-generated / Codex CLI',
          usage: '内部 AI 评测数据，不作为原项目人工标注',
          taskId: task.id,
          turnId: turn.id,
          prompt: preparation.value.prompt,
          snapshot: result.snapshot,
          githubSnapshot: result.githubSnapshot,
          policyAudit: automation.policy,
          sessionId: result.sessionId,
          promptId: result.promptId,
          tracePath: result.tracePath,
          review: result.review,
          validation: delivery.value,
          stages: automation,
        },
        null,
        2,
      ),
    );
    automation.archive = createEvidenceArchive({
      dir,
      turnId: turn.id,
      bundlePath,
      tracePath: result.tracePath,
      automation,
      workDir: result.workDir,
    });
    try {
      result.evidence = reviewEvidence({
        dir,
        turnId: turn.id,
        tracePath: result.tracePath,
      });
    } catch (e) {
      result.evidence = [
        {
          id: 'notice',
          label: '页面证据预览',
          content: '预览整理失败，请从本机归档核对：' + e.message,
        },
      ];
    }
    result.success = true;
    result.error = '';
  } catch (e) {
    result.success = false;
    result.error = e.message;
  }
  result.stage = stage;
  result.automation = automation;
  const receipt = path.join(dir, turn.id + '.result.json');
  writeFileSync(receipt, JSON.stringify(result, null, 2), { mode: 0o600 });
  return { result, receipt };
}

async function deliver(result, receipt) {
  await api(result);
  writeFileSync(
    receipt + '.delivered',
    createHash('sha256').update(readFileSync(receipt)).digest('hex'),
  );
}
console.log(
  `Codex 编排 / Claude 执行器就绪 · ${version} · ${base} · 使用 CLI 配置模型`,
);
try {
  for (const taskDir of readdirSync(workRoot)) {
    const p = path.join(workRoot, taskDir);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    for (const name of readdirSync(p).filter((x) =>
      x.endsWith('.result.json'),
    )) {
      const receipt = path.join(p, name);
      if (
        !existsSync(receipt + '.delivered') ||
        readFileSync(receipt + '.delivered', 'utf8') !==
          createHash('sha256').update(readFileSync(receipt)).digest('hex')
      )
        await deliver(JSON.parse(readFileSync(receipt, 'utf8')), receipt);
    }
  }
  const orphans = [];
  for (const name of readdirSync(workRoot)) {
    const dir = path.join(workRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((f) =>
      f.endsWith('.job.json'),
    )) {
      const journal = path.join(dir, file);
      if (!existsSync(journal + '.done')) orphans.push(journal);
    }
  }
  async function recoverOrphans() {
    for (const journal of [...orphans]) {
      const j = JSON.parse(readFileSync(journal, 'utf8'));
      const live = livingChildren(j).length > 0;
      const cachePath = journal.replace('.job.json', '.stages.json');
      const cache = existsSync(cachePath)
        ? JSON.parse(readFileSync(cachePath, 'utf8'))
        : {};
      const r = await api({
        action: 'recover',
        ...j,
        live,
        salvage: cache.claude || null,
      });
      if (!live || r.done) {
        writeFileSync(journal + '.done', '1');
        orphans.splice(orphans.indexOf(journal), 1);
      }
    }
  }
  await recoverOrphans();
  const active = new Map();
  const supplyDir = path.join(workRoot, 'supply');
  mkdirSync(supplyDir, { recursive: true });
  const statePath = path.join(supplyDir, 'state.json');
  const supplyState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : {};
  let generating = null;
  const saveSupply = () =>
    writeFileSync(statePath, JSON.stringify(supplyState), { mode: 0o600 });
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  async function runJob(job) {
    console.log(`开始：${job.task.title} / ${job.turn.id}`);
    const jobDir = path.join(workRoot, job.task.id);
    mkdirSync(jobDir, { recursive: true });
    const journal = path.join(jobDir, job.turn.id + '.job.json');
    writeFileSync(
      journal,
      JSON.stringify({
        taskId: job.task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        children: [],
      }),
      { mode: 0o600 },
    );
    let outcome;
    try {
      outcome = await execute(job);
    } catch (e) {
      const result = {
        action: 'finish',
        taskId: job.task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        success: false,
        error: '执行器异常：' + e.message,
      };
      const receipt = path.join(jobDir, job.turn.id + '.result.json');
      writeFileSync(receipt, JSON.stringify(result), { mode: 0o600 });
      outcome = { result, receipt };
    }
    const { result, receipt } = outcome;
    do {
      try {
        await deliver(result, receipt);
        writeFileSync(journal + '.done', '1');
        break;
      } catch (e) {
        console.error('回写失败，将重试：' + e.message);
        if (stopping) break;
        await nap(5000);
      }
    } while (!stopping);
    console.log(
      result.success
        ? '该轮已完成 Codex 评分与交付校验'
        : '该轮异常：' + result.error,
    );
  }
  async function replenish(context) {
    try {
      // Reuse an undelivered generation across a network failure or restart.
      let payload = supplyState.pending;
      if (!payload) {
        const index = (supplyState.cursor || 0) % context.repos.length;
        const repoPath = context.repos[index];
        supplyState.cursor = index + 1;
        saveSupply();
        const history = context.history.slice(0, 200);
        const generated = await codexStage({
          stage: 'generate',
          cwd: repoPath,
          dir: supplyDir,
          turnId: randomUUID(),
          onChild: track,
          prompt: `只读分析当前仓库，为 Claude 生成一个独立、可验证的工程任务。出题范围：${context.config.scope}\n今日已完成及排队题型分布：${JSON.stringify(context.mix)}。优先补充建议题型 ${context.mix?.suggested || '按实际需要'}，但必须按真实需求分类，不改标签凑比例。\n${policyInstructions()}\n不要重复或改写已有题目：${JSON.stringify(history)}\n禁止依赖其他自动任务的改动。不要提出需要外部付费、发布、推送或外部消息的任务。不执行此任务，只返回具体任务目标和验收要求。title 最多 200 字、prompt 最多 20000 字、stack 最多 300 字。`,
        });
        if (
          history.some(
            (t) =>
              fingerprint(repoPath, t.title) ===
              fingerprint(repoPath, generated.value.title),
          )
        )
          throw Error('Codex 生成了重复标题');
        payload = {
          action: 'enqueue-auto',
          repoPath,
          ...generated.value,
          tracePath: generated.tracePath,
          fingerprint: fingerprint(repoPath, generated.value.prompt),
        };
        const audit = await codexStage({
          stage: 'policy',
          cwd: repoPath,
          dir: supplyDir,
          turnId: randomUUID(),
          onChild: track,
          prompt: `${policyInstructions()}\n这是首轮自动新任务，没有后续简单修复例外。独立审核候选题：${JSON.stringify(generated.value)}\n全仓库最近历史：${JSON.stringify(history)}\n逐类检查并在 checkedGroups 返回所有组 ID。只有核心功能不落入禁出范围、无实质雷同且难度合格时 allowed=true。matchedRuleIds 和 duplicateTaskIds 必须与结论一致；reason 给出依据。`,
        });
        audit.proposedDifficulty = payload.difficulty;
        payload.difficulty = audit.value.assessedDifficulty;
        audit.ruleVersion = rules.version;
        audit.candidateDigest = await candidateDigest(payload);
        // Persist rejections too, so the UI can explain why nothing was enqueued.
        supplyState.lastAudit = audit;
        saveSupply();
        assertPolicyAudit(audit, audit.candidateDigest);
        payload.policyAudit = audit;
        supplyState.pending = payload;
        saveSupply();
      }
      if (stopping) return;
      if (payload.policyAudit?.ruleVersion !== rules.version) {
        delete supplyState.pending;
        saveSupply();
        throw Error('出题规则已更新，将重新生成并审核');
      }
      const res = await api(payload);
      delete supplyState.pending;
      supplyState.failures = 0;
      supplyState.lastError = '';
      supplyState.nextAt = Date.now() + 60000;
      supplyState.lastResult =
        res.skipped ||
        (res.duplicate ? '重复任务已跳过' : '已自动补充一个任务');
      saveSupply();
    } catch (e) {
      supplyState.failures = (supplyState.failures || 0) + 1;
      supplyState.lastError = e.message;
      supplyState.nextAt =
        Date.now() +
        Math.min(3600000, 300000 * 2 ** Math.min(4, supplyState.failures - 1));
      saveSupply();
      console.error('自动补充失败：' + e.message);
    }
  }
  while (!stopping) {
    try {
      if (orphans.length) await recoverOrphans();
      const context = await api({ action: 'supply-context' });
      if (Date.now() - githubChecked > 300000) {
        github = githubStatus();
        githubChecked = Date.now();
      }
      const resource = resources(context.config.concurrency);
      schedulerStatus = {
        ...resource,
        active: active.size,
        recovering: orphans.length,
        generating: !!generating,
        configured: context.config.concurrency,
        enabled: context.config.enabled,
        generatedToday: context.generatedToday,
        dailyLimit: context.config.dailyLimit,
        repoCount: context.repos.length,
        workflowVersion: workflow.version,
        mix: context.mix,
        ruleVersion: rules.version,
        lastAudit: supplyState.lastAudit
          ? {
              allowed: supplyState.lastAudit.accepted === true,
              reason:
                supplyState.lastAudit.rejection ||
                supplyState.lastAudit.value.reason,
            }
          : null,
        supply: generating
          ? 'Codex 正在生成任务'
          : supplyDecision(context, supplyState) ||
            supplyState.lastResult ||
            '等待补充',
        nextAt: supplyState.nextAt || null,
      };
      await beat();
      // Claims are sequential; executions are independent. Generation consumes one slot too.
      while (
        !stopping &&
        active.size + orphans.length + Number(!!generating) < resource.effective
      ) {
        const { job } = await api({
          action: 'claim',
          capacity: resource.effective - Number(!!generating) - orphans.length,
        });
        if (!job) break;
        const promise = runJob(job)
          .catch((e) => console.error(e.message))
          .finally(() => active.delete(job.task.id));
        active.set(job.task.id, promise);
      }
      if (
        !stopping &&
        !generating &&
        active.size + orphans.length < resource.effective &&
        !supplyDecision(context, supplyState)
      ) {
        generating = replenish(context).finally(() => {
          generating = null;
        });
      }
      await nap(2500);
    } catch (e) {
      console.error(e.message);
      await nap(5000);
    }
  }
  await Promise.allSettled([
    ...active.values(),
    ...(generating ? [generating] : []),
  ]);
} finally {
  clearInterval(heartbeat);
}
