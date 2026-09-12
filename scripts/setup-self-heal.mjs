import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selfHealDefaults } from '../lib/self-heal.mjs';
import { readJSON, saveJSON } from './self-heal-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.annotation-pipeline.self-heal';
const escape = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export function launchAgentPlist({ root, node, searchPath }) {
  const string = (s) => '<string>' + escape(s) + '</string>';
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key>${string(label)}<key>ProgramArguments</key><array>${[node, path.join(root, 'scripts/self-heal.mjs'), '--daemon'].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(root)}<key>EnvironmentVariables</key><dict><key>PATH</key>${string(searchPath)}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key>${string(path.join(root, '.runner/self-heal/daemon.log'))}<key>StandardErrorPath</key>${string(path.join(root, '.runner/self-heal/daemon.log'))}
</dict></plist>`;
}
export function installSelfHeal() {
  if (process.platform !== 'darwin') throw Error('此安装入口用于当前 Mac');
  const dir = path.join(root, '.runner/self-heal');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configFile = path.join(dir, 'config.json');
  if (!readJSON(configFile))
    saveJSON(configFile, {
      ...selfHealDefaults,
      enabled: true,
      repairEnabled: true,
    });
  const file = path.join(
    os.homedir(),
    'Library/LaunchAgents',
    label + '.plist',
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = launchAgentPlist({
    root,
    node: process.execPath,
    searchPath: process.env.PATH,
  });
  const domain = 'gui/' + process.getuid(),
    service = domain + '/' + label;
  let running = false;
  try {
    execFileSync('launchctl', ['print', service], { stdio: 'ignore' });
    running = true;
  } catch {}
  if (running) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
      throw Error('已有守护配置不同，先完成原进程交接再更新');
    return { installed: true, alreadyRunning: true, label };
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  execFileSync('plutil', ['-lint', file], { stdio: 'ignore' });
  execFileSync('launchctl', ['bootstrap', domain, file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { installed: true, label, plist: file };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] !== '--install')
    throw Error('使用 --install 安装并启动后台自愈');
  console.log(JSON.stringify(installSelfHeal()));
}
