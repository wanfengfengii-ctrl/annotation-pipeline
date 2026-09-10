import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyJobRelease, jobReleaseProtocol } from './job-release.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function publishJobRelease({ sourceRoot, workRoot, commit }) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('需要已验证的完整提交号');
  const releases = path.join(workRoot, 'releases'),
    root = path.join(releases, 'jobs-' + commit.slice(0, 12));
  mkdirSync(releases, { recursive: true });
  if (!existsSync(root)) {
    mkdirSync(root);
    const archive = execFileSync('git', ['archive', '--format=tar', commit], {
      cwd: sourceRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', root], { input: archive });
    const files = [];
    const add = (file) => {
      const st = lstatSync(file);
      if (st.isSymbolicLink()) throw Error('作业发布源码不能包含符号链接');
      if (st.isDirectory())
        for (const name of readdirSync(file).sort()) add(path.join(file, name));
      else
        files.push({
          path: path.relative(root, file),
          sha256: sha(readFileSync(file)),
        });
    };
    for (const name of ['scripts', 'lib', 'rules', 'package.json'])
      add(path.join(root, name));
    writeFileSync(
      path.join(root, 'job-release.json'),
      JSON.stringify({ protocol: jobReleaseProtocol, commit, files }, null, 2),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(root, 'release.json'),
      JSON.stringify({ commit, createdAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    symlinkSync(
      path.join(sourceRoot, 'node_modules'),
      path.join(root, 'node_modules'),
    );
    symlinkSync(
      path.join(sourceRoot, '.dev.vars'),
      path.join(root, '.dev.vars'),
    );
  }
  const pointer = {
    root,
    manifestSha256: sha(readFileSync(path.join(root, 'job-release.json'))),
  };
  const verified = verifyJobRelease(pointer, workRoot);
  const file = path.join(workRoot, 'job-release-current.json');
  if (existsSync(file))
    writeFileSync(
      path.join(workRoot, 'job-release-previous.json'),
      readFileSync(file),
      { mode: 0o600 },
    );
  writeFileSync(file + '.tmp', JSON.stringify(pointer, null, 2), {
    mode: 0o600,
  });
  renameSync(file + '.tmp', file);
  return verified;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const commit =
    process.argv[2] ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRoot,
      encoding: 'utf8',
    }).trim();
  console.log(
    JSON.stringify(
      publishJobRelease({
        sourceRoot,
        workRoot:
          process.env.RUNNER_WORK_ROOT || path.join(sourceRoot, '.runner'),
        commit,
      }),
      null,
      2,
    ),
  );
}
