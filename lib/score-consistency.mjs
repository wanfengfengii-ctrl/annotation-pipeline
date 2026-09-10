export const scoreConsistencyVersion = '2026-09-10.score-consistency1';
export const scoreDimensions = [
  '交付完整性',
  '指令遵循',
  '任务规划',
  '推理能力',
  '执行能力',
];

// Observed SOLO #618 signals. These signals request an evidence-based scoring review,
// not a semantic verdict: even negation or a business error message may match.
export function scoreConsistencyIssues(scores, descriptions) {
  return scoreDimensions.flatMap((dimension, index) => {
    if (Number(scores?.[index]) !== 5) return [];
    const signals = [
      ...new Set(
        String(descriptions?.[index] || '').match(/错误|不能|偏差/g) || [],
      ),
    ];
    return signals.length
      ? [
          {
            dimension,
            index,
            score: 5,
            signals,
            reason:
              '满分点评含平台已知的问题信号，需核对本维事实及分档归属；关键词命中本身不等于评分错误',
          },
        ]
      : [];
  });
}

export function assertScoreConsistency(scores, descriptions) {
  const issues = scoreConsistencyIssues(scores, descriptions);
  if (issues.length)
    throw Error(
      '评分一致性复评仍需核对：' +
        issues
          .map((i) => `${i.dimension} 5 分，命中 ${i.signals.join('、')}`)
          .join('；'),
    );
}

export function scoreConsistencyInstructions() {
  return `评分一致性规则 ${scoreConsistencyVersion}：点评先写本维证据和实际影响，再写对应档位；高分点评不要混入其他维度的问题再用否定句解释为何仍给满分。5 分与 4 分的比较应说明实际完成范围、约束落实和过程表现如何达到本维最高档，不逐字复述低档的问题清单。已复现问题必须保留在所属维度及 artifactFindings 或 processFindings；不能通过删词、同义替换、隐藏缺陷或随意调分迎合平台。确有本维实质不足时按原分档重新评分，不能以属于实现问题为由自动排除指令遵循：须逐条对照原题约束，确认问题是否违反原题。输入校验中的错误提示、已修复的历史失败及其他维度问题应结合证据判断，关键词本身不决定分数。SOLO 已观察到满分点评中的错误、不能、偏差会触发一致性质检，生成后须核对这些歧义并给出清楚、具体、口语化的本维评价；事实仍有冲突时保留问题，不能制造无问题结论。`;
}
