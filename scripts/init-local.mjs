import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.dev.vars')) {
  writeFileSync(
    '.dev.vars',
    'RUNNER_TOKEN=' + randomBytes(32).toString('hex') + '\n',
    { mode: 0o600 },
  );
  console.log('本机执行器密钥已生成。');
} else console.log('保留现有本机配置。');
