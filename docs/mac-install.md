# 在另一台 Mac 安装

此仓库部署的是同一套流水线源码，新电脑使用独立数据库和作业目录。当前验证范围为 Apple Silicon（M1/M2/M3/M4 等）Mac；固定基础镜像是 ARM64，Intel Mac 尚未验证。不会自动修改已确认的模型、网关和 1000000 上下文配置。

## 1. 准备本机依赖和登录

- 安装 Xcode Command Line Tools（`xcode-select --install`）、ARM64 Node.js 22.13 或更新版本、Git、Python 3、GitHub CLI、Codex CLI 和 Docker Desktop。
- 在 Terminal 中运行 `codex login`、`gh auth login`，登录自己的账号。GitHub 账号须有本仓库读取权限及创建私有初始代码快照仓库的权限。
- 配置本机 `~/.claude/settings.json`，在 `env.ANTHROPIC_AUTH_TOKEN` 保存已授权的服务认证。使用项目方已确认的完整配置；不要把真实密钥写进 Git、命令历史或聊天。安装程序只检查认证是否存在，不打印内容，不改模型和网关；实际 Claude 运行在固定镜像内，宿主机无需再安装一份 Claude CLI。
- 启动 Docker Desktop，等待引擎可用。将克隆目录允许用于 Docker 文件共享。在 macOS 首次提示时允许启动流水线的应用控制 Terminal，并保持桌面登录和 Terminal 可见。

Codex CLI 使用新电脑自己的配置和登录态。Git 克隆不会同步原 Mac 的 Codex/Claude/GitHub 登录信息。

## 2. 克隆和安装

```sh
gh repo clone wanfengfengii-ctrl/annotation-pipeline
cd annotation-pipeline
npm ci
npm run setup:mac
```

安装脚本检查依赖和登录，生成仅当前用户可读写的 `.dev.vars`，应用所有数据库迁移，构建 `annotation-pipeline/claude-code:2.1.266-webdeps-cache2-20260910`，最后构建页面。Dockerfile 固定基础摘要、Node 22.22.1 和 Claude 2.1.266，保留现有镜像的入口、模型、网关和上下文；构建不会发送模型题目。

需要访问 npm 和基础镜像仓库，首次下载耗时取决于网络。失败修正后可重跑，已有密钥保留，成功迁移不会重复执行。单独检查安装环境可运行 `npm run check:mac`；它不会启动作业或发送模型请求。模型连通性及实际 Terminal 权限仍需通过首道作业预检确认。

## 3. 启动

在克隆目录打开两个 Terminal 窗口：

```sh
# 窗口一：页面和 API，数据库使用此克隆目录
API_WORK_ROOT="$PWD" npm run api:local
```

```sh
# 窗口二：流水线执行器
npm run runner
```

打开 http://localhost:3000，在调度设置填写新电脑实际参考仓库的绝对路径，再创建任务或启用自动补充。`API_WORK_ROOT` 必须是绝对路径；不要照抄旧电脑的路径。页面服务只监听本机回环地址。

并发会根据当前机器 CPU、内存和 Docker 可用资源采样，页面中的并发数是上限。轻量项目可使用 `RUNNER_RESOURCE_PROFILE=lightweight npm run runner`；每容器预算为 2 核 / 1.5 GiB，保存后后续启动继续沿用。资源不足时等待空位，不保证每台电脑都能同时运行三个项目。

独立题打开新 Terminal 和容器，Bug 在原会话继续。原始轨迹、评分、归档与上传回执保存在本机 `.runner`，数据库保存在 `.wrangler/state`。这些数据不进入 Git。新机空库也从 `nyh-00001` 编号，各机数据与编号目前独立；快照仓库按任务 UUID 区分。

## 4. SOLO 上传与定时登录

当前上传模块沿用本人账号 `niuyuhang / 牛宇航`。在新 Mac 运行下面命令，在弹窗中重新保存密码：

```sh
node scripts/solo-keychain.mjs --build
open "$HOME/Library/Application Support/Annotation Pipeline/Keychain/SOLO Password.app"
```

具体命令和登录核验见 [密码与登录](solo-login.md) 和 [上传调度](solo-upload.md)。定时登录、浏览器上传由 Codex 桌面任务和浏览器控制插件执行，需要在新 Mac 单独配置。仅克隆源码和启动 runner 不会安装原电脑的定时任务。先确认账号登录和原始附件提交链路，再启用新电脑的上传定时任务。

## 5. 更新与迁移范围

新安装使用迁移登记表，`npm run db:local` 可重复执行，只应用未执行的迁移。旧版本曾手动逐文件建表的数据库没有登记表，脚本会拒绝再次初始化；先备份 `.wrangler/state`，核对已经存在的表、索引和触发器，再只补缺失迁移，不能删除数据库来消除错误。

更新源码前先暂停自动补充，等待现有会话完成并归档，停止该机 runner 和 API。然后：

```sh
git pull --ff-only
npm ci
npm run setup:mac
```

再按上面的双窗口方式启动。不要跨 Mac 复制运行中的 `.runner` 来继续旧会话：目录中的绝对路径、容器 ID、Terminal、进程和控制通道属于原电脑。历史数据另做备份迁移，Git 部署不会搬走旧电脑的任务或自动合并各机数据。

`.openai/hosting.json` 保留原云页面的项目绑定。本说明只启动 Mac 本地服务，运行构建不会发布或覆盖云页面。

本机效率改进及环境预装见 [流水线效率改进](throughput.md)。
