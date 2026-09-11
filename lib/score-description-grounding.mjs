// Narrow review triggers, not a semantic verdict or SOLO's similarity rules.
// Never edit prose or infer missing failures from a keyword match.
export const scoreGroundingVersion = '2026-09-11.score-grounding1';

export function scoreGroundingInstructions() {
  return `点评依据规则 ${scoreGroundingVersion}：口语化与可核验必须同时满足，先核对事实，再组织表达，最后逐维检查。非满分 descriptions 自然写清三件事：在哪个具体操作或开发步骤出了什么问题；原日志或产物中实际看到什么；这个问题当时使哪一步无法完成、结果哪里不对，或需要补做哪项工作。后面再交代是否修好，最终通过不能代替当时的客观后果。不要写如果不修会怎样来冒充已发生的影响，也不要只写增加验证时间、降低效率、影响体验或多次返工。没有耗时记录就不写耗时；有重跑记录就说明补改什么、重新检查什么。
页面问题优先用控件名、动作和可见结果定位；开发过程的问题至少保留一个真实且有用的定位点，例如文件名、函数名、工具调用、命令或报错原文，并用普通话说明它的作用。不要求行号、完整路径、日志编号、全部测试数量或分数档位。不能把实际的 pkill、AssertionError 等定位点全部删成服务停止命令、检查报错这类泛称。公开描述要能独立看懂，不能让读者必须打开 evidenceRefs 才知道扣分原因。
生成和文字修订结束后，把每个非满分点评与 when、behavior、impact、evidenceRefs 逐项核对：公开文字是否包含本轮真实的操作、问题证据和已观察后果；内部假设不得变成公开事实；内部已证实的具体问题不得被缩成套话。若只有猜测而找不到实际后果，回查原件并按真实依据判断分数，不编造后果凑齐格式。独立验收与被测模型的操作分开说明。上述要求同样用于一致性复评和交付检查，评分时解决，不推迟到上传前。`;
}

export function scoreDescriptionGroundingIssues(value) {
  const issues = [];
  for (const [index, description] of (value.descriptions || []).entries()) {
    if (!(Number(value.scores?.[index]) < 5)) continue;
    const text = String(description);
    // A final success or hypothetical effect cannot explain an earlier failure.
    const problem = text
      .split(/[。；;\n]/u)
      .filter(
        (part) =>
          !/^(?:随后|之后|其后|修正后|修复后|调整后|最终|这些问题没有遗留|问题均被)/u.test(
            part.trim(),
          ) && !/(?:若未|如果|假如|可能会|本可|否则会)/u.test(part),
      )
      .join('；');
    const failure =
      /(?:问题|错误|失败|报错|不一致|重复|遗漏|返工|修正|不符)/u.test(problem);
    const concreteEffect =
      /(?:AssertionError|TypeError|SyntaxError|ReferenceError|Exit code\s*\d+|退出码\s*\d+|(?:导致|造成|使得).{2,48}(?:无法|不能|未能|错误|失败|中断|缺失|不显示|为空)|(?:页面|列表|详情|结果|草稿|字段|标签|标记|请求|服务|测试|检查|数据|导出|生成|登记|流程|运行|按钮|内容|通路|定位).{0,32}(?:无法|不能|未能|中断|空白|旧内容|未显示|不显示|未渲染|没有显示|缺失|报错|失败|被覆盖|丢失)|(?:补上|补改|重新|再次).{2,30}(?:检查|验证|运行|生成|测试)|(?:无法|不能|未能).{2,30}(?:显示|完成|生成|继续|启动|导出|核对))/u.test(
        problem,
      );
    const vagueEffect =
      /(?:增加(?:了)?(?:验证|测试|开发)?时间|降低(?:了)?(?:操作|执行|开发)?效率|影响(?:了)?(?:使用|体验|效率)|需要返工)/u.test(
        problem,
      );
    if (
      failure &&
      !concreteEffect &&
      (vagueEffect ||
        /(?:出现|存在|曾有|发生).{0,65}(?:问题|错误)/u.test(problem))
    )
      issues.push(
        `第${index + 1}维只概括问题或效率影响，缺少当时实际发生的具体后果；回查本轮原件，用通俗的话补明哪一步失败、哪里显示不对或补做了什么，最终修好不能代替后果，不得编造`,
      );
    const genericOperation =
      /(?:服务停止命令|服务控制命令|草稿差异展示|工具操作|页面测试).{0,20}(?:问题|失败|返工|异常)/u.test(
        problem,
      );
    const namedEvidence =
      /(?:[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|vue|sh)\b|\b(?:Bash|Read|Edit|Write|pytest|curl|pkill|npm|pnpm|node|python|AssertionError|TypeError|SyntaxError|ReferenceError)\b|退出码\s*\d+|Exit code\s*\d+)/u.test(
        problem,
      );
    const visibleOperation =
      /(?:点击|打开|选择|输入|填写|保存|提交|下载|导入|刷新).{2,32}(?:空白|旧内容|不显示|没有显示|失败|丢失|无法|不能|仍显示)/u.test(
        problem,
      );
    if (genericOperation && !namedEvidence && !visibleOperation)
      issues.push(
        `第${index + 1}维仅用操作泛称，缺少能对应原件的定位点；保留真实控件和可见现象，或必要的文件名、命令、报错并解释用途，不需要行号`,
      );
  }
  return issues;
}
