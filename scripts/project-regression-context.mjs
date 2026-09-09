import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { questionRoot } from '../lib/question-session.mjs';
import { validateRuntimePlan } from '../lib/runtime-verification.mjs';
import { reuseRuntimeVerification } from './runtime-verification.mjs';

export const projectRegressionVersion = '2026-09-10.regression1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Historical outcomes establish what still needs checking, never the outcome on
// the current product. Read the report's frozen workspace, not today's source.
export function projectRegressionContext(task, turn, { dir, imageId }) {
  const index = task.turns?.findIndex((item) => item.id === turn.id) ?? -1;
  if (!task.id || index < 0) throw Error('项目回归缺少当前任务或轮次');
  const questionRootId = questionRoot(task, turn);
  const history = task.turns
    .slice(0, index)
    .filter((item) => questionRoot(task, item) === questionRootId);
  if (!history.length) return null;
  const taskDir = realpathSync(dir);
  if (path.basename(taskDir) !== task.id)
    throw Error('项目回归历史目录与任务不符');
  const regularFile = (file) => {
    if (
      !lstatSync(file).isFile() ||
      !realpathSync(file).startsWith(taskDir + path.sep)
    )
      throw Error('项目回归证据必须是任务目录内普通文件');
  };
  const pending = new Map();
  for (const previous of history) {
    const report = previous.automation?.runtimeVerification;
    if (!report) throw Error('项目回归缺少前轮验收报告：' + previous.id);
    regularFile(report.reportPath);
    const receiptPath = path.join(taskDir, previous.id + '.result.json');
    let previousResult = null;
    if (existsSync(receiptPath)) {
      regularFile(receiptPath);
      previousResult = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (
        previousResult.taskId !== task.id ||
        previousResult.turnId !== previous.id
      )
        throw Error('项目回归前轮回执与任务不符');
    }
    const preparation = previous.automation?.preparation?.value;
    const sourcePrompt = previous.evaluationPrompt || preparation?.prompt;
    const sourceAcceptance = preparation?.acceptance;
    if (!sourcePrompt || !Array.isArray(sourceAcceptance))
      throw Error('项目回归缺少前轮原始验收输入：' + previous.id);
    const verified = reuseRuntimeVerification(report, {
      taskId: task.id,
      turnId: previous.id,
      dir: taskDir,
      workDir: path.join(path.dirname(report.reportPath), 'workspace'),
      sourceIsSnapshot: true,
      imageId: previous.container?.imageId || imageId,
      prompt: sourcePrompt,
      acceptance: sourceAcceptance,
      regressionContext: report.regressionContext,
      previousResult,
    });
    if (!verified) throw Error('项目回归前轮验收报告验真失败：' + previous.id);
    for (const check of verified.checks) {
      if (check.kind === 'setup') continue;
      if (['passed', 'not_reproduced'].includes(check.outcome)) {
        pending.delete(check.id);
        continue;
      }
      if (check.outcome !== 'reproduced') continue;
      regularFile(check.logPath);
      if (hash(readFileSync(check.logPath)) !== check.logSha256)
        throw Error('项目回归历史复现日志摘要不符：' + check.id);
      const inherited = report.regressionContext?.checks?.find(
        (item) => item.id === check.id,
      );
      pending.set(check.id, {
        id: check.id,
        scope: 'inherited-regression',
        requirement: check.requirement,
        expected: check.expected,
        sourceTurnId: previous.id,
        sourceReportPath: report.reportPath,
        sourceReportSha256: report.reportSha256,
        sourceLogPath: check.logPath,
        sourceLogSha256: check.logSha256,
        observed: check.observed,
        sourcePrompt: inherited?.sourcePrompt || sourcePrompt,
        sourceAcceptance: inherited?.sourceAcceptance || sourceAcceptance,
      });
    }
  }
  if (!pending.size) return null;
  return {
    version: projectRegressionVersion,
    taskId: task.id,
    questionRootId,
    checks: [...pending.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function assertRegressionPlanCoverage(plan, context) {
  validateRuntimePlan(plan);
  if (!context) return plan;
  if (
    context.version !== projectRegressionVersion ||
    !Array.isArray(context.checks) ||
    !context.checks.length ||
    new Set(context.checks.map((check) => check.id)).size !==
      context.checks.length
  )
    throw Error('项目回归上下文格式无效');
  for (const required of context.checks) {
    const check = plan.checks.find((item) => item.id === required.id);
    if (!check || check.kind === 'setup')
      throw Error('独立验收遗漏历史待复核检查：' + required.id);
  }
  const historicalIds = new Set(context.checks.map((check) => check.id));
  if (
    !plan.checks.some(
      (check) => check.kind === 'acceptance' && !historicalIds.has(check.id),
    )
  )
    throw Error('独立验收不能用历史回归代替本题独立 acceptance');
  return plan;
}

export function assertRegressionNextDecision(report, decision) {
  if (!report) throw Error('缺少独立验收报告，不能判断项目后续');
  if (report.regressionContext) {
    assertRegressionPlanCoverage(report.plan?.value, report.regressionContext);
    for (const required of report.regressionContext.checks) {
      const check = report.checks?.find((item) => item.id === required.id);
      if (
        !check ||
        check.kind === 'setup' ||
        !['passed', 'not_reproduced', 'reproduced'].includes(check.outcome)
      )
        throw Error('历史回归尚未完成真实复验：' + required.id);
    }
  }
  if (report.status === 'blocked')
    throw Error('独立验收阻塞，不能判断项目后续');
  if (
    report.checks?.some((check) => check.outcome === 'reproduced') &&
    (['complete', 'advance'].includes(decision?.action) ||
      decision?.baseComplete === true)
  )
    throw Error('当前验收仍复现缺陷，不能完成项目或进入新题');
  return decision;
}

export function regressionScoringInstructions(context) {
  if (!context?.checks?.length) return '';
  return `历史回归检查 ${context.checks.map((check) => check.id).join('、')} 用于确认前序缺陷在当前产物是否仍存在，历史报告只能证明过去发生过，不能当作本轮的新执行结果。这些检查默认属于 inherited-regression，不扩大本轮实际题目、原始验收目标或评分义务。只有本轮题面明确要求修复的部分才纳入本题评分，未要求修复的历史问题不得扣本轮交付完整性、指令遵循或其他维度分数；回归未覆盖或阻塞必须保留待复核状态，不得据此推断项目已完成。`;
}

// The project can still have bugs while this question's requested work passes.
// Use a scoped view for scoring without rewriting the underlying evidence.
export function runtimeReviewContext(report, { scoring = false } = {}) {
  if (!report) return null;
  const scopes = new Map(
    (report.regressionContext?.checks || []).map((check) => [
      check.id,
      check.scope === 'question' ? 'question' : 'inherited-regression',
    ]),
  );
  const scoped = (report.checks || []).map(
    ({
      id,
      kind,
      outcome,
      requirement,
      expected,
      observed,
      codeEvidence,
      logPath,
      logSha256,
      evidenceLine,
      exitCode,
      timedOut,
      limited,
      sourceChanged,
    }) => ({
      id,
      kind,
      outcome,
      requirement,
      expected,
      observed,
      codeEvidence,
      logPath,
      logSha256,
      evidenceLine,
      exitCode,
      timedOut,
      limited,
      sourceChanged,
      scope: scopes.get(id) || 'question',
    }),
  );
  const excludedRegressionCheckIds = scoring
    ? scoped
        .filter((check) => check.scope === 'inherited-regression')
        .map((check) => check.id)
    : [];
  const checks = scoring
    ? scoped.filter((check) => check.scope === 'question')
    : scoped;
  let status = report.status;
  let summary = report.summary;
  if (scoring) {
    const business = checks.filter((check) => check.kind !== 'setup');
    const reproduced = business.filter(
      (check) => check.outcome === 'reproduced',
    ).length;
    const passed = business.filter((check) =>
      ['passed', 'not_reproduced'].includes(check.outcome),
    ).length;
    const blocked = checks.filter(
      (check) =>
        !['passed', 'not_reproduced', 'reproduced'].includes(check.outcome),
    ).length;
    status =
      report.executed !== true || !business.length || blocked
        ? 'blocked'
        : reproduced
          ? 'bugs'
          : 'passed';
    summary =
      report.executed !== true || !business.length
        ? '本题缺少已执行的业务验收，不能判定通过。'
        : `本题执行 ${business.length} 项业务检查，通过 ${passed} 项，复现 ${reproduced} 项；本题验收含 ${blocked} 项阻塞。`;
  }
  return {
    status,
    summary,
    projectStatus: report.status,
    reportPath: report.reportPath,
    reportSha256: report.reportSha256,
    excludedRegressionCheckIds,
    checks,
  };
}
