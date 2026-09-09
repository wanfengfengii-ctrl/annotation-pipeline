export function harnessInstructions(harness = 'Claude Code') {
  return `被测客户端是 ${harness}，客户端版本、模型和会话环境分别记录。规划维度只评价任务拆解、阶段状态追踪、计划更新及遇歧义的处理，不因是否调用特定规划工具而加减分；不同 Harness 的 system prompt、工具集和 agent loop 不同，不直接混同评价。只根据可见过程、产物与真实执行证据评分。`;
}
export function codexTurnIds(events) {
  return [
    ...new Set(
      events.flatMap((e) => {
        const payload = e?.type === 'event_msg' ? e.payload : e;
        return payload?.type === 'task_started' &&
          typeof payload.turn_id === 'string' &&
          payload.turn_id
          ? [payload.turn_id]
          : [];
      }),
    ),
  ];
}
