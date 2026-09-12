import fs from 'node:fs';
import path from 'node:path';
import { operationsSnapshot } from '../lib/operations-status.mjs';
import { readJSON, localAPI, saveJSON } from './self-heal-io.mjs';
import { repairMetrics } from './repair-metrics.mjs';
export async function reportOperations(root, state, snapshot, config) {
  const folder = path.join(root, '.runner');
  const boundary = readJSON(path.join(folder, 'boundary-release.json'));
  const pointer = readJSON(path.join(folder, 'job-release-current.json'));
  const manifest = pointer
    ? readJSON(path.join(pointer.root, 'job-release.json'))
    : null;
  let value = operationsSnapshot({
    tasks: snapshot.tasks,
    state,
    config,
    boundary,
    currentRevision: manifest?.commit,
    metrics: repairMetrics(root, state),
    throughput: readJSON(path.join(folder, 'throughput/summary.json')),
  });
  if (state.health?.observationFailed) {
    const previous = readJSON(path.join(folder, 'operations.json'));
    value = {
      ...(previous || value),
      reportedAt: new Date().toISOString(),
      observationError: '实时读取失败，保留上次结果等待重新连接',
    };
  }
  saveJSON(path.join(folder, 'operations.json'), value);
  const token =
    process.env.RUNNER_TOKEN ||
    fs
      .readFileSync(path.join(root, '.dev.vars'), 'utf8')
      .match(/^RUNNER_TOKEN=(.+)$/m)?.[1];
  if (!token) throw Error('缺少本机状态报告凭据');
  await localAPI('/api/runner', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'operations', value }),
  });
}
