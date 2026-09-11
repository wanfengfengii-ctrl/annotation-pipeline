import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeSuiteVersion } from '../lib/runtime-suite.mjs';
import { validateRuntimePlan } from '../lib/runtime-verification.mjs';
import { evidencePath } from './evidence.mjs';
import { reuseRuntimeVerification } from './runtime-verification.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
function readBound(file, sha256, dir) {
  const bytes = fs.readFileSync(evidencePath(file, dir));
  if (hash(bytes) !== sha256) throw Error('项目验收库文件摘要不符');
  return bytes;
}
export function readRuntimeSuite(
  receipt,
  { dir, taskId, projectDirectory, imageId },
) {
  const value = JSON.parse(
    readBound(receipt.manifestPath, receipt.manifestSha256, dir),
  );
  if (
    value.version !== runtimeSuiteVersion ||
    value.taskId !== taskId ||
    value.projectDirectory !== projectDirectory ||
    value.imageId !== imageId
  )
    throw Error('项目验收库属于其他项目、目录或镜像');
  const report = JSON.parse(
    readBound(value.reportPath, value.reportSha256, dir),
  );
  if (
    !['passed', 'bugs'].includes(report.status) ||
    report.executed !== true ||
    JSON.stringify(report.plan.value) !== JSON.stringify(value.plan)
  )
    throw Error('项目验收库不能使用未完成或脚本阻塞的验收');
  validateRuntimePlan(value.plan);
  for (const check of value.plan.checks) {
    const script = value.scripts[check.id];
    if (
      !script ||
      readBound(script.path, script.sha256, dir).toString('utf8') !==
        check.command
    )
      throw Error('项目验收脚本与原计划不符');
  }
  return {
    ...value,
    manifestPath: receipt.manifestPath,
    manifestSha256: receipt.manifestSha256,
  };
}

export function saveRuntimeSuite({
  dir,
  taskId,
  turnId,
  projectDirectory = null,
  prompt,
  acceptance,
  report,
}) {
  if (!['passed', 'bugs'].includes(report?.status) || report.executed !== true)
    return null;
  if (
    !validId(taskId) ||
    !validId(turnId) ||
    path.basename(fs.realpathSync(dir)) !== taskId
  )
    throw Error('项目验收库任务身份无效');
  readBound(report.reportPath, report.reportSha256, dir);
  const options = { dir, taskId, projectDirectory, imageId: report.imageId };
  const inherited = report.plan.value.suite;
  const base = inherited
    ? readRuntimeSuite(
        {
          manifestPath: inherited.basePath,
          manifestSha256: inherited.baseSha256,
        },
        options,
      )
    : null;
  const folder = path.join(
    dir,
    'verification-suite',
    turnId + '-' + report.reportSha256.slice(0, 16),
  );
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const scripts = {},
    origins = {},
    sources = { ...base?.sources, [turnId]: { prompt, acceptance } };
  const writeImmutable = (file, bytes) => {
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(Buffer.from(bytes)))
        throw Error('已保存项目验收库不能覆盖');
    } else fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  };
  for (const check of report.plan.value.checks) {
    const file = path.join(folder, check.id + '.sh');
    writeImmutable(file, check.command);
    scripts[check.id] = { path: file, sha256: hash(check.command) };
    // A selected Bug still tests the original requirement; only explicit
    // requirement changes or new checks establish a new requirement source.
    const previous = base?.plan.checks.find((item) => item.id === check.id);
    origins[check.id] =
      previous &&
      previous.requirement === check.requirement &&
      previous.expected === check.expected
        ? base.origins[check.id]
        : turnId;
  }
  const value = {
    version: runtimeSuiteVersion,
    taskId,
    turnId,
    projectDirectory,
    imageId: report.imageId,
    reportPath: report.reportPath,
    reportSha256: report.reportSha256,
    plan: report.plan.value,
    scripts,
    origins,
    sources,
  };
  const manifestPath = path.join(folder, 'manifest.json'),
    bytes = JSON.stringify(value, null, 2);
  writeImmutable(manifestPath, bytes);
  return {
    version: runtimeSuiteVersion,
    manifestPath,
    manifestSha256: hash(bytes),
    checks: value.plan.checks.length,
  };
}

// A project is serial. Pick a completed earlier turn, never a later turn or an
// in-flight attempt. Legacy projects can seed their library from a verified plan.
export function loadProjectRuntimeSuite(
  task,
  turn,
  {
    dir,
    imageId,
    questionCheckIds = [],
    verifyReport = reuseRuntimeVerification,
  },
) {
  const index = task.turns.findIndex((item) => item.id === turn.id);
  if (index < 0) throw Error('项目验收库缺少当前轮次');
  const projectDirectory = task.projectSeries?.directory || null;
  for (const previous of task.turns.slice(0, index).reverse()) {
    const report = previous.automation?.runtimeVerification;
    if (
      previous.excluded ||
      !['passed', 'bugs'].includes(report?.status) ||
      report.imageId !== imageId
    )
      continue;
    const preparation = previous.automation?.preparation?.value;
    const prompt = previous.evaluationPrompt || preparation?.prompt;
    if (!prompt || !Array.isArray(preparation?.acceptance)) continue;
    const receiptPath = path.join(dir, previous.id + '.result.json');
    const previousResult = fs.existsSync(receiptPath)
      ? JSON.parse(fs.readFileSync(evidencePath(receiptPath, dir)))
      : null;
    const verified = verifyReport(report, {
      taskId: task.id,
      turnId: previous.id,
      dir,
      workDir: path.join(path.dirname(report.reportPath), 'workspace'),
      sourceIsSnapshot: true,
      imageId,
      prompt,
      acceptance: preparation.acceptance,
      regressionContext: report.regressionContext,
      previousResult,
    });
    if (!verified) continue;
    const receipt =
      previous.automation?.runtimeSuite ||
      saveRuntimeSuite({
        dir,
        taskId: task.id,
        turnId: previous.id,
        projectDirectory,
        prompt,
        acceptance: preparation.acceptance,
        report: verified,
      });
    const base = readRuntimeSuite(receipt, {
      dir,
      taskId: task.id,
      projectDirectory,
      imageId,
    });
    if (base.reportSha256 !== report.reportSha256)
      throw Error('项目验收库与前轮验收报告不符');
    return {
      ...base,
      category: turn.category,
      prompt: turn.evaluationPrompt || turn.prompt,
      questionCheckIds: questionCheckIds.filter((id) =>
        base.plan.checks.some((check) => check.id === id),
      ),
    };
  }
  return null;
}
