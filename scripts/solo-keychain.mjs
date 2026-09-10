import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const source = fileURLToPath(new URL('./solo-keychain.swift', import.meta.url));
const installRoot = path.join(
  os.homedir(),
  'Library/Application Support/Annotation Pipeline/Keychain',
);
export const keychainAppPath = path.join(installRoot, 'SOLO Password.app');
const executable = path.join(keychainAppPath, 'Contents/MacOS/solo-keychain');
const fingerprintPath = path.join(installRoot, 'source.sha256');
const MAX_PASSWORD_BYTES = 4096;

export const SOLO_CREDENTIAL = Object.freeze({
  service: 'annotation-pipeline.solo',
  username: 'niuyuhang',
  origin: 'https://solo2.jzxhnh.com',
});

function assertPrivate(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== os.userInfo().uid ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.mode & 0o077
  )
    throw new Error(
      '凭据助手路径必须由当前用户独占，不能使用共享路径或符号链接',
    );
}

export function buildKeychainHelper() {
  if (os.platform() !== 'darwin')
    throw new Error('SOLO 钥匙串助手仅支持 macOS');
  fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  assertPrivate(installRoot, true);
  for (const directory of [
    keychainAppPath,
    path.join(keychainAppPath, 'Contents'),
    path.dirname(executable),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivate(directory, true);
  }
  const infoPath = path.join(keychainAppPath, 'Contents/Info.plist');
  if (fs.existsSync(infoPath)) assertPrivate(infoPath);
  fs.writeFileSync(
    infoPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.annotationpipeline.solo-keychain</string>
<key>CFBundleName</key><string>SOLO 密码设置</string>
<key>CFBundleDisplayName</key><string>SOLO 密码设置</string>
<key>CFBundleExecutable</key><string>solo-keychain</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>`,
    { mode: 0o600 },
  );
  const fingerprint = createHash('sha256')
    .update(fs.readFileSync(source))
    .digest('hex');
  if (fs.existsSync(executable) && fs.existsSync(fingerprintPath)) {
    assertPrivate(executable);
    assertPrivate(fingerprintPath);
    if (fs.readFileSync(fingerprintPath, 'utf8') === fingerprint)
      return executable;
  }
  const temporary = path.join(installRoot, 'build-' + randomUUID());
  try {
    const result = spawnSync(
      '/usr/bin/xcrun',
      ['swiftc', '-O', source, '-o', temporary],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 120000,
      },
    );
    // Compiler output is not relayed to automation logs. No credential is read
    // or written during compilation, and the source fingerprint is not a secret.
    if (result.status !== 0)
      throw new Error(
        '凭据助手编译失败，请确认本机 Xcode Command Line Tools 可用',
      );
    fs.chmodSync(temporary, 0o700);
    fs.renameSync(temporary, executable);
    fs.writeFileSync(fingerprintPath, fingerprint, { mode: 0o600 });
    fs.chmodSync(fingerprintPath, 0o600);
    return executable;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function helperFailure(stderr) {
  try {
    const value = JSON.parse(stderr);
    const known = new Set([
      'credential_missing',
      'keychain_locked_or_denied',
      'keychain_unavailable',
      'invalid_credential',
      'private_channel_required',
      'credential_channel_closed',
    ]);
    if (known.has(value.error)) {
      const error = new Error('SOLO 凭据尚不可用：' + value.error);
      error.code = value.error;
      return error;
    }
  } catch {}
  return new Error('SOLO 凭据助手未完成操作');
}

export function keychainStatus() {
  const result = spawnSync(buildKeychainHelper(), ['--status'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.status !== 0) throw helperFailure(result.stderr);
  const value = JSON.parse(result.stdout);
  if (typeof value.stored !== 'boolean') throw new Error('凭据状态回执无效');
  return { stored: value.stored };
}

// This callback is for the separately implemented, user-authorized login
// transport. It must consume the Buffer in memory, without logging it, writing
// it to a file, sending it to a model or embedding plaintext in tool source.
// Returning a password string defeats the scope cleanup; never do so.
export async function withSoloCredential(consume) {
  if (typeof consume !== 'function')
    throw new TypeError('需要内存凭据使用回调');
  const helper = buildKeychainHelper();
  const password = await new Promise((resolve, reject) => {
    const child = spawn(helper, ['--read-for-login'], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let failure = false;
    let stderr = '';
    const timer = setTimeout(() => {
      failure = true;
      child.kill('SIGTERM');
    }, 15000);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.stdio[3].on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes >= MAX_PASSWORD_BYTES) {
        failure = true;
        chunk.fill(0);
        child.kill('SIGTERM');
      } else chunks.push(chunk);
    });
    child.on('error', () => {
      failure = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0 || bytes === 0) {
        chunks.forEach((chunk) => chunk.fill(0));
        reject(helperFailure(stderr));
        return;
      }
      const result = Buffer.concat(chunks);
      chunks.forEach((chunk) => chunk.fill(0));
      resolve(result);
    });
  });
  try {
    return await consume({ ...SOLO_CREDENTIAL, password });
  } finally {
    password.fill(0);
  }
}

export async function main(action) {
  if (action === '--build')
    return {
      ready: Boolean(buildKeychainHelper()),
      appPath: keychainAppPath,
    };
  if (action === '--status') return keychainStatus();
  if (action === '--save') {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        '请在本机交互终端运行 --save，密码不能通过命令参数或管道传入',
      );
    const result = spawnSync(buildKeychainHelper(), ['--save'], {
      stdio: 'inherit',
    });
    if (result.status !== 0)
      throw new Error('密码未保存，请按终端提示处理后重新运行');
    return undefined;
  }
  throw new Error(
    '用法：node scripts/solo-keychain.mjs --save | --status | --build；密码不要写入命令参数',
  );
}

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  Promise.resolve()
    .then(() => {
      if (process.argv.length !== 3)
        throw new Error('只接受 --save、--status 或 --build，不接受密码参数');
      return main(process.argv[2]);
    })
    .then((value) => {
      if (value) console.log(JSON.stringify(value));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
