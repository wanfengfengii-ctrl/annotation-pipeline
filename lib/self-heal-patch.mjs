import fs from 'node:fs';
import path from 'node:path';
import { digest } from './self-heal.mjs';

// The maintenance worker cannot rewrite its own policy, models, raw data,
// dependency manifests or task rules as a way of making a failure disappear.
export function repairPathAllowed(p) {
  return (
    typeof p === 'string' &&
    /^(scripts|lib|app|components|tests)\/[A-Za-z0-9_./[\]-]+\.(mjs|cjs|ts|tsx|js)$/.test(
      p,
    ) &&
    !p.split('/').some((s) => !s || s === '.' || s === '..') &&
    !/self-heal|solo-.*(?:hold|admission|native)|(?:permission-audit|submission-policy|task-policy|question-writing|workflow|container-policy)\./.test(
      p,
    )
  );
}
export function materializeRepair(root, proposal) {
  if (!Array.isArray(proposal.files) || proposal.files.length > 12)
    throw Error('修复文件清单无效');
  const files = proposal.files.map((f) => {
    if (!repairPathAllowed(f.path)) throw Error('修复路径不允许：' + f.path);
    const target = path.join(root, f.path);
    for (let p = target; p !== root; p = path.dirname(p))
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())
        throw Error('修复路径不能经过符号链接');
    const before = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8')
      : null;
    if ((before === null ? null : digest(before)) !== f.beforeSha256)
      throw Error('修复基线不一致：' + f.path);
    if (typeof f.content === 'string') {
      if (f.edits?.length) throw Error('完整文件与局部修改不能混用');
      return { path: f.path, beforeSha256: f.beforeSha256, content: f.content };
    }
    if (
      before === null ||
      !Array.isArray(f.edits) ||
      !f.edits.length ||
      f.edits.length > 40
    )
      throw Error('局部修复需要现有文件和明确修改');
    let content = before;
    for (const edit of f.edits) {
      if (
        typeof edit.old !== 'string' ||
        !edit.old ||
        typeof edit.new !== 'string' ||
        edit.old === edit.new ||
        content.split(edit.old).length !== 2
      )
        throw Error('局部修复必须唯一匹配原文：' + f.path);
      content = content.replace(edit.old, () => edit.new);
    }
    return { path: f.path, beforeSha256: f.beforeSha256, content };
  });
  const resolved = { ...proposal, files };
  validateRepair(root, resolved);
  return resolved;
}
export function validateRepair(root, proposal) {
  if (
    !['patch', 'retry', 'needs_input'].includes(proposal.action) ||
    typeof proposal.reason !== 'string'
  )
    throw Error('修复输出协议无效');
  if (
    !Array.isArray(proposal.files) ||
    proposal.files.length > 12 ||
    !Array.isArray(proposal.tests)
  )
    throw Error('修复文件清单无效');
  if (proposal.action !== 'patch' && proposal.files.length)
    throw Error('非补丁方案不能包含修改');
  const names = new Set();
  let total = 0;
  for (const f of proposal.files) {
    if (
      !repairPathAllowed(f.path) ||
      names.has(f.path) ||
      typeof f.content !== 'string'
    )
      throw Error('修复路径或内容不允许：' + f.path);
    names.add(f.path);
    total += Buffer.byteLength(f.content);
    const target = path.join(root, f.path);
    for (let p = target; p !== root; p = path.dirname(p))
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())
        throw Error('修复路径不能经过符号链接');
    const before = fs.existsSync(target)
      ? digest(fs.readFileSync(target).toString('utf8'))
      : null;
    if (before !== f.beforeSha256) throw Error('修复基线不一致：' + f.path);
  }
  if (total > 1024 * 1024) throw Error('修复变更过大，需人工审查');
  if (proposal.action === 'patch') {
    if (!proposal.files.some((f) => !f.path.startsWith('tests/')))
      throw Error('不能只改测试');
    if (
      !proposal.tests.length ||
      proposal.tests.length > 6 ||
      proposal.tests.some((p) => !/^tests\/[\w/-]+\.test\.mjs$/.test(p))
    )
      throw Error('必须提供相关回归测试');
    if (
      !proposal.tests.some((p) =>
        proposal.files.some(
          (f) => f.path === p && digest(f.content) !== f.beforeSha256,
        ),
      )
    )
      throw Error('必须增加可证明原故障的回归测试');
  }
  return true;
}
export function writeRepairFiles(root, files) {
  for (const f of files) {
    const file = path.join(root, f.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, f.content);
  }
}
