# SOLO 每两小时上传

目标：https://solo2.jzxhnh.com。用户授权将本系统做好的标注数据填入该平台，每天北京时间 00:00、02:00、04:00、06:00、08:00、10:00、12:00、14:00、16:00、18:00、20:00、22:00 上传，每两小时一次。默认使用 Codex 内置浏览器中的现有登录，账号显示名为牛宇航，用户名为 niuyuhang。账号密码和浏览器 Cookie 不进入流水线数据、命令参数或日志。

本功能上传 AI 评分，保留 AI 来源及之后由用户二次确认的状态，不声称已经人工审核。上传与平台质检通过是两个不同状态；平台返回的待返修、废弃结果必须保留。

用户于 2026-09-10 明确要求：后续所有返修说明留空，包括表单的“这次改了什么”。不要填写内部流程说明、AI 复评说明或自动生成的修改摘要。评分来源与核验记录仍保留在本地台账中；已产生的远端历史操作日志不改写。

## 禁止上传标记

用户指定不上传的记录按 `taskId:turnId` 固定保存在私有 `upload-holds.json`，不依赖会变化的页面序号。使用 `node scripts/solo-ui-queue.mjs --block TASK_ID:TURN_ID 原因` 设置；`--status` 可查看标记。准备队列、构建附件及发送前均检查标记，旧 prepared 包也不能绕过。此标记不改题目、评分、Excel 下载次数或已有远端回执。

2026-09-10 早期用户确认排除 Webhook 最早三条，随后用户逐条人工确认当时 19 条中仅序号 17 禁止上传，其余可以上传。最新确认优先，固定清单与旧台账备份见 `.runner/solo-upload/batches/user-original-reupload-20260910/`。当前唯一明确禁传记录为 `4970999d-0bb3-430c-a415-b08f5527435f:0afdf1ca-97df-4cdf-ba72-368859245c56`，不能随新增记录的序号变化；它所属会话的第二、三轮仍因首轮缺失暂缓，不得改号。人工确认只适用于本次固定清单，不放宽后续自动出题审核。

## 原生附件和 PromptID

真实质检发现两个独立问题：618 第 2 版的内部综合证据 ZIP 被判为非原生轨迹；用户删除 618 后重新录入的 652 通过附件格式检查，但原消息 UUID 被误当作 PromptID，因标识不匹配打回。保留这两次真实回执，不将其记为通过。

SOLO 附件由 `solo-native-attachment.mjs` 从已核验的完整原生 projects 目录构建，保留子会话、文件及目录；不混入评分、运行验收、项目源码、内部清单或 provenance JSON。按用户 2026-09-10 的明确要求，`native-verbatim1` 将原文件 Buffer 直接放入 ZIP，文件名、正文、空白、换行和编码字节均不替换，不对轨迹运行脱敏或 JSON 重序列化。只增加统一的 projects/ 打包根目录及 ZIP 压缩元数据。

权限检查还核对 Bash 管道中被成功退出码掩盖的原生错误。实际执行 apt 时，即使使用 `-o` 指定临时目录，缓存清理仍可能返回 Permission denied；后面的 `tail` 成功不能将这次拒绝消除。2026-09-10 晚间复核发现此类漏检，同一完整原生会话的三条记录已按固定 ID 暂缓上传。原始轨迹和已有点评保留，不以重新打包消除拒绝。用户随后明确要求原样上传这三条，因此仅对这三个固定记录建立本机 permission-admissions.json 授权。例外绑定任务、轮次、SessionID、PromptID、原件清单、ZIP 摘要、检查版本和确切错误集合；任一项变化仍阻止上传。审计继续记录 permissionPassed=false 和真实 denialCount，另存用户授权，不伪造通过。其他禁止上传记录不受影响，授权清单不提交 Git。

打包时逐文件核对原件清单的 SHA-256 和字节数，解包后再逐字节比对；只读解析用于原生标识和权限检查。ZIP 外的本地审计记录 `byteIdentical: true`、`redactions: 0` 和每个文件相同的原件/附件摘要。目录或文件缺失、权限拒绝、标识不匹配、内容变化均阻止生成，不能删改内容使其通过。平台 20 MB 限制应用于实际发送的原生 ZIP，超限不裁剪轨迹。

发送前从原件重新构建并校验，并核对浏览器选中的实际文件路径、名称、大小、摘要和字节内容；旧替换版 packet 即使摘要自洽也不能继续发送。已上传附件不会因本地修复而自动改变；需单独核对平台是否允许返修，并保留旧版附件及真实远端回执，不改写历史为原样上传。

`solo-native-identity.mjs` 按原生 SessionID 和流水线保存的用户消息 UUID 唯一定位原题事件，再读取该事件自身的 `promptId`。两者是不同字段，不能直接将 `uuid` 填入 SOLO 的 TurnID/PromptID。上传副本记录映射和原始清单摘要，内部观察器标识、原有评分与归档保持不变；缺少真实 promptId 时暂缓该条。定时上传和手动重新录入都从重新准备的字段读取，不复用修复前的旧 packet。

新数据仍须通过最终原终端收尾准入。旧记录的真实后台导出方式不能改写为新协议。用户明确要求删除后重新录入某条已有记录时，先核对该账号列表和旧详情，保存旧回执及删除事实，再在私有台账记录替代关系；不得把这次指定操作当作其他旧记录的自动放行。字段锁定的错误记录不能靠修改原始轨迹来迁就已提交 ID。

## 评价阶段的一致性处理

2026-09-10 记录 618 的指令遵循 5 分被打回：点评把位置提示的实现缺陷混入本维，再用否定句解释评分，触发错误、不能、偏差三个问题信号。按用户要求，此问题在 Codex 评价阶段处理，上传流程不另加关键词关卡，也不在导出时改写点评。

`lib/score-consistency.mjs` 的要求从首次评分提示开始生效：逐条核对原题，把真实问题归到相关维度；不能把所有实现问题自动排除在指令遵循之外。满分用实际完成范围和约束落实说明依据，其他维度的问题保留在对应点评和内部证据中。关键词本身不决定分数，不为通过质检删词、改事实或机械降分。

`codexStage` 在保存正式评分前，对含上述已知歧义的满分点评最多追加一次 Codex 证据复评。复评可依据原分档调整分数，文字修订仍不能擅自改分；两者都使用当前配置的 Codex 模型，不消耗 Claude 会话轮次。原评分输出和事件完整保留、封存摘要并纳入证据包。复评后仍有冲突则保留失败证据，不能标为评分成功或无限重试。

已有远端记录的返修是独立版本，不覆盖原始 Claude 轨迹、旧评分和退回回执。历史归档为 `legacy-runner-migration/needs_review` 时可以准备评价返修草稿，但不能把改好点评视为原终端轨迹已合格；正式重提仍需符合既有归档要求。

## 数据与准入

在本项目目录运行 `node scripts/solo-ui-queue.mjs --prepare`，只处理本次输出的 packets。每次从本机 `http://localhost:3000/api/records?source=ai` 分页获取当前数据，不依赖人工 Excel 导出次数，也不把上传计入 Excel 下载次数。

每条数据必须通过现有题目、权限与交付校验，以及最终原终端导出和容器清理检查；旧后台导出不冒充新协议最终原终端导出。外发附件仅包含完整原生轨迹目录，发送前重新验证原样字节、文件清单、内容摘要和 20 MB 限制。原始轨迹与上传文件内容必须一致。任何附件、收尾证据或绑定异常都进入 blocked，继续处理其他可提交记录。

2026-09-10 用户要求减少本地上传拦截，由平台执行质量检查后按实际退回结果返修。内部评分日志、项目数据库等不随原生附件发送，它们的脱敏或内容扫描结果保留为本地提示，不再阻止 SOLO 上传。`verifySubmissionPackage` 的 `native-only` 用途仍核对原件、提交副本清单、文件摘要和原终端最终回执，但不以内部内容扫描结论作为上传门槛；默认内部副本核验继续保持严格检查，不能把带提示的内部 ZIP 当成已脱敏附件外发。原生附件仍由独立打包器从完整原件生成，上传前核对实际 SessionID/PromptID、完整目录和原样字节。禁止上传标记、重复提交保护和原有固定记录授权继续有效。不要将本地准备成功写成平台质检通过。

同一原生 SessionID 按真实轮次顺序提交。首轮至少中等；同一会话的初始快照、Harness、版本、操作系统与可复现等级一致。缺少合格前序轮次时暂缓后续轮次，不能改轮次、换原生标识补空缺。

私有台账位于 `.runner/solo-upload/ui-state.json`，提交包字段位于 `.runner/solo-upload/packets/`，回执位于 `.runner/solo-upload/receipts/`，都不提交到 Git。journal.lock 串行保护台账事务；如果上次进程异常退出留下锁，先核对其 PID 确已退出才能删除锁，不能删除仍在运行的操作锁。

## 每次定时执行

1. 现有巡检每 15 分钟运行（整点、15 分、半点和 45 分），先执行 `node scripts/solo-schedule.mjs --due`。北京时间每个单数小时的 30 分做登录预检，在随后双数整点开始的半小时窗口创建新批次；23:30 的预检对应次日 00:00。已因登录暂停的批次优先续传，不受原时段限制。新批次先运行 `--prepare`，将完整输出保存为私有 plan.json，再执行 `solo-schedule.mjs --claim PLAN_JSON`，即使 canClaim=false 也要执行这次 claim，固定本批成员及原件摘要。无新数据会直接结束空批次。登录未就绪时保存 waiting_login；不能登录失败就丢掉本次批次。resume 模式执行 `--claim`，不传新成员。仅 claimed=true 才进入上传，并保存返回的 slot、attemptId。没有新数据且无新的异常时保持安静。
2. preflightDue 或 loginCheckDue 时，使用 CUA 的 `cua.getState()` 查找 SOLO 标签页，按返回的浏览器和标签 ID 选择；不存在则在内置浏览器打开目标站点。复用牛宇航（可见用户名 niuyuhang）的登录。登录页可按 [SOLO 登录密码保存](solo-login.md) 使用 macOS 钥匙串与 CUA 内存填表；密码未保存、被拒绝、账号不符或需要验证码时保留批次并提示，不猜密码或绕过确认。每次记录真实浏览器观察到的登录结果，运行 `--login-result RECEIPT_JSON`；仅该输出 notify=true 时发送新的登录提示，重复问题保持安静。预检不提前上传，提前半小时的预检结果也不能代替上传时的实际账号确认。认证观察最多有效 5 分钟；正式开始前必须仍然有效。登录恢复后再次 --claim 原批次，并用新 prepare 输出执行 --batch-plan；只能处理返回的本批成员，新增记录留待下一个新批次。
3. 对每条记录，先在我的提交通过原生 SessionID 和 TurnID/PromptID 核对有无远端记录。两者均一致才能认为同一条；打开详情核对全部字段和附件。已有记录保存回执并跳过，内容不一致则保留原记录并报告，不创建副本或自动覆盖。
4. 如果本地状态为 submitting/uncertain，只查远端结果，不再次点击提交。没有明确结果时留在待核对状态。普通 prepared 记录且未找到远端匹配，才填写新表单。相同会话前序记录无法确认已提交时，暂停该会话后续记录，继续其他会话。
5. 读取 packetPath 文件，照 fields 填写表单。User Prompt、五维分数和描述来自本地原始记录，不为了平台查重改写题目或评分。任务类型的 `feature迭代` 对应表单 `Feature迭代`。当前对话轮次排序是数值 1–10，Excel 的第一轮等显示不直接填到数字控件。填写后失焦并读取实际 value；该网站数字控件 fill 后可能显示空值，可使用可见增减按钮调整至目标数值，并再次确认。
6. 轨迹文件只选 packet.attachment.path。CUA 先注册 filechooser 等待并捕获异常，再点击轨迹文件组内的可见选择轨迹文件按钮，使用 chooser.setFiles；隐藏 input 点击无法可靠打开选择器。等上传结束，检查附件名和大小。不能用单份 JSONL 替代完整 ZIP。
7. 核对 23 个必填字段（若平台增减字段，重新按实际页面核对；未知必填字段停止本条，不能编造值）、全部输入、五维评分和附件。提交人、提交时间、质检结果、父记录、审核备注等管理字段由平台维护。项目名称和本地选择序号不提交。
8. 最终点击前运行 `node scripts/solo-ui-queue.mjs --mark-sending TASK_ID:TURN_ID`；它重新确认当前准入、数据和附件未变，并先持久化 submitting。命令失败则不要点击。成功后只点击一次提交并质检。
9. 等待提交回执，打开数据详情，核对平台记录编号、原生 ID、轮次、全部文本、分数和附件。保存私有 JSON 回执后运行 `node scripts/solo-ui-queue.mjs --receipt TASK_ID:TURN_ID RECEIPT_JSON_PATH`。回执格式见下节。网络中断或结果不明时保留 submitting，下次仅查询确认。
10. 平台待返修或废弃的记录已提交，不重新创建；保留理由并通知用户。根据真实轨迹进行评分返修属于独立处理，不删关键词、编造事实或调分来规避质检。不得点击管理员飞书同步、删除、质检覆盖等无关操作。
11. 本批按顺序处理可提交项。长批次至少每 15 分钟用 slot、attemptId 执行 --touch。登录中断时立即停止后续提交，以 waiting_login 和真实 reasonCode 结束本次 attempt，保留成员、已上传回执及 submitting 状态；恢复后只续传该批剩余项。正常结束保存 slot、attemptId、status（completed/blocked/failed）、counts 到私有 run-summary.json，再执行 `node scripts/solo-schedule.mjs --finish .runner/solo-upload/run-summary.json`。附件、题目等非登录拦截用 blocked，不能靠重新登录解除。仅在有新上传、状态变化、失败或需要用户处理时通知。保留 SOLO 标签页作为 handoff/deliverable，维持下次可复用的登录状态。

## 登录与批次命令合同

调度台账为 `.runner/solo-upload/schedule.json`，不含密码、Cookie 或 token。`--login-result` 只接受以下字段；失败观察省略 username/account，并使用 login_required、session_expired、account_mismatch、challenge_required、credentials_rejected 或 unavailable。unavailable 表示网页或登录通道暂不可验证，不当作密码错误。用户名及显示名须从实际页面确认，不从保存密码成功推定。

```json
{
  "status": "authenticated",
  "origin": "https://solo2.jzxhnh.com",
  "username": "niuyuhang",
  "account": "牛宇航",
  "checkedAt": "实际观察时间的 ISO 字符串",
  "source": "browser"
}
```

`--touch` 输入为 `{"slot":"claim 返回的 slot","attemptId":"claim 返回的 attemptId"}`。`--batch-plan` 在上述字段之外接受 planPath，指向刚刚 prepare 保存的私有 JSON。输出 packets/blocked/settled，仅含本批原始成员；原件摘要变化或当前准入失效的记录进入 blocked。已核验回执进入 settled，有未核验编号或 submitting/uncertain 的记录只查询远端详情。查询条目没有 packetPath 时按 key 从私有 packets 目录读取已有包用于核对，不能据此重新提交。原包缺失则保留待核对。

`--finish` 输入示例：

```json
{
  "slot": "claim 返回的 slot",
  "attemptId": "claim 返回的 attemptId",
  "status": "waiting_login",
  "reasonCode": "session_expired",
  "counts": { "uploaded": 2, "existing": 1, "blocked": 0, "uncertain": 1 }
}
```

非 waiting_login 状态不需要 reasonCode。counts 只接受 uploaded、existing、blocked、uncertain 四种非负整数。额外诊断放在独立私有报告，不能混入登录回执，更不能保存凭据。旧 attempt 的 touch/finish 会被拒绝，不能覆盖恢复后的新 attempt。

running 批次不会被自动抢占，租期为 45 分钟。`--due` 返回 active 时不要重新 claim；leaseExpired=false 表示已有执行正在持有该批。leaseExpired=true 仅授权核对原 attempt：先确认前一次浏览器操作已结束，再核对其全部远端回执，不能重发状态不明的提交。确认登录过期时对原 attempt 执行 --finish waiting_login；确认已结束则以 completed/blocked/failed 如实收尾。仍在执行则继续原 attempt 并 --touch。没有充分证据时提示待核对，不能通过改台账或删除运行状态制造新批次。历史版本没有 attemptId 的 running 需要单独人工核对，不自动迁移放行。

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

验证：`node --test tests/solo-upload.test.mjs tests/solo-upload-holds.test.mjs tests/solo-native-attachment.test.mjs`。测试覆盖字段映射、消息 UUID 与原生 PromptID 区分、原生目录完整性、内部证据隔离、原件不变、禁止上传、分页查重、断网与不明确回执、重复启动、资格变化、附件摘要和大小、服务端拒绝、字段回读、浏览器回执、台账锁及会话连续性。

这是本机 Codex 定时任务，需要电脑开机、Codex 运行、本地流水线可访问；自动登录还需要本机钥匙串可读取。复用现有每 15 分钟巡检，调度对齐整点、15 分、半点和 45 分。错过双数整点的新批次窗口不补造批次；已经固定成员且因登录暂停的批次，会在之后的巡检中检查登录，恢复后续传原批，跨时段和跨日也保留同一清单。预检发生在每次上传前半小时，不提前提交。

## 页面上传状态与题目去重（2026-09-10）

标注列表新增独立的质检平台上传状态、平台记录链接、更新时间及原因；按状态筛选在服务器分页之前执行，并和项目、题型、日期及 Excel 次数筛选组合。该状态不加入标准 Excel 表头，也不改变 Excel 下载次数。已提交、质检通过、待返修与禁止上传分别显示，不能用已上传代替质检通过。浏览器台账在准备、发送和回执后同步到受执行器认证保护的 `/api/solo-upload`；`--sync-status` 可补同步，暂时失败时本地回执仍保留，旧快照不得覆盖新状态。

用户明确同意原指定的 8 条旧记录保留实际后台导出方式上传，并要求重新录入已由用户删除的 652；随后追加要求题目内部有话语重复的不能上传。`manual-admissions.json` 只绑定本次固定记录的原字段摘要、逐题措辞审核、证据文件摘要和完整原生附件摘要；不适用于新记录，不伪造原终端收尾。禁止上传标记始终优先，会话缺失前序时继续阻止后续轮次。发送前还必须有前序真实上传回执，不能仅因前序已准备就发送下一轮。

questions7 将题目内部话语重复独立成 redundancy 审核项，并要求逐句新增信息依据 `wordingRequirements` 和重复原文对 `wordingDuplicatePairs`。任一重复或缺少审核均不放行。验收清单放在验收字段，题目末尾不能再次罗列同一动作、条件、结果。已发送原题和轨迹保持原样并标记禁止上传；未发送草稿按新版本重新准备。

679 的平台结果显示非满分点评必须同时包含具体位置、实际行为和客观后果。score-consistency3 保留首次评价的具体性要求，优先用本轮控件、操作及可见现象定位，让非开发者也能理解问题及影响；精确文件路径和行号放在 evidenceRefs，公开点评不要求行号或分档分析。缺少统计时不得虚构耗时、比例、人工误操作或失败测试，不能把只读检查或模型自报写成运行通过。已有记录按冻结源码和原日志补充点评，返修说明继续留空。

2026-09-10 用户说明已人工删除平台旧记录并要求用原始数据重新上传。网页已核实账号列表总数及各阶段均为 0；旧 679、700、702、704、706 回执和完整条目移入本地 replacementHistory 后重新准备。原题、原生 SessionID/PromptID、真实轮次与最终原始轨迹保持一致，附件无替换、无重写；已存在的点评复评版本沿用原证据，历史采集方式与内部审核异议如实保留。正在执行的会话仍等待最终导出，不用中间快照冒充最终文件。
