import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  disputedContinuationVersion,
  disputedEvaluationComplete,
} from '../lib/disputed-continuation.mjs';
import {
  seriesPrompt,
  nextCategory,
  projectCounts,
  sessionTurns,
} from '../lib/project-series.mjs';
import { nextDecision } from '../lib/workflow.mjs';
import { questionRules } from '../lib/question-writing.mjs';
import { submittedPolicyEvidence } from './submitted-policy.mjs';
import { assertNativeSessionIdle } from './docker-runtime.mjs';
import {
  reuseRuntimeVerification,
  copyVerificationSource,
} from './runtime-verification.mjs';
import {
  runtimeReviewContext,
  assertRegressionNextDecision,
} from './project-regression-context.mjs';
import { verifyScoreEvidence } from './evidence.mjs';
import { codexStage } from './codex-stages.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Freeze the failed record's code and citations before another Bug changes them.
// There is deliberately no delivery bundle or export archive here.
export function retainDisputedSource({ dir, turn, result }) {
  const base = path.join(dir, `${turn.id}.retained`);
  const manifestPath = path.join(base, 'manifest.json');
  if (existsSync(manifestPath)) {
    const bytes = readFileSync(manifestPath),
      m = JSON.parse(bytes);
    if (
      m.turnId !== turn.id ||
      m.runtimeReportSha256 !==
        result.automation.runtimeVerification.reportSha256
    )
      throw Error('异常记录保全快照与本轮不符');
    for (const f of m.files) {
      const file = path.resolve(base, f.name);
      if (
        !file.startsWith(base + path.sep) ||
        realpathSync(file) !== file ||
        hash(readFileSync(file)) !== f.sha256
      )
        throw Error('异常记录保全文件摘要不符');
    }
    const current = copyVerificationSource(result.workDir).files;
    if (JSON.stringify(current) !== JSON.stringify(m.sourceFiles))
      throw Error('规划期间项目代码已变化');
    return { verified: true, manifestPath, manifestSha256: hash(bytes) };
  }
  verifyScoreEvidence(result.review, result.workDir, dir);
  const source = copyVerificationSource(
    result.workDir,
    path.join(base, 'workspace'),
  );
  const files = source.files.map((f) => ({
    name: 'workspace/' + f.path,
    sha256: f.sha256,
    mode: lstatSync(path.join(result.workDir, f.path)).mode & 0o777,
  }));
  const citations = [];
  for (const group of result.review.evidenceRefs)
    for (const ref of group.split(/[;；\n]/)) {
      const file = realpathSync(
        path.resolve(result.workDir, ref.trim().replace(/:\d+$/, '')),
      );
      const data = readFileSync(file),
        name = `cited/${citations.length}.txt`;
      mkdirSync(path.join(base, 'cited'), { recursive: true });
      writeFileSync(path.join(base, name), data, { mode: 0o600 });
      files.push({ name, sha256: hash(data) });
      citations.push({ ref, name });
    }
  const record = {
    taskId: result.taskId,
    turnId: turn.id,
    prompt: result.preparedPrompt,
    sessionId: result.sessionId,
    promptId: result.promptId,
    review: result.review,
    policy: result.automation.policy,
    submittedPolicyEvidence: result.automation.submittedPolicyEvidence,
    runtimeVerification: result.automation.runtimeVerification,
    delivery: result.automation.delivery,
  };
  const recordBytes = Buffer.from(JSON.stringify(record, null, 2));
  writeFileSync(path.join(base, 'record.json'), recordBytes, { mode: 0o600 });
  files.push({ name: 'record.json', sha256: hash(recordBytes) });
  const omitted = source.omitted.map((name) => {
    const src = path.join(result.workDir, name);
    if (lstatSync(src).isSymbolicLink())
      throw Error('项目存在符号链接，不能生成不完整的续题快照');
    return { name, reason: '版本库内部文件或可重新安装的依赖/缓存' };
  });
  const manifest = {
    format: 1,
    purpose: '异常评测保全与项目续跑，非合格交付包',
    turnId: turn.id,
    runtimeReportSha256: result.automation.runtimeVerification.reportSha256,
    sourceFiles: source.files,
    files,
    citations,
    omitted,
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  writeFileSync(manifestPath, bytes, { mode: 0o600, flag: 'wx' });
  return { verified: true, manifestPath, manifestSha256: hash(bytes) };
}

export async function planDisputedProject({
  task,
  turn,
  previousResult,
  cached,
  dir,
  api,
  containers,
  onChild,
  stage = codexStage,
}) {
  // Even a missing/malformed local receipt must not reach runJob's generic
  // error handler and erase the original record's prompt/score/trace fields.
  let result = structuredClone(turn);
  let a = result.automation || {};
  try {
    previousResult = readDisputedEvaluation(dir, turn.id);
    result = structuredClone(previousResult);
    a = result.automation || {};
    delete a.next;
    delete a.nextError;
    cached ||= JSON.parse(
      readFileSync(path.join(dir, turn.id + '.stages.json'), 'utf8'),
    );
    const current = { ...turn, ...result, id: turn.id, status: 'failed' };
    if (!task.projectSeries || !disputedEvaluationComplete(current))
      throw Error('只有已完成验收、评分和内部数据校验的出题异常可单独续题');
    const context = await api({ action: 'supply-context' });
    if (!context.config.autoContinue) throw Error('自动续题已暂停');
    const evidence = await submittedPolicyEvidence({
      dir,
      turnId: turn.id,
      cached,
      candidate: {
        repoPath: result.workDir,
        title: task.title,
        prompt: result.evaluationPrompt,
        category: result.preparation.category,
        difficulty: result.preparation.difficulty,
      },
    });
    if (
      !evidence ||
      evidence.receipt.nativeExportSha256 !==
        a.submittedPolicyEvidence.receipt.nativeExportSha256
    )
      throw Error('原题异议或轨迹证据不一致');
    const state = containers.load(task.id);
    if (
      state?.sessionId !== result.sessionId ||
      state?.containerId !== result.container.containerId
    )
      throw Error('原会话容器身份已变化');
    assertNativeSessionIdle(state, containers.native(state));
    const runtime = reuseRuntimeVerification(a.runtimeVerification, {
      taskId: task.id,
      turnId: turn.id,
      dir,
      workDir: result.workDir,
      imageId: result.container.imageId,
      prompt: result.evaluationPrompt,
      acceptance: result.preparation.acceptance,
      regressionContext: a.runtimeVerification.regressionContext,
      previousResult,
    });
    if (!runtime) throw Error('既有运行验收、原始日志或当前源码验真失败');
    const sourceSnapshot = retainDisputedSource({ dir, turn, result });
    a.projectContinuation = {
      version: disputedContinuationVersion,
      state: 'ready',
      turnId: turn.id,
      sessionId: result.sessionId,
      promptId: result.promptId,
      runtimeReportSha256: runtime.reportSha256,
      sourceSnapshot,
      reason:
        '本轮题面异常限制该记录交付，已完成交互及内部评测允许按原规则规划后续',
      checkedAt: new Date().toISOString(),
    };
    a.questionRuleVersion = questionRules.version;
    const allocation = nextCategory(task, context.mix) || null;
    await api({
      action: 'stage',
      taskId: task.id,
      turnId: turn.id,
      jobToken: turn.jobToken,
      stage: 'project-next',
    });
    const next = await stage({
      stage: 'project-next',
      dir,
      cwd: result.workDir,
      turnId: `${turn.id}.project-plan-${randomUUID()}`,
      onChild,
      allocation: { category: allocation },
      prompt: `${seriesPrompt(task)}
本次仅规划后续题目。上一轮题面与历史复现操作不符，审核失败保持；当前修复和内部 AI 评测已经完成。旧记录中的禁止自动续题是已修正的编排限制，不是本次规划要求。原题、原评分、审核拒绝和轨迹全部保留，不把出题错误当作 Claude 的错误，不重复发送旧题，也不把异常轮次从会话额度中扣除。
本轮实际题目：${result.preparedPrompt}
本轮审核异议：${JSON.stringify(evidence.postExecutionPolicy.filter((p) => p.disputed).map((p) => p.value.reason))}
项目题额：${JSON.stringify(projectCounts(task))}；本会话已有 ${sessionTurns(task, turn).length} 条逻辑题，最多三条、两轮 Bug 修复、十次实际调用。
已有题目：${JSON.stringify(task.turns.map((r) => ({ id: r.id, category: r.category, prompt: r.requestedPrompt || r.prompt })))}
最新已验真运行报告：${JSON.stringify(runtimeReviewContext(runtime))}
请只读检查实际项目代码和上述原始日志，保留尚未解决的历史缺陷。有 outcome=reproduced 的缺陷且仍有修复额度时，必须优先 action=repair、category=Bug 修复，repairCheckIds 只填本轮报告中实际复现的检查 ID；准确沿用控件、动作、数值和先后顺序，不再把时间点按钮写成滑块。原题修好的部分不要重复出题。修复额度已满而仍有缺陷时 needs_input，不换会话绕过上限。所有检查通过且基础可用后才允许 advance，独立题型按累计比例分配为 ${allocation || '无剩余额度'}，新功能、Feature、理解或重构必须新会话。不得虚称项目完成；结束或等待时 prompt 写无。reason 和 projectEvidence 给出实际文件和日志依据；新题照常通过禁出、难度和口语题面审核。`,
    });
    assertRegressionNextDecision(runtime, next.value);
    a.next = next;
    const updated = { ...current, automation: a };
    nextDecision(
      {
        ...task,
        turns: task.turns.map((r) => (r.id === turn.id ? updated : r)),
      },
      updated,
      context.config,
    );
    // Planning is read-only, and live terminal activity can change during it.
    assertNativeSessionIdle(containers.load(task.id), containers.native(state));
    retainDisputedSource({ dir, turn, result });
    a.projectContinuation.state = 'planned';
    result.error =
      '本轮出题审核异常，原题与评测证据已保留，禁止标准交付；项目已单独完成后续规划';
  } catch (error) {
    delete a.next;
    if (a.projectContinuation) a.projectContinuation.state = 'blocked';
    a.nextError = error.message;
    result.error =
      '本轮出题审核异常，保留原记录；后续规划待处理：' + error.message;
  }
  result.action = 'finish';
  result.taskId = task.id;
  result.turnId = turn.id;
  result.jobToken = turn.jobToken;
  result.success = false;
  result.stage = 'delivery';
  result.automation = a;
  // A single authoritative outbox is shared with ordinary runner recovery.
  // Its acknowledged hash changes after a retry; the original evaluation bytes
  // are kept separately and never scanned as another pending finish message.
  const receipt = path.join(dir, turn.id + '.result.json');
  const temp = receipt + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(result, null, 2), { mode: 0o600 });
  renameSync(temp, receipt);
  return { result, receipt };
}

export function readDisputedEvaluation(dir, turnId) {
  const original = path.join(dir, turnId + '.disputed-evaluation.json');
  if (!existsSync(original)) {
    const bytes = readFileSync(path.join(dir, turnId + '.result.json'));
    writeFileSync(original, bytes, { mode: 0o600, flag: 'wx' });
  }
  return JSON.parse(readFileSync(original, 'utf8'));
}
