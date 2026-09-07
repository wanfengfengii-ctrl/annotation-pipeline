# Codex / Claude 自动评测流水线

任务目标 → **Codex CLI 准备任务** → **Codex CLI 检查环境快照** → **Claude CLI 执行** → **Codex CLI 五维评分** → **Codex CLI 校验并生成交付包**。

两个 CLI 都不传 `--model`，沿用各自的用户及项目配置。Codex 各阶段使用 `codex exec --sandbox read-only --json --output-schema`，其结构化结果、线程 ID 与原始事件分别存档。Git fetch、完整 SHA 验证和独立工作区创建由确定性执行器完成，防止把模型描述当成真实快照。

## 使用

需要 Node.js 22.13+、Git、已配置且可用的 `claude` 与 `codex` CLI。

```sh
npm install
# 首次初始化才需要执行；已有数据库不要重复执行
npm run db:local
node scripts/init-local.mjs
npm run dev
# 另一个终端
npm run runner
```

打开 http://localhost:3000。填写任务目标、本机 Git 仓库绝对路径，点击“创建并启动流水线”。Codex 自动识别题型、难度、技术栈及验收条件，生成交给 Claude 的 Prompt。后续可追加目标，每个会话最多 10 个有效交互。

初始仓库须为已推送的干净 GitHub 仓库。首轮创建 `.runner/<task-id>/workspace` 独立工作区；后续 Claude 轮次恢复同一会话。工作区已提交的配置及原始 `.claude/settings.local.json`（仅本机复制）继续使用。不会自动 commit/push 用户代码或绕过 CLI 权限。外部依赖仍需在工作区可用。

## 四个 Codex 阶段

1. **任务准备**：读取仓库和用户目标，输出执行 Prompt、任务分类、难度、技术栈、验收条件。原始目标与执行 Prompt 分开保存。
2. **环境快照**：只读检查 HEAD、origin、工作区及依赖状态。首次 HEAD 必须与真实 Git 命令一致。执行器验证远端提交并创建快照链接。
3. **自动评分**：只读检查本轮原始轨迹与产物，按交付完整性、指令遵循、任务规划、推理能力、执行能力输出分数和具体证据。不修复被测代码，不虚构测试。
4. **校验与交付**：Codex 检查证据与评分一致性；执行器额外校验真实 ID、轨迹及完整 SHA。通过后生成 `.runner/<task-id>/<turn-id>.ai-delivery.json`，页面可导出 CSV。

CSV 和 JSON 始终明确标记 `AI / Codex CLI`、AI 评测用途，`attested` 不会伪造为人工确认。本模式不符合原腾讯文档项目的人工标注要求，不能冒充人工标注提交。外部平台提交不是自动步骤；界面仅可登记已实际完成的外部提交回执。

## 失败与恢复

阶段结果按轮次保存在 `.stages.json`。点击“重试失败阶段”重新排队同一轮：成功阶段复用，已成功的 Claude 调用不会因评分失败而重复执行。失败的 CLI 调用按显式重试请求再执行，能恢复会话时使用原会话。每次尝试的事件日志分开保存。

回写结果保存在本机文件，网络异常时重试回写。API 对同一完成凭据支持幂等回写。单执行器锁防止重复启动；异常退出残留锁时先确认记录的 PID 已停止，再移除锁。未产生最终结果就崩溃的运行仍需人工运维确认，系统不会自动重放结果不确定的模型调用。

Claude 默认超时 30 分钟，Codex 每阶段默认 15 分钟。可通过 `RUNNER_TIMEOUT_MS` 和 `CODEX_STAGE_TIMEOUT_MS` 调整。原始事件、stderr、会话轨迹和数据包保存在 `.runner`，密钥在 `.dev.vars`，均不进入 Git 或发布包。

云端与本机 D1 数据独立。云端还需单独连接可认证的执行器；当前直接运行本机 CLI 请使用本机工作台。

## 检查

```sh
node --experimental-strip-types --test tests/rules.test.mjs tests/codex-stages.test.mjs
npx tsc --noEmit
npm run build
```

`tests/api.test.mjs` 测试接口，`tests/flow.test.mjs` 使用明确的假 CLI 测试完整阶段及断点重试，不调用真实模型。运行这些本机集成测试前停掉执行器，测试只使用自己创建的临时任务，测试后按记录的 ID 清理。
