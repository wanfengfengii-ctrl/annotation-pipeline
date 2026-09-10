export const scoreConsistencyVersion = '2026-09-10.score-consistency2';
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
  return `评分一致性规则 ${scoreConsistencyVersion}：每个非满分点评在生成时就自然包含具体位置、实际行为和客观后果：使用本轮明确操作、界面控件、文件函数或原始日志步骤定位，说明该动作造成的已验证结果；evidenceRefs 有证据但点评只写泛泛的问题名称也不合格。保留真实的相对文件路径或日志行号，写成一段平淡口语，不用分项标签。不要捏造人工误操作、额外轮次、耗时、百分比或测试失败；未观察到的后果不写成事实。点评先写本维证据和实际影响，再写对应档位；高分点评不要混入其他维度的问题再用否定句解释为何仍给满分。5 分与 4 分的比较应说明实际完成范围、约束落实和过程表现如何达到本维最高档，不逐字复述低档的问题清单。已复现问题必须保留在所属维度及 artifactFindings 或 processFindings；不能通过删词、同义替换、隐藏缺陷或随意调分迎合平台。确有本维实质不足时按原分档重新评分，不能以属于实现问题为由自动排除指令遵循：须逐条对照原题约束，确认问题是否违反原题。输入校验中的错误提示、已修复的历史失败及其他维度问题应结合证据判断，关键词本身不决定分数。SOLO 已观察到满分点评中的错误、不能、偏差会触发一致性质检，生成后须核对这些歧义并给出清楚、具体、口语化的本维评价；事实仍有冲突时保留问题，不能制造无问题结论。\n指令遵循的义务以原始轨迹中实际发送的题目及有效上下文为准。内部 acceptance、独立验收计划、评分器提示和交付检查是核验参考，未发送给被测模型的补充要求不能反推为模型漏做的指令。每个“遗漏明确要求”的扣分理由须指出原题相应要求及实际违背；不能仅引用内部清单。原题只要求引用测试并区分已有断言与未覆盖边界时，不额外要求执行测试或声明未运行；最终答复没有声称运行通过时，也不能只因缺少这句声明判为虚假成功。实际误导、说明错误、约束违背和各维 rubric 中的过程表现仍按真实证据评价，不机械提高分数。正确做法中的字段、条件、函数语义及调用顺序须逐项核对当前源码，不能用建议替代真实实现。`;
}
