# SOLO 早晚上传

目标：https://solo2.jzxhnh.com。用户授权将本系统做好的标注数据填入该平台，每天北京时间 08:00、20:00 上传。默认使用 Codex 内置浏览器中的现有登录，账号显示名为牛宇航，用户名为 niuyuhang。账号密码和浏览器 Cookie 不进入流水线数据、命令参数或日志。

本功能上传 AI 评分，保留 AI 来源及之后由用户二次确认的状态，不声称已经人工审核。上传与平台质检通过是两个不同状态；平台返回的待返修、废弃结果必须保留。

## 数据与准入

在本项目目录运行 `node scripts/solo-ui-queue.mjs --prepare`，只处理本次输出的 packets。每次从本机 `http://localhost:3000/api/records?source=ai` 分页获取当前数据，不依赖人工 Excel 导出次数，也不把上传计入 Excel 下载次数。

每条数据必须通过现有题目、权限与交付校验，以及最终原终端导出和容器清理检查；旧后台导出不冒充新协议最终原终端导出。提交副本保留完整原生轨迹目录，用 ZIP 上传，保留源归档与轨迹摘要绑定，发送前重新验证文件清单、内容摘要、20 MB 限制及当前已配置密钥的脱敏结果。原始轨迹不改写。任何附件、收尾证据、敏感内容或绑定异常都进入 blocked，继续处理其他可提交记录。

同一原生 SessionID 按真实轮次顺序提交。首轮至少中等；同一会话的初始快照、Harness、版本、操作系统与可复现等级一致。缺少合格前序轮次时暂缓后续轮次，不能改轮次、换原生标识补空缺。

私有台账位于 `.runner/solo-upload/ui-state.json`，提交包字段位于 `.runner/solo-upload/packets/`，回执位于 `.runner/solo-upload/receipts/`，都不提交到 Git。journal.lock 串行保护台账事务；如果上次进程异常退出留下锁，先核对其 PID 确已退出才能删除锁，不能删除仍在运行的操作锁。

## 每次定时执行

1. 现有巡检在整点和半点运行，先执行 `node scripts/solo-schedule.mjs --due`。只有北京时间 08:00、20:00 对应半小时窗口且当天该批次未启动才 due；其他时刻仅执行原巡检。due 时运行 `--claim`，仅 claimed=true 才开始本批并记住 slot。检查本地接口和上述 prepare 输出。没有新数据且无新的异常时保持安静。对反复出现且未变化的 blocked 不重复通知。
2. 使用 CUA 的 `cua.getState()` 查找 SOLO 已登录标签页，按返回的浏览器和标签 ID 选择；不存在则在内置浏览器打开目标站点。只通过支持的浏览器/原生 UI API 操作，不从浏览器提取认证信息。确认账号为牛宇航（可见用户名 niuyuhang）；登录过期、账号变化或需要验证码时暂停上传并通知用户，不尝试猜测凭据。
3. 对每条记录，先在我的提交通过原生 SessionID 和 TurnID/PromptID 核对有无远端记录。两者均一致才能认为同一条；打开详情核对全部字段和附件。已有记录保存回执并跳过，内容不一致则保留原记录并报告，不创建副本或自动覆盖。
4. 如果本地状态为 submitting/uncertain，只查远端结果，不再次点击提交。没有明确结果时留在待核对状态。普通 prepared 记录且未找到远端匹配，才填写新表单。相同会话前序记录无法确认已提交时，暂停该会话后续记录，继续其他会话。
5. 读取 packetPath 文件，照 fields 填写表单。User Prompt、五维分数和描述来自本地原始记录，不为了平台查重改写题目或评分。任务类型的 `feature迭代` 对应表单 `Feature迭代`。当前对话轮次排序是数值 1–10，Excel 的第一轮等显示不直接填到数字控件。填写后失焦并读取实际 value；该网站数字控件 fill 后可能显示空值，可使用可见增减按钮调整至目标数值，并再次确认。
6. 轨迹文件只选 packet.attachment.path。CUA 先注册 filechooser 等待并捕获异常，再点击轨迹文件组内的可见选择轨迹文件按钮，使用 chooser.setFiles；隐藏 input 点击无法可靠打开选择器。等上传结束，检查附件名和大小。不能用单份 JSONL 替代完整 ZIP。
7. 核对 23 个必填字段（若平台增减字段，重新按实际页面核对；未知必填字段停止本条，不能编造值）、全部输入、五维评分和附件。提交人、提交时间、质检结果、父记录、审核备注等管理字段由平台维护。项目名称和本地选择序号不提交。
8. 最终点击前运行 `node scripts/solo-ui-queue.mjs --mark-sending TASK_ID:TURN_ID`；它重新确认当前准入、数据和附件未变，并先持久化 submitting。命令失败则不要点击。成功后只点击一次提交并质检。
9. 等待提交回执，打开数据详情，核对平台记录编号、原生 ID、轮次、全部文本、分数和附件。保存私有 JSON 回执后运行 `node scripts/solo-ui-queue.mjs --receipt TASK_ID:TURN_ID RECEIPT_JSON_PATH`。回执格式见下节。网络中断或结果不明时保留 submitting，下次仅查询确认。
10. 平台待返修或废弃的记录已提交，不重新创建；保留理由并通知用户。根据真实轨迹进行评分返修属于独立处理，不删关键词、编造事实或调分来规避质检。不得点击管理员飞书同步、删除、质检覆盖等无关操作。
11. 本批按顺序处理可提交项，结束保存 slot、status（completed/blocked/failed）、本次计数、异常签名和时间到私有 run-summary.json，并运行 `node scripts/solo-schedule.mjs --finish .runner/solo-upload/run-summary.json`。仅在有新上传、状态变化、失败或需要用户处理时通知。保留 SOLO 标签页作为 handoff/deliverable，维持下次可复用的登录状态。

## 回执格式

```json
{
  "remoteId": 618,
  "remoteStatus": "PENDING_FIX",
  "sessionId": "页面核对的原生 SessionID",
  "promptId": "页面核对的原生 TurnID/PromptID",
  "fieldsVerified": true,
  "account": "牛宇航",
  "username": "niuyuhang",
  "reason": "页面显示的质检原因",
  "verifiedAt": "核对时间 ISO 字符串"
}
```

状态映射：已提交为 SUBMITTED，通过为 QC_PASSED，待返修为 PENDING_FIX，已废弃为 DISCARDED。fieldsVerified 仅在实际查看远端完整详情并核对后填写 true。`--receipt` 幂等保存同一远端编号，拒绝账号、原生标识或编号冲突。

## 当前接入方式与验证

2026-09-10 已通过真实网页完成首条端到端提交：记录 [618](https://solo2.jzxhnh.com/app/submissions/618)，附件 1.3 MB，轮次 1。平台返回 PENDING_FIX，原因是指令遵循 5 分与描述关键词触发一致性检查。已保存实际回执，不将其标记成质检通过。之后的上传增加最终原终端收尾门槛，中间快照不直接提交。

`scripts/solo-client.mjs`、`solo-records.mjs`、`solo-sync.mjs` 同时保留可测试的 API 映射和幂等实现，但 API 登录未配置，默认任务不使用 `solo-upload.mjs --once`。已有浏览器台账时禁止 API 写入，避免两种通道重复提交。

验证：`node --test tests/solo-upload.test.mjs`。测试覆盖字段映射、分页查重、断网与不明确回执、重复启动、资格变化、附件摘要和大小、服务端拒绝、字段回读、浏览器回执、台账锁及会话连续性。

这是本机 Codex 定时任务，需要电脑开机、Codex 运行、本地流水线可访问且 SOLO 登录有效；不是服务器离线任务。Codex 同一任务只允许一个 heartbeat，因此合并到现有每 30 分钟巡检中，调度对齐整点和半点；上传入口单独校验 08:00、20:00 的时段及当天批次幂等标识。错过时段不在其他时间擅自补发，下一次早晚时段会继续处理未上传数据。
