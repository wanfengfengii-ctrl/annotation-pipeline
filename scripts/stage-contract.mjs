import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkpointDigest } from './stage-checkpoint.mjs';

const common = ['scripts/codex-stages.mjs', 'lib/writing-style.mjs'];
const policy = [
  'lib/task-policy.mjs',
  'rules/prohibited-tasks.json',
  'rules/difficulty.json',
  'rules/question-writing.json',
  'lib/question-writing.mjs',
  'lib/question-revision.mjs',
  'lib/question-history.mjs',
];
const scoring = [
  'lib/workflow.mjs',
  'rules/workflow.json',
  'lib/score-consistency.mjs',
  'lib/score-description-context.mjs',
  'scripts/evidence.mjs',
  'scripts/project-regression-context.mjs',
  'lib/runtime-verification.mjs',
];
export function stageContractDigest(root, stage) {
  const files = [
    ...common,
    ...(stage === 'policy' ? policy : scoring),
    ...(stage === 'delivery' ? ['scripts/submitted-policy.mjs'] : []),
  ];
  return checkpointDigest(
    files.map((file) => [file, readFileSync(path.join(root, file), 'utf8')]),
  );
}
