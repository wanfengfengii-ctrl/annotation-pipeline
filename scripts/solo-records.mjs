import { createHash } from 'node:crypto';

const aliases = {
  user_prompt: 'User Prompt',
  session_id: 'SessionID',
  turn_id: 'TurnID/PromptID',
  round_no: '当前对话轮次排序',
  env_snapshot: '初始环境快照',
  trace_file: '轨迹文件',
  reproducibility: '环境可复现等级',
  env_reproducibility: '环境可复现等级',
  harness: 'Harness',
  harness_version: 'Harness 版本',
  os: '操作系统',
  question_type: '任务类型',
  task_type: '任务类型',
  difficulty: '任务难度',
  languages: '语言/框架',
  language_framework: '语言/框架',
  score_delivery: '交付完整性',
  desc_delivery: '交付完整性 - 描述',
  score_instruction: '指令遵循',
  desc_instruction: '指令遵循 - 描述',
  score_planning: '任务规划',
  desc_planning: '任务规划 - 描述',
  score_reasoning: '推理能力',
  desc_reasoning: '推理能力 - 描述',
  score_execution: '执行能力',
  desc_execution: '执行能力 - 描述',
  other_issues: '其他问题',
  other_problems: '其他问题',
};
const ignored = new Set([
  '提交人',
  '提交时间',
  '质检结果',
  '父记录',
  '审核备注',
  '父记录2',
]);
const normalize = (value) =>
  String(value || '')
    .replace(/\s/g, '')
    .toLowerCase();
export const recordKey = (row) => row.taskId + ':' + row.turnId;
export const digest = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
export const attachmentField = (field) =>
  ['attachment', 'file'].includes(field.field_type);

export function rowFields(row, headers) {
  if (
    !row.eligible ||
    row.source !== 'ai' ||
    row.values.length !== headers.length
  )
    throw Error('仅上传通过当前导出校验的 AI 记录');
  return Object.fromEntries(headers.map((key, i) => [key, row.values[i]]));
}

export function mapRecord(row, headers, schema, attachments = []) {
  if (!schema?.fingerprint || !Array.isArray(schema.fields))
    throw Error('SOLO 动态表单无效');
  const fields = rowFields(row, headers),
    data = {},
    missing = [];
  for (const f of schema.fields.filter((f) => f.is_enabled !== false)) {
    let value;
    const label =
      aliases[f.field_key] ||
      Object.keys(fields).find((k) => normalize(k) === normalize(f.label));
    if (attachmentField(f)) {
      if (
        f.field_key !== 'trace_file' &&
        normalize(f.label) !== normalize('轨迹文件')
      )
        throw Error('出现尚未适配的附件字段：' + f.field_key);
      value = attachments;
    } else if (ignored.has(normalize(f.label))) {
      // These are administered by the platform; never manufacture an approval.
      value = '';
    } else value = label ? fields[label] : '';
    if (f.field_key.startsWith('score_') && value !== '') value = Number(value);
    if (f.field_type === 'number' && label === '当前对话轮次排序')
      value = parseRound(value);
    if (Array.isArray(f.options) && f.options.length && value !== '') {
      const option = f.options.find((o) => normalize(o) === normalize(value));
      if (option === undefined)
        throw Error('SOLO 选项与本地字段不一致：' + f.field_key);
      value = option;
    }
    const absent =
      value === '' || value == null || (Array.isArray(value) && !value.length);
    if (absent && f.is_required) missing.push(f.field_key);
    if (!absent && f.max_length && String(value).length > f.max_length)
      throw Error('SOLO 字段超过长度限制：' + f.field_key);
    if (
      !absent &&
      f.validation?.pattern &&
      !new RegExp(f.validation.pattern).test(String(value))
    )
      throw Error('SOLO 字段格式不匹配：' + f.field_key);
    if (
      !absent &&
      f.field_key.startsWith('score_') &&
      (!Number.isInteger(value) || value < 1 || value > 5)
    )
      throw Error('五维评分必须为 1 至 5');
    if (!absent || f.is_required) data[f.field_key] = value;
  }
  if (missing.length)
    throw Error('SOLO 必填字段尚未适配或缺少值：' + missing.join('、'));
  if (!data.user_prompt || !data.session_id || !data.turn_id)
    throw Error('SOLO 题目及原生标识字段缺失');
  return { data, schema_fingerprint: schema.fingerprint };
}

export function parseRound(value) {
  if (/^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 10)
    return Number(value);
  const m = String(value).match(/^第([一二三四五六七八九十]|\d+)轮$/);
  if (!m) throw Error('对话轮次无效');
  return /^\d+$/.test(m[1])
    ? Number(m[1])
    : '一二三四五六七八九十'.indexOf(m[1]) + 1;
}

// A remote receipt is recognized by native identities and exact submitted data,
// never by a prompt excerpt or by a successful HTTP response alone.
export function sameRemote(detail, payload) {
  return Object.entries(payload.data).every(([key, value]) => {
    const actual = detail[key];
    if (Array.isArray(value))
      return (
        JSON.stringify(
          (actual || []).map((f) => ({
            name: f.name,
            path: f.path,
            size: f.size,
          })),
        ) ===
        JSON.stringify(
          value.map((f) => ({ name: f.name, path: f.path, size: f.size })),
        )
      );
    if (key === 'round_no') {
      try {
        return parseRound(actual) === parseRound(value);
      } catch {
        return false;
      }
    }
    return String(actual ?? '') === String(value ?? '');
  });
}

export async function findRemote(client, identity) {
  const matches = new Map();
  for (let page = 1; page <= 100; page++) {
    const r = await client.list({
      page,
      page_size: 100,
      keyword: identity.turn_id,
    });
    if (!Array.isArray(r.items) || !Number.isInteger(r.meta?.total))
      throw Error('无法核验 SOLO 列表分页');
    for (const item of r.items) {
      // The list may omit turn_id: fetch detail before deciding uniqueness.
      if (item.session_id !== identity.session_id) continue;
      const d = await client.detail(item.id);
      if (
        d.session_id === identity.session_id &&
        d.turn_id === identity.turn_id
      )
        matches.set(String(d.id), d);
    }
    if (page * 100 >= r.meta.total) return [...matches.values()];
  }
  throw Error('SOLO 查询超出安全分页范围，停止提交');
}
