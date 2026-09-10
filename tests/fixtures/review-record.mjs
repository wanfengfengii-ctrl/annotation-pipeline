export function reviewFixture(i = 1) {
  const turn = {
    id: 'review-turn-' + i,
    status: 'review',
    prompt: '复核导出样例 ' + i,
    category: 'Feature 迭代',
    difficulty: '困难',
    createdAt: `2026-09-10T00:00:${String(i).padStart(2, '0')}Z`,
    sessionId: 'review-session-' + i,
    promptId: 'review-prompt-' + i,
    tracePath: '/fixture/native/projects',
    container: { snapshot: 'docker://fixture@sha256:' + 'b'.repeat(64) },
    review: {
      source: 'codex',
      reviewer: 'Codex',
      scores: [3, 4, 3, 4, 3],
      descriptions: Array(5).fill('实际观察到的评分依据'),
      other: '待复核',
    },
    automation: {
      delivery: { value: { passed: true } },
      bundlePath: '/fixture/bundle',
    },
  };
  const task = {
    id: 'review-task-' + i,
    title: '复核样例项目 ' + i,
    createdAt: turn.createdAt,
    snapshot: 'https://github.com/fixture/source/commit/' + 'a'.repeat(40),
    harnessVersion: '2.1',
    os: 'macOS',
    stack: 'TypeScript',
    turns: [turn],
    initialCodeSnapshots: {
      [turn.id]: {
        url: 'https://github.com/fixture/source/commit/' + 'a'.repeat(40),
      },
    },
  };
  return { task, turn };
}
