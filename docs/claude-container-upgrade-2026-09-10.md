# 作业容器 Claude 升级

2026-09-10 用户确认将作业容器中的 Claude 升级到 Mac 当前安装的 2.1.266。这是对原 Mac 说明文档固定镜像的明确配置覆盖，新镜像不再宣称使用原文同一 tag。历史任务和存活会话继续使用原来的镜像、真实 CLI 版本和轨迹；新独立题目选择新镜像。

- 新镜像：`annotation-pipeline/claude-code:2.1.266-20260910`，本机构建，不发布到公共仓库。
- 基础镜像：`adminfather/benzhi-claude-code:20260909-isolated-git`，摘要 `sha256:f77014d9e56cd3db2ac96627a286814cb1aa9f0b4bb807bea98a01383c9bc4d8`。
- Claude：官方 npm 包 `@anthropic-ai/claude-code@2.1.266`，精确版本安装。
- Node.js：22.22.1，来自锁定摘要的官方 bookworm-slim 镜像。新 Claude npm 包声明 Node.js >=22，旧镜像的 Node.js 20 一并升级以满足要求。
- 原入口脚本、非 root 用户、空工作区启动规则、模型、网关、1,000,000 上下文和免审批配置全部保留。

构建命令：

```sh
docker build --pull=false --platform linux/arm64 --tag annotation-pipeline/claude-code:2.1.266-20260910 docker/claude-2.1.266
```

Dockerfile 的构建上下文只有 Dockerfile 和 .dockerignore，不包含工作区、轨迹或认证文件；入口脚本 SHA-256 在构建时验证。基础与 Node 镜像锁定摘要，避免同名 tag 变动。构建过程不启动 Claude 或发送模型请求。

`resolveContainerImage` 检查派生镜像的基础摘要、CLI/Node 版本标签和入口配置。此本地镜像没有 registry RepoDigest，使用 Docker 不可变 image ID 同时生成快照和启动容器，避免捏造公开仓库摘要。`validDockerSnapshot` 兼容旧镜像快照，使旧记录和同一会话的 Bug 后续仍可正常完成。正式任务的 Harness 版本继续读取原始轨迹，不能用宿主或配置版本覆盖。

2026-09-10 本机验证结果：

- 新 image ID 为 `sha256:6d17799e4c045d390bf7dd24b6a2d00084a7f69af099af84030095886c2f6191`，ARM64。
- 镜像实测 Claude 2.1.266、Node 22.22.1，UID 1000，初始工作区为空；Config.Env、Entrypoint、Cmd、User、WorkingDir 与基础镜像一致。
- 独立可见 Mac Terminal 显示 2.1.266，免审批预检通过，max context tokens=1000000；没有发送题目或模型请求。
- 经同一原终端正常退出，完成最终完整目录导出、摘要校验、容器删除及终端完成回执。空轨迹仅用于安装冒烟验证，不进入业务数据、评分或 SOLO 上传队列。
- 验证文件位于 `.runner/claude-upgrade/image-check.json` 和 `terminal-check.json`。

安装与版本验证方式参考 [Claude Code 官方安装文档](https://code.claude.com/docs/en/setup)。服务部署时 API 和 Runner 必须都使用支持新旧快照的版本；不能只切换 Runner，否则旧 API 会拒绝新快照。
