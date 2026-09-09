import { installScaffold } from './project-scaffold.mjs';
import { continuationContext } from '../lib/round-context.mjs';
import {
  seriesVersion,
  seriesPrompt,
  nextCategory,
  canAddTurn,
  sessionTurns,
  projectCounts,
} from '../lib/project-series.mjs';
import { workflow, scoreInstructions, nextDecision } from '../lib/workflow.mjs';
import { questionIssues } from '../lib/writing-style.mjs';
import { questionRules } from '../lib/question-writing.mjs';
import { questionCacheState } from '../lib/question-cache.mjs';
import { resumeInitialSnapshot } from '../lib/snapshot-resume.mjs';
import { harnessInstructions } from '../lib/harness.mjs';
import { DockerRuntime, dockerStatus } from './docker-runtime.mjs';
import { permissionIssues } from '../lib/permission-audit.mjs';
import {
  containerCapacity,
  validDockerSnapshot,
} from '../lib/container-policy.mjs';
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
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
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
const version = 'Claude Code · Mac Terminal 交互作业';
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
const containers = new DockerRuntime(
  workRoot,
  (container) =>
    api({ action: 'container', taskId: container.taskId, container }),
  () => stopping,
);
async function executeClaude({ task, turn }) {
  try {
    return await containers.execute(task, turn, (attemptId, sessionId) =>
      api({
        action: 'reserve-claude',
        taskId: task.id,
        turnId: turn.id,
        jobToken: turn.jobToken,
        attemptId,
        sessionId,
      }),
    );
  } catch (e) {
    const s = containers.load(task.id);
    return {
      success: false,
      error: e.message,
      ...(s
        ? {
            container: containers.public(s),
            workDir: s.workDir,
            snapshot: s.snapshot,
          }
        : {}),
    };
  }
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
  // A Terminal interaction can outlive its runner. Preserve the exact submitted
  // prompt on upgrade/reconnect even before Claude has produced a final result.
  const { preserveQuestion, questionStyleApplies } = questionCacheState(
    cached,
    containers.load(task.id)?.pending,
    turn.id,
  );
  if (cached.workflowVersion !== workflow.version) {
    if (!preserveQuestion) delete cached.prepare;
    delete cached.score;
    delete cached.delivery;
    delete cached.next;
  }
  cached.workflowVersion = workflow.version;
  cached.attempt = (cached.attempt || 0) + 1;
  persist();
  let automation = {
    workflowVersion: workflow.version,
    questionRuleVersion: questionRules.version,
  };
  let preparation = cached.prepare;
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
  async function step(name, prompt, cwd, extra = {}) {
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
      ...extra,
      stage: name,
      prompt,
      cwd,
      dir,
      turnId: turn.id + '.attempt-' + (cached.attempt || 1),
      onChild,
    });
    return value;
  }
  async function planFollowup() {
    if (!canAddTurn(task) && sessionTurns(task, turn).length >= 3) {
      delete automation.nextError;
      return;
    }
    const context = await api({ action: 'supply-context' });
    delete automation.nextError;
    if (turn.planRetry && !context.config.autoContinue)
      throw Error('请先开启自动续跑，再重试后续出题');
    if (result.executionOutcome === 'truncated') {
      automation.next = {
        value: {
          action: 'needs_input',
          prompt: '无',
          reason: '本轮截断，只有真实 Bug 修复允许同会话追问，已保留当前记录',
        },
      };
      return;
    }
    if (context.config.autoContinue && task.projectSeries) {
      const allocatedCategory = nextCategory(task, context.mix) || null;
      const next = await step(
        'project-next',
        `${seriesPrompt(task)}
当前项目题额 ${JSON.stringify(projectCounts(task))}，当前会话已记录 ${sessionTurns(task, turn).length} 条对话，最多三条；当天全局分布（已完成及在途）：${JSON.stringify(context.mix)}。初始项目目标：${task.turns[0]?.requestedPrompt || task.turns[0]?.prompt}
项目路径：${task.projectSeries.directory}
本轮实际 Prompt：${preparation.value.prompt}
本轮原始验收目标：${result.evaluationPrompt}
本轮产物轨迹：${result.tracePath}
本轮评分：${JSON.stringify(result.review)}
已有题目（禁止实质重复）：${JSON.stringify(task.turns.map((r) => ({ category: r.category, prompt: r.requestedPrompt || r.prompt })))}
读取真实项目目录和测试/错误轨迹，有具体缺陷且当前会话未达到两轮修复时才 action=repair、category=Bug 修复，这会在当前终端追问。不能把未完成的新功能或截断续写改叫 Bug，不生成 action=continue。基础可用后 action=advance，独立新题必须使用已按比例分配的 ${allocatedCategory || '无新题额度，应结束项目'} 类别，不能自行切换类别；新建此前不存在的功能算 0-1，修改已有能力算 Feature。同项目这两类各最多十题。理解与重构按 7:7:10:1:1 的累计目标选择。projectEvidence 写实际文件、现象和新功能与现有功能的边界；baseComplete 反映实际状态。修复达到两轮仍未解决时 needs_input，不换新窗口规避修复上限；所有任务充分覆盖或题额用完时 complete。prompt 以项目名称开头，不加编号，按项目名称、180 至 260 字正文和 1 至 2 个自然段输出。修复说明真实现象与预期，迭代说明已有能力与本次变化，不使用模板或编造人工检查经历。结束时 prompt 写无。`,
        result.workDir,
        { allocation: { category: allocatedCategory } },
      );
      cached.next = next;
      persist();
      automation.next = next;
    } else if (
      context.config.autoContinue &&
      sessionTurns(task, turn).length < 3
    ) {
      const next = await step(
        'next',
        `只读判断是否需要下一轮。会话最初目标：${task.turns[0]?.requestedPrompt || task.turns[0]?.prompt}\n本轮原始目标：${turn.requestedPrompt || turn.prompt}\n完整验收任务：${result.evaluationPrompt}\n轨迹：${result.tracePath}\n产物目录：${result.workDir}\n本轮评价：${JSON.stringify(result.review)}\n执行结果类型：${result.executionOutcome || 'complete'}\n仅对本题未完成部分或已发现 Bug 提出具体修复，不增加无关功能。需要用户凭据、付费、外部访问或关键决策时 needs_input。完成时 complete；截断未完成时 needs_input；已证实产物问题且本会话未到两轮修复时 repair。prompt 必须是可执行的下一轮完整指令，complete/needs_input 时写“无”。reason 给出实际依据。每个会话最多初始题加两轮 Bug 修复，共三条对话，累计调用最多十次。Bug prompt 不加编号，同样按项目名称和 180 至 260 字的 1 至 2 段正文输出，围绕现有网页流程说明具体问题及预期，不增加无关功能，不允许只写继续。`,
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
    const current = {
      ...turn,
      ...result,
      category: preparation.value.category,
      difficulty: preparation.value.difficulty,
      automation,
      status: 'review',
    };
    nextDecision(
      {
        ...task,
        turns: task.turns.map((r) => (r.id === turn.id ? current : r)),
      },
      current,
      context.config,
    );
  }
  async function safePlan() {
    try {
      await planFollowup();
    } catch (e) {
      delete automation.next;
      delete cached.next;
      automation.nextError = e.message;
      persist();
    }
  }
  try {
    if (turn.planRetry) {
      if (!cached.completedResult?.success)
        throw Error('缺少本轮已归档结果，不能只重试后续出题');
      result = structuredClone(cached.completedResult);
      result.jobToken = turn.jobToken;
      automation = result.automation;
      automation.questionRuleVersion = questionRules.version;
      await safePlan();
    } else {
      if (!cached.claude?.success) {
        stage = 'context';
        await api({
          action: 'stage',
          taskId: task.id,
          turnId: turn.id,
          jobToken: turn.jobToken,
          stage,
        });
        const container = await containers.ensure(task, turn);
        task = {
          ...task,
          workDir: container.workDir,
          container: containers.public(container),
          snapshot: container.snapshot,
          sessionId: container.sessionId,
        };
        result.container = containers.public(container);
      }
      if (
        task.projectSeries &&
        task.turns[0]?.id === turn.id &&
        !task.container?.scaffoldSnapshot &&
        !cached.claude
      ) {
        const scaffold = await step(
          'scaffold',
          `为项目准备最小骨架。项目目标：${task.title}。技术栈：${task.stack}。只返回目录文件、程序入口、必要依赖清单、空模块接口、基础配置、测试运行器和必需的最小网页入口（能在浏览器打开空页面），选择符合业务的轻量实现，不强制某种架构或数据库；网页入口不能省略，不用命令行界面代替。不实现题目中的业务流程、领域算法或完整功能。现有路径为空，不需要安装依赖或运行命令。最多 40 个文件、总计 160KB，每个文件使用相对于项目根目录的路径。骨架将作为 Claude 开始前的初始代码，由 Claude 完成真正的全新功能。`,
          task.workDir,
        );
        cached.scaffold = scaffold;
        persist();
        const s = containers.load(task.id);
        s.scaffoldSnapshot = installScaffold({
          value: scaffold.value,
          workDir: task.workDir,
          directory: task.projectSeries.directory,
          evidenceDir: path.join(dir, 'scaffold'),
          tracePath: scaffold.tracePath,
        });
        await containers.publish(s);
        task.container = containers.public(s);
        result.container = task.container;
      }
      if (cached.scaffold) automation.scaffold = cached.scaffold;
      const index = task.turns.findIndex((r) => r.id === turn.id);
      const previousTurns = task.turns
        .slice(0, Math.max(0, index))
        .filter(
          (r) => !r.excluded && ['review', 'submitted'].includes(r.status),
        );
      const firstTurn = previousTurns.length === 0;
      const previousTurn = previousTurns.at(-1);
      const continuation = continuationContext(task, turn);
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
      preparation = await step(
        'prepare',
        `${seriesPrompt(task)}\n本题已分配分类：${turn.category}，category 必须保持该值，准备阶段不能更换题型。\n用户任务目标：${turn.requestedPrompt || turn.prompt}\n当前容器内工作目录固定为 /workspace，容器已启动，项目骨架或上题归档代码已准备好，宿主机参考仓库不在容器里。0-1 在该项目内实现全新功能，Feature 迭代现有能力。请读取当前任务目录，准备交给 Claude 的任务 prompt、分类、难度、技术栈和验收条件。题目首行只写项目名称，不加编号，正文用 180 至 260 字自然描述网页业务，原始题目措辞不是格式模板。保留业务目标和必要边界，不擅自增加业务需求；当前目录、权限、评测来源和技术实现细节不附加到 prompt。详细验收步骤放入 acceptance，正文保留用户可见的验收行为。${firstTurn ? '这是首轮，禁止简单题。' : '这是后续轮次，须结合前序目标与产物判断。'}\n轮次上下文：${roundContext}\n这是 AI 自动评测任务，不得声称是人工标注。\n${policyInstructions()}`,
        task.workDir || task.repoPath,
        { allocation: { category: turn.category } },
      );
      if (continuation) {
        preparation.value = {
          ...preparation.value,
          prompt: turn.prompt,
          category: continuation.previous.category,
          difficulty: continuation.previous.difficulty,
          acceptance: continuation.acceptance,
        };
      }
      if (turn.repairOf) {
        if (preparation.value.category !== 'Bug 修复')
          throw Error('当前同会话追问必须为 Bug 修复');
      } else if (preparation.value.category === 'Bug 修复')
        throw Error('Bug 修复只能关联当前会话');
      if (!turn.repairOf && preparation.value.category !== turn.category)
        throw Error('独立题型与已分配额度不一致，需重新出题');
      // The actual prompt stays identical to the checked question. Project
      // location is already recorded in task.projectSeries and the snapshot.
      // Executed prompts are immutable historical evidence.
      if (
        !preserveQuestion &&
        !continuation &&
        questionIssues(preparation.value.prompt).length
      )
        throw Error('执行前题目格式校验未通过');
      cached.prepare = preparation;
      persist();
      automation.preparation = preparation;
      result.preparedPrompt = preparation.value.prompt;
      result.evaluationPrompt =
        continuation?.evaluationPrompt || preparation.value.prompt;
      if (
        result.evaluationPrompt.length > 80000 ||
        preparation.value.prompt.length > 80000
      )
        throw Error('执行或验收目标超过 80000 字限制');
      result.preparation = preparation.value;
      const candidate = {
        repoPath: task.repoPath,
        title: task.title,
        prompt: result.evaluationPrompt,
        category: preparation.value.category,
        difficulty: preparation.value.difficulty,
      };
      const context = await api({ action: 'supply-context' });
      const history = context.history
        .filter((t) => t.id !== task.id)
        .slice(0, 200);
      const audit = await step(
        'policy',
        `${policyInstructions({ questionStyle: questionStyleApplies })}\n${!questionStyleApplies ? '本题已在终端发送，保留原始题目，不追溯应用新的题目格式与内容标准；questionCompliant 写 false，questionChecks、workflowFeatures、businessDetails 写空数组，allowed 只按原禁出和难度规则判断。' : ''}\n轮次上下文：${roundContext}\n独立审核用户原目标与准备后的实际任务，两个都必须合规。若当前输入仅为继续或续写，必须根据前序原始目标判断。用户原目标：${turn.requestedPrompt || turn.prompt}\n候选题：${JSON.stringify(candidate)}\n跨仓库历史题目：${JSON.stringify(history)}\n逐类检查并在 checkedGroups 返回所有组 ID。allowed 只有无禁出项、无实质雷同且难度合格时才为 true。matchedRuleIds 使用组 ID 或 general；duplicateTaskIds 使用实际历史 ID。reason 给出实质判断依据。`,
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
      if (questionStyleApplies)
        audit.questionRuleVersion = questionRules.version;
      audit.candidateDigest = await candidateDigest(candidate);
      automation.policy = audit;
      assertPolicyAudit(audit, audit.candidateDigest, {
        firstTurn,
        allowFollowupFix,
        requireQuestionStyle: questionStyleApplies,
      });
      cached.policy = audit;
      persist();
      const container = cached.claude?.container || task.container;
      if (!container || !validDockerSnapshot(container.snapshot))
        throw Error('缺少经过核验的容器初始环境');
      const environmentEvidence = containers.environmentEvidence(task, turn);
      const environmentPath = path.join(
        dir,
        turn.id + '.attempt-' + (cached.attempt || 1) + '.environment.json',
      );
      writeFileSync(
        environmentPath,
        JSON.stringify(environmentEvidence, null, 2),
        { mode: 0o600 },
      );
      const runtimeState = containers.load(task.id);
      const alreadySent =
        cached.claude?.success ||
        runtimeState?.results?.[turn.id] ||
        (runtimeState?.pending?.turnId === turn.id &&
          runtimeState.pending.phase === 'sent');
      const preserveInitialSnapshot = alreadySent || !!turn.repairOf;
      const initialSnapshot =
        cached.snapshot ||
        (turn.repairOf &&
          task.turns.find((r) => r.id === turn.repairOf)?.automation?.snapshot);
      const snap = preserveInitialSnapshot
        ? resumeInitialSnapshot(
            initialSnapshot,
            environmentEvidence,
            environmentPath,
          )
        : await step(
            'snapshot',
            `只读检查容器任务的环境证据：${JSON.stringify(container)}。执行器已在本阶段开始前通过 Docker CLI 实时核验容器身份、镜像、运行状态、唯一工作区挂载和隔离配置，任一项不符会由程序直接中止。脱敏核验文件：${environmentPath}，内容：${JSON.stringify(environmentEvidence)}。你的只读环境不能访问 Docker socket，不执行 Docker、容器控制、终端探测或其他运行环境命令；容器实时状态引用执行器核验结果，不重复探测。你负责读取当前绑定挂载目录及初始代码清单，核对代码摘要、依赖声明和启动说明。容器从指定镜像和空 /workspace 启动，再导入系统准备的项目骨架或上题冻结的代码；初始代码以 scaffoldSnapshot 或 sourceSnapshot 证据为准。ready 表示环境及初始代码证据是否可用于开始本题，不表示业务功能已完成。首题骨架的 NotImplementedError 和跳过的占位测试属于预期，不因此拒绝环境就绪；不在此阶段启动业务服务或运行验收测试。不要要求根目录有 Git，不得修改、提交或推送。head 返回镜像摘要，remote 返回镜像名称。environmentLevel 只能是 ${workflow.environmentLevels.join('；')}。列出依赖、启动方法和真实核验范围；镜像固定不代表外部服务及后续下载的依赖已经冻结，不得编造运行结果。`,
            task.workDir || cached.claude.workDir,
          );
      if (!preserveInitialSnapshot) {
        snap.environmentEvidence = environmentEvidence;
        snap.environmentEvidencePath = environmentPath;
      }
      if (!snap.value.ready)
        throw Error('Codex 环境检查未通过：' + snap.value.notes.join('；'));
      // The reference repository is never mounted into the container or presented as its initial state.
      let githubEvidence = task.githubSnapshot;
      if (!githubEvidence) {
        try {
          githubEvidence = githubSnapshot(task.repoPath);
        } catch (e) {
          automation.referenceSnapshot = { available: false, note: e.message };
        }
      }
      result.reproducibility = snap.value.environmentLevel;
      result.githubSnapshot = githubEvidence;
      result.snapshot = container.snapshot;
      if (githubEvidence)
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
      if (permissionIssues(result).length)
        throw Error(permissionIssues(result).join('；'));
      // A completed call with invalid runtime context must not be replayed on retry.

      const score = await step(
        'score',
        ` ${scoreInstructions()}\n${harnessInstructions(result.harness)}\n你是 Codex 自动评分器。只读分析当前产物和本轮原始轨迹。\n本轮实际 Prompt：${preparation.value.prompt}\n原始验收目标（继续也必须按此目标评分）：${result.evaluationPrompt}\n本轮结果类型：${result.executionOutcome || 'complete'}\n验收条件：${JSON.stringify(preparation.value.acceptance)}\n本轮轨迹文件：${result.tracePath}\n初始快照：${result.snapshot}\n请核对实际文件及轨迹，存在 Git 仓库时可补充 diff，空目录生成项目不要求根目录有 Git。按交付完整性、指令遵循、任务规划、推理能力、执行能力依次评分 1–5，并为每项提供具体步骤、文件或工具调用的证据和影响。不要修改、修复产物或编造测试；没有执行的测试不能声称通过。评分来源必须为 AI。other 无其他问题时写“无”。`,
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
        !validDockerSnapshot(result.snapshot || '') ||
        !result.traceExport?.verified
      )
        throw new Error(
          '自动交付缺少真实会话、轮次、轨迹或完整快照，不能生成合格交付包',
        );
      const delivery = await step(
        'delivery',
        `对以下 AI 评测数据做交付校验：${JSON.stringify({ snapshot: result.snapshot, sessionId: result.sessionId, promptId: result.promptId, tracePath: result.tracePath, prompt: preparation.value.prompt, evaluationPrompt: result.evaluationPrompt, executionOutcome: result.executionOutcome, review: result.review, processFindings: score.value.processFindings, artifactFindings: score.value.artifactFindings })}\n逐项核对 When/What/Impact/正确做法、过程与产物证据、模型归因和分数分档一致性；检查五维分数与证据是否一致、是否具体可追溯、是否存在虚假成功。基于实际轨迹与代码。passed 只代表内部 AI 评测数据是否完整一致，不能声称满足原项目人工标注规则。不要向腾讯文档或其他平台提交；返回校验清单和结论。`,
        result.workDir,
      );
      automation.delivery = delivery;
      if (!delivery.value.passed)
        throw new Error('Codex 交付校验未通过：' + delivery.value.summary);
      cached.delivery = delivery;
      persist();
      automation.evidenceVersion = 2;
      const bundlePath = path.join(dir, turn.id + '.ai-delivery.json');
      automation.bundlePath = bundlePath;
      writeFileSync(
        bundlePath,
        JSON.stringify(
          {
            provenance: 'AI-generated / Codex CLI',
            harness: result.harness || 'Claude Code',
            container: result.container,
            traceExport: result.traceExport,
            permissionAudit: result.permissionAudit,
            roundNumber: turn.roundNumber || 1,
            usage: '内部 AI 评测数据，不作为原项目人工标注',
            taskId: task.id,
            turnId: turn.id,
            prompt: preparation.value.prompt,
            evaluationPrompt: result.evaluationPrompt,
            continuationOf: turn.continuationOf,
            repairOf: turn.repairOf,
            questionRootId: turn.questionRootId,
            executionOutcome: result.executionOutcome,
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
      cached.completedResult = structuredClone({ ...result, automation });
      persist();
      await safePlan();
    }
  } catch (e) {
    result.success = false;
    result.error = e.message;
    const container = containers.load(task.id);
    if (container) {
      result.container = containers.public(container);
      result.workDir = container.workDir;
      result.snapshot = container.snapshot;
    }
  }
  result.action = 'finish';
  result.taskId = task.id;
  result.turnId = turn.id;
  result.jobToken = turn.jobToken;
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
    // Iterate a snapshot because completed journals are removed from the live list.
    for (const journal of orphans.slice()) {
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
        const projectSeries = {
          version: seriesVersion,
          directory: 'projects/p-' + randomUUID(),
        };
        const generated = await codexStage({
          stage: 'generate',
          cwd: repoPath,
          dir: supplyDir,
          turnId: randomUUID(),
          onChild: track,
          prompt: `Codex 负责先生成通用项目骨架，再设计该项目首个全新功能，Claude 在可见终端中实现该功能。首题 category 必须为 0-1 代码生成。只读分析当前仓库，仅将其作为出题参考，Claude 在新容器 /workspace 中已准备好的最小骨架上工作，容器不可访问参考仓库。在相对目录 ${projectSeries.directory} 的项目骨架内设计此前不存在的全新功能，不修改该目录外业务。完整首题应交付能运行的全新功能及验证方法，后续在同项目继续出全新功能、Feature 迭代、真实 Bug 修复、理解和重构题，目标比例 7:7:10:1:1；0-1 与 Feature 各最多十题。出题范围：${context.config.scope}\n今日已完成及排队题型分布：${JSON.stringify(context.mix)}。新项目首题始终为 0-1；类型分布在同项目的后续题中调节。\n${policyInstructions()}\n不要重复或改写已有题目：${JSON.stringify(history)}\n禁止依赖其他自动任务的改动。不要提出需要外部付费、发布、推送或外部消息的任务。不执行此任务，只返回具体任务目标和验收要求。title 使用简洁项目名称，最多 200 字；prompt 从项目名称开始，不加编号，正文 180 至 260 字、1 至 2 段；stack 最多 300 字，只记录适合业务的建议，不把实现偏好强加为题目限制。`,
        });
        if (generated.value.category !== '0-1 代码生成')
          throw Error('自动新项目首题必须是 0-1 代码生成');
        if (existsSync(path.join(repoPath, projectSeries.directory)))
          throw Error('新项目目标目录已存在');
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
          projectSeries,
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
        audit.questionRuleVersion = questionRules.version;
        audit.candidateDigest = await candidateDigest(payload);
        // Persist rejections too, so the UI can explain why nothing was enqueued.
        supplyState.lastAudit = audit;
        saveSupply();
        assertPolicyAudit(audit, audit.candidateDigest, {
          requireQuestionStyle: true,
        });
        payload.policyAudit = audit;
        supplyState.pending = payload;
        saveSupply();
      }
      if (stopping) return;
      if (
        payload.policyAudit?.ruleVersion !== rules.version ||
        payload.policyAudit?.questionRuleVersion !== questionRules.version ||
        payload.projectSeries?.version !== seriesVersion
      ) {
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
      await containers.reconcile(
        context.containerTasks || [],
        new Set(active.keys()),
      );
      const resource = resources(context.config.concurrency);
      const docker = dockerStatus();
      const hostCapacity = resource.effective;
      resource.effective = containerCapacity(docker, resource.effective);
      resource.recommended = containerCapacity(docker, resource.recommended);
      resource.reason = !docker.ready
        ? docker.reason
        : resource.effective === 0
          ? hostCapacity === 0
            ? '宿主机可用内存不足，暂停领取新任务'
            : 'Docker 资源不足，暂停领取新任务'
          : '同时按宿主机与 Docker 虚拟机资源限制';
      const readySources = docker.ready ? context.repos : [];
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
        docker,
        residentContainers: containers.residents().length,
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
          : resource.effective === 0
            ? resource.reason
            : (context.repos.length && !readySources.length
                ? docker.reason
                : null) ||
              supplyDecision(context, supplyState) ||
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
          residentTaskIds: containers.residents(),
          allowNewContainer: containers.residents().length < resource.effective,
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
        containers.residents().length < resource.effective &&
        !supplyDecision(context, supplyState) &&
        readySources.length > 0
      ) {
        generating = replenish({ ...context, repos: readySources }).finally(
          () => {
            generating = null;
          },
        );
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
  containers.detach();
}
