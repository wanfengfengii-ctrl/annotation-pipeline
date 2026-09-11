import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyRuntimeSuitePatch } from '../lib/runtime-suite.mjs';
import {
  saveRuntimeSuite,
  readRuntimeSuite,
} from '../scripts/project-runtime-suite.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const limits = {
  totalTimeoutSeconds: 1800,
  stepTimeoutSeconds: 600,
  maxChecks: 64,
};
const check = (id, kind = 'acceptance') => ({
  id,
  kind,
  command: 'echo ' + id,
  requirement: 'original ' + id,
  expected: 'expected ' + id,
  codeEvidence: 'app.js:1',
  timeoutSeconds: 10,
});
test('project library reuses exact scripts, adds Feature checks, and retains original Bug reproduction', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-suite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskId = path.basename(dir),
    projectDirectory = 'nyh-00001',
    imageId = 'sha256:' + 'a'.repeat(64);
  const report = (turnId, plan) => {
    const file = path.join(dir, turnId + '.report.json'),
      value = {
        executed: true,
        status: 'bugs',
        imageId,
        plan: { value: plan },
      };
    fs.writeFileSync(file, JSON.stringify(value));
    return {
      ...value,
      reportPath: file,
      reportSha256: hash(fs.readFileSync(file)),
    };
  };
  const first = report('first', {
    summary: 'base',
    limits,
    checks: [check('acceptance'), check('repro', 'reproduction')],
  });
  const receipt = saveRuntimeSuite({
    dir,
    taskId,
    turnId: 'first',
    projectDirectory,
    prompt: 'first prompt',
    acceptance: ['first'],
    report: first,
  });
  const base = {
    ...readRuntimeSuite(receipt, { dir, taskId, projectDirectory, imageId }),
    limits,
    prompt: 'add feature',
    category: 'Feature 迭代',
    questionCheckIds: [],
  };
  const patch = {
    summary: 'feature',
    reuse: base.plan.checks.map((c) => ({
      id: c.id,
      codeEvidence: 'app.js:2',
      timeoutSeconds: 20,
    })),
    replace: [],
    add: [check('new-feature')],
  };
  const plan = applyRuntimeSuitePatch(base, patch);
  assert.equal(plan.checks[0].command, base.plan.checks[0].command);
  assert.equal(plan.checks[1].kind, 'reproduction');
  assert.deepEqual(plan.suite.currentCheckIds, ['new-feature']);
  assert.deepEqual(plan.suite.inheritedCheckIds, ['acceptance', 'repro']);
  assert.throws(
    () =>
      applyRuntimeSuitePatch(base, { ...patch, reuse: patch.reuse.slice(1) }),
    /遗漏/,
  );
  assert.throws(
    () => applyRuntimeSuitePatch(base, { ...patch, add: [] }),
    /缺少本题/,
  );
  const next = report('next', plan),
    nextReceipt = saveRuntimeSuite({
      dir,
      taskId,
      turnId: 'next',
      projectDirectory,
      prompt: 'add feature',
      acceptance: ['feature'],
      report: next,
    });
  const bugBase = {
    ...readRuntimeSuite(nextReceipt, {
      dir,
      taskId,
      projectDirectory,
      imageId,
    }),
    limits,
    prompt: 'fix repro',
    category: 'Bug 修复',
    questionCheckIds: ['repro'],
  };
  const bug = applyRuntimeSuitePatch(bugBase, {
    summary: 'original regression',
    reuse: bugBase.plan.checks.map((c) => ({
      id: c.id,
      codeEvidence: c.codeEvidence,
      timeoutSeconds: c.timeoutSeconds,
    })),
    replace: [],
    add: [],
  });
  assert.deepEqual(bug.suite.currentCheckIds, ['repro']);
  assert.equal(bug.checks.length, 3);
  assert.equal(bugBase.origins.repro, 'first');
  assert.equal(bugBase.origins['new-feature'], 'next');
  const changed = { ...base.plan.checks[0], expected: 'easier' };
  assert.throws(
    () =>
      applyRuntimeSuitePatch(
        { ...base, category: 'Bug 修复' },
        {
          ...patch,
          reuse: patch.reuse.slice(1),
          replace: [
            { reason: 'fake pass', requirementChangeQuote: '', check: changed },
          ],
        },
      ),
    /原用例/,
  );
  assert.equal(
    saveRuntimeSuite({
      dir,
      taskId,
      turnId: 'bad',
      report: { ...first, status: 'blocked' },
    }),
    null,
  );
  assert.deepEqual(
    saveRuntimeSuite({
      dir,
      taskId,
      turnId: 'next',
      projectDirectory,
      prompt: 'add feature',
      acceptance: ['feature'],
      report: next,
    }),
    nextReceipt,
  );
  fs.appendFileSync(base.scripts.acceptance.path, 'changed');
  assert.throws(
    () => readRuntimeSuite(receipt, { dir, taskId, projectDirectory, imageId }),
    /摘要不符/,
  );
});
