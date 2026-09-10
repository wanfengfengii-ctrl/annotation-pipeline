import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeTerminalFinalization } from '../../scripts/terminal-finalization.mjs';

export function finalizationFixture(
  taskDir,
  terminal,
  questionId = 'question',
) {
  const directory = path.join(
    taskDir,
    questionId + '.final.traces-00000000-0000-4000-8000-000000000000',
  );
  const root = path.join(directory, 'projects');
  mkdirSync(path.join(root, '-workspace'), { recursive: true });
  const content = '{"type":"user","message":"test"}\n';
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const nativeFile = path.join(root, '-workspace/session.jsonl');
  writeFileSync(nativeFile, content);
  const files = [
    {
      name: '-workspace/session.jsonl',
      bytes: Buffer.byteLength(content),
      sha256: digest(content),
    },
  ];
  const containerId = 'a'.repeat(64);
  const manifestPath = path.join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ containerId, files }));
  const state = {
    taskId: path.basename(taskDir),
    questionId,
    terminal,
    containerId,
    status: 'removed',
    finishedAt: new Date().toISOString(),
    finalCommandTransport: 'original-mac-terminal',
    traceExport: {
      verified: true,
      path: root,
      manifestPath,
      files: files.length,
      sha256: digest(JSON.stringify(files)),
      exportKind: 'final',
    },
  };
  const receipt = writeTerminalFinalization(state, taskDir);
  return {
    state,
    receipt,
    nativeFile,
    receiptPath: path.join(
      taskDir,
      'questions',
      questionId,
      'terminal/finalization.json',
    ),
  };
}
