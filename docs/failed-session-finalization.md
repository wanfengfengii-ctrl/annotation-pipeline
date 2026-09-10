# 人工指定失败会话收尾

同会话首题已评分、后续轮次以明确的服务端错误结束时，默认调度仍保留会话供核对。人工决定结束这一会话后，可使用专用工具完成原终端收尾，使已完成题目的最终提交队列继续运行。

先以真实 task/turn ID 预检，不加 `--apply` 不写入状态：

```sh
node scripts/finalize-failed-session.mjs --task TASK_UUID --turn TURN_UUID
```

核对预检结果后，添加 `--apply` 执行。工具只处理最新失败轮；要求原生轨迹包含 `server_error` 和完整结束标记、本轮无工具调用、末尾无新增交互、无待发送或执行中的任务，并核验失败结果及原生目录摘要。完成标记不代表执行成功。

退出前每次输入继续实时检查原会话。退出、最终两份目录导出和清理均使用原 Mac 终端；两份原生轨迹一致后才删除对应容器。失败轮原回执与 `success: false` 不变，不重新发送题目、不改评分、不关闭整个项目。

收尾证据写入 `.runner/failed-session-finalization/`，随后由已有最终提交队列生成已评分题目的提交元数据。无评分归档的失败轮不会伪造归档或进入合格数据。正在执行、结束状态不明、权限异常、有工具调用或身份不一致时继续保留容器。

验证：`node --test tests/failed-session-finalization.test.mjs tests/terminal-final-export.test.mjs tests/final-submissions.test.mjs tests/container.test.mjs`。

工程包中的 SQLite 文件通过独立只读扫描处理：仅支持有界的 UTF-8 普通表，检查完整性、列与行值、配置键值及原始页中的常见敏感内容；原文件字节不变。虚拟表、生成列、未知二进制、超限或敏感命中继续待审。生成包和验包均重新扫描，不靠文件扩展名放行。旧待审包保留，新核验包使用独立文件和回执后再回填元数据。
