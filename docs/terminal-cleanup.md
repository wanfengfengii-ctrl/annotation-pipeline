# Mac Terminal 完成页面自动关闭

运行 `node scripts/terminal-cleanup.mjs --install` 安装当前用户的 LaunchAgent。
每 10 秒检查一次，登录后自动启用；重复安装同一工作区不会重复创建任务。
它独立于流水线巡检频率和 runner，不需要重启正在执行的 Claude。

仅关闭同时满足以下条件的流水线终端页面：

- 该题 terminal/state.json 记录 exited，且桥接进程和 docker 客户端均已退出。
- launch.json 与退出记录的 runId、路径一致。
- 本题 finalization.json 绑定相同的启动、容器和最终导出，状态为 removed。
- 重新核对最终原生目录的完整文件集合、大小和 SHA-256，与清单及回执一致。
- Terminal 当前页面没有运行中的进程，末尾为 [进程已完成] 或 [Process completed]。
- 终端历史包含这一题的完整启动路径和桥接程序的结束提示。
- 关闭前再次核对窗口内所有标签页的状态。

流水线每题通过 question.command 启动独立窗口。若手动合并标签页，
只要窗口中还有运行中或不属于流水线的标签页，就保留该窗口，并记录 deferred。
当前 Terminal 的脚本接口不支持关闭单个标签页（返回 -1708），因此不用切换焦点和模拟快捷键关闭。

TTY 会复用，因此不能只按 TTY 或完成字样批量关闭。
Claude 单轮答完仍可继续 Bug 修复，不等于整个终端进程已退出。
此功能不发送按键、不结束进程、不修改原始轨迹、退出回执或容器。
退出码非零的完成页面只有在上述最终导出与删除核验通过后才可关闭，错误和原始日志仍保留在原目录。

新终端协议在 Claude 和容器 shell 退出后保留原 Mac Terminal，由同一 TTY
执行最终两次 `docker cp` 和 `docker rm`。最终完成回执验证通过后桥接程序才退出，
再由清理任务关窗。失败、未知结果或证据被修改时保留窗口；每个实际关闭记录附带独立的 closedAt。
升级前已经启动的旧桥接无法原地换程序，收尾回执明确标为 legacy-runner-migration；
新建题目使用新协议，不能把历史会话标作新协议执行。

`node scripts/terminal-cleanup.mjs --dry-run` 只检查匹配，不关闭。
最近检查和关闭记录见 `.runner/terminal-cleanup.json`，不记录终端正文。
可用 `--root /绝对路径/.runner` 指定另一个工作目录。
安装命令返回 LaunchAgent 的 label 和 plistPath；停用时执行
`launchctl bootout gui/$(id -u)/返回的label` 并删除对应 plist。
