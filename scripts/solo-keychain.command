#!/bin/zsh
set -eu
SCRIPT_DIR=${0:A:h}
if ! command -v node >/dev/null 2>&1; then
  print '未找到 Node.js，请在已配置 Node 的本机终端运行 scripts/solo-keychain.mjs --save。'
  read '?按回车结束。'
  exit 1
fi
node "$SCRIPT_DIR/solo-keychain.mjs" --save
print '密码已保存到当前用户钥匙串；此窗口可以关闭。'
read '?按回车结束。'
