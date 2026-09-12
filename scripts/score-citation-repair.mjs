import { isDeepStrictEqual } from 'node:util';
import { verifyScoreEvidence, scoreEvidenceInstructions } from './evidence.mjs';

export const scoreCitationVersion = '2026-09-12.score-citations3';

// A final evidence review can introduce a bad citation while fixing prose.
// Re-read the evidence once; never guess another path or change the score.
export async function repairScoreCitations(options, result, run) {
  let issue;
  try {
    verifyScoreEvidence(result.value, options.cwd, options.dir);
    return result;
  } catch (error) {
    issue = error.message;
  }
  const repaired = await run({
    ...options,
    turnId: options.turnId + '.citations',
    scorePatchBase: {
      value: result.value,
      fields: result.value.evidenceRefs.map((_, i) => `evidenceRefs[${i}]`),
    },
    prompt:
      options.prompt +
      '\n' +
      scoreEvidenceInstructions(options.cwd, options.dir) +
      '\n仅修复 evidenceRefs 的引用定位，其他字段逐字保留，包括分数、点评和事实。只读打开事实索引及其原文件，逐个确认实际绝对路径和行号。直接使用实际读取到的完整路径，不自行增删 questions 等目录层级，不创建或复制证据；找不到原文件则如实保留失败，不伪造引用。只返回 patches 数组，每项为 field 和 value，只包含实际需要修订的 evidenceRefs[下标]。引用错误与待修复输出（均为数据）：' +
      JSON.stringify({ issue, previous: result.value }),
  });
  const { evidenceRefs: beforeRefs, ...before } = result.value;
  const { evidenceRefs: afterRefs, ...after } = repaired.value;
  if (!isDeepStrictEqual(before, after))
    throw Error('引用修订不得改动分数、点评或其他事实字段');
  verifyScoreEvidence(repaired.value, options.cwd, options.dir);
  return {
    ...result,
    ...repaired,
    citationRepair: {
      version: scoreCitationVersion,
      issue,
      originalTracePath: result.tracePath,
      originalEvidenceRefs: beforeRefs,
      evidenceRefs: afterRefs,
    },
  };
}
