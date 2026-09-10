import {
  readFileSync,
  existsSync,
  realpathSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const jobReleaseProtocol = '2026-09-10.executor1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Only a previously frozen, verified release may replace code for future claims.
// Existing executors retain their imported module graph and container owner.
export function verifyJobRelease(pointer, workRoot) {
  const releases = realpathSync(path.join(workRoot, 'releases'));
  const root = realpathSync(pointer.root);
  if (
    path.dirname(root) !== releases ||
    lstatSync(pointer.root).isSymbolicLink()
  )
    throw Error('作业版本必须位于本机冻结版本目录');
  const bytes = readFileSync(path.join(root, 'job-release.json'));
  if (hash(bytes) !== pointer.manifestSha256)
    throw Error('作业版本清单摘要不符');
  const manifest = JSON.parse(bytes);
  if (
    manifest.protocol !== jobReleaseProtocol ||
    !/^[a-f0-9]{40}$/.test(manifest.commit || '') ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw Error('作业版本协议不兼容');
  const names = new Set();
  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      (!/^(scripts|lib|rules)\//.test(file.path) &&
        file.path !== 'package.json') ||
      file.path.split('/').some((p) => !p || p === '.' || p === '..') ||
      names.has(file.path)
    )
      throw Error('作业版本文件清单无效');
    names.add(file.path);
    const target = path.join(root, file.path);
    if (
      realpathSync(target) !== target ||
      !lstatSync(target).isFile() ||
      hash(readFileSync(target)) !== file.sha256
    )
      throw Error('冻结作业代码已变化');
  }
  const actual = [];
  const walk = (folder) => {
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder)) {
      const file = path.join(folder, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw Error('冻结作业代码不能包含符号链接');
      if (stat.isDirectory()) walk(file);
      else actual.push(path.relative(root, file));
    }
  };
  for (const folder of ['scripts', 'lib', 'rules'])
    walk(path.join(root, folder));
  if (actual.some((file) => !names.has(file)))
    throw Error('作业版本存在未验证源码');
  if (
    !names.has('scripts/job-executor.mjs') ||
    !names.has('scripts/docker-runtime.mjs') ||
    !names.has('package.json')
  )
    throw Error('作业版本入口不完整');
  return {
    root,
    commit: manifest.commit,
    manifestSha256: pointer.manifestSha256,
  };
}

export async function loadJobRelease(workRoot, fallback) {
  const file = path.join(workRoot, 'job-release-current.json');
  if (!existsSync(file)) return fallback;
  const release = verifyJobRelease(
    JSON.parse(readFileSync(file, 'utf8')),
    workRoot,
  );
  const executorModule = await import(
    pathToFileURL(path.join(release.root, 'scripts/job-executor.mjs')).href
  );
  if (
    executorModule.executorProtocolVersion !== jobReleaseProtocol ||
    typeof executorModule.createJobExecutor !== 'function' ||
    typeof executorModule.createJobRuntime !== 'function'
  )
    throw Error('作业执行入口不兼容');
  return { ...release, module: executorModule };
}
