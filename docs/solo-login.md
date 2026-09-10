# SOLO 登录密码保存

密码保存在这台 Mac 当前用户的默认本地钥匙串，服务名称为 `annotation-pipeline.solo`，账号为 `niuyuhang`，对应网站为 `https://solo2.jzxhnh.com`。可以在系统“钥匙串访问”中搜索服务名称查看或删除该条目。通常位于登录钥匙串，具体取决于用户的默认钥匙串设置。

打开本机 `~/Library/Application Support/Annotation Pipeline/Keychain/SOLO Password.app`，在弹窗的“SOLO 密码”和“确认密码”中输入相同密码，点击“保存”。密码框隐藏输入；点击取消不会写入钥匙串。界面固定显示 `solo2.jzxhnh.com` 和账号 `niuyuhang`。Codex 可以通过 CUA 的 `cua.getApp()` 使用这个完整路径打开弹窗，由用户本人输入。

命令行兼容入口仍保留，需要时在本机交互终端进入项目运行：

```sh
node scripts/solo-keychain.mjs --save
```

密码不要写进命令参数，也不要发送到聊天。再次保存会更新同一服务、同一账号的密码。保存过程只使用 macOS Security API，不连接 SOLO，因此“保存成功”不表示网站已确认密码正确。系统要求钥匙串授权时，核对访问程序为本助手；无需允许全部应用访问。

查看有无已保存凭据：

```sh
node scripts/solo-keychain.mjs --status
```

正常输出只有 `{"stored":true}` 或 `{"stored":false}`。钥匙串不可访问会返回错误，不把无法读取误报为未保存，也不弹出无人值守的解锁窗口。可以用 `--build` 只编译助手，不访问钥匙串。

首次运行会把编译后的助手安装为上述 `SOLO Password.app`，GUI 保存和自动读取使用同一个稳定路径的二进制；安装目录只有应用和源码摘要，不存密码。密码不进入项目配置、环境变量、台账、日志或 Git。助手使用默认应用访问控制，不加入浏览器、终端或其他程序，也不设置允许全部应用读取的权限。编译产物更新后，macOS 可重新要求本机确认该助手的访问。

## 自动登录接入

用户已授权 SOLO 定时自动登录。`withSoloCredential(consume)` 仅向登录模块提供内存回调：固定账号、目标网站和 `Buffer` 类型密码。Swift 助手通过专用继承管道传回密码，常规输出不包含密码，回调结束后清零可控的 Buffer。调用者不得记录、序列化、返回密码或把明文写入工具调用的源文本、模型上下文、命令参数、文件。Swift 和 JavaScript 运行时内部复制的内存不能保证全部主动清零。

`solo-browser-login.mjs` 已将内存回调接到 CUA 浏览器填表。定时任务先读取当前登录页面，为同一个标签的用户名框、密码框和登录按钮建立实际观察到的 locator，再在 CUA JavaScript 会话中运行以下调用。变量必须来自当前页面，不能照抄固定序号或猜控件。适配器反复核对准确的 HTTPS 域名和密码框类型；只填写一次并点击一次，不读取 Cookie，也不使用另一个浏览器驱动。密码不会出现在这段工具调用源文本或返回值中。

```js
// projectRoot 使用这台 Mac 实际克隆目录的绝对路径。
const { pathToFileURL } = await import('node:url');
const { submitSoloLogin } =
  await import(pathToFileURL(projectRoot + '/scripts/solo-browser-login.mjs').href);
try {
  nodeRepl.write(
    await submitSoloLogin({
      tab: soloTab,
      usernameField,
      passwordField,
      submitButton,
    }),
  );
} catch (error) {
  nodeRepl.write({ loginError: error.code });
}
```

返回 verification_required 只表示登录已提交，随后必须通过 CUA 读取页面确认牛宇航 / niuyuhang，再记录 authenticated。不要截图或读取密码框 value；密码仍留在表单时避免输出整个表单快照，可只检查当前 URL 与已观察的账号、错误提示等非密码控件。login_submission_uncertain 表示点击结果不明，只观察结果，不能立即再次提交。

未保存、钥匙串锁定或未授权时保留批次并提示本机处理。验证码由用户处理。网站明确拒绝密码时记录 credentials_rejected，之后仅观察是否恢复登录；直到用户更正密码并告知恢复，或自己登录成功，不能每半小时重复试同一个错误密码。账号不符时不自动退出或切换现有账号。状态变化提示一次，同一问题保持安静。登录恢复后的批次命令见 [SOLO 每两小时上传](solo-upload.md)。

本次验证包括 Swift 编译、凭据接口与参数拦截、登录适配器模拟测试，以及 CUA 中实际加载模块、编译和只查询保存状态；没有保存、覆盖或读取用户的真实密码。真实密码登录仍需用户先完成本机保存，不能把这些测试当作网站已确认密码正确。

## 原生 API 依据

使用 `SecItemAdd`、`SecItemUpdate`、`SecItemCopyMatching` 管理凭据；命令行助手采用 macOS 本地钥匙串，不引入共享访问组或 iCloud 同步。Apple 说明 macOS 默认本地钥匙串、数据保护钥匙串及命令行签名要求不同，详见 [TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)。默认限制性访问只信任创建条目的应用，见 [SecAccessCreate](<https://developer.apple.com/documentation/security/secaccesscreate(_:_:_:)>)。无人值守的查询临时禁止系统交互并恢复原设置，见 [SecKeychainSetUserInteractionAllowed](<https://developer.apple.com/documentation/security/seckeychainsetuserinteractionallowed(_:)>)。
