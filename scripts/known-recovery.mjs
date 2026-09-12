import path from 'node:path';
import { readJSON } from './self-heal-io.mjs';
import { recoveryAction, isExternalBlock } from '../lib/self-heal.mjs';
import { archivedPredecessor } from '../lib/project-recovery.mjs';
import { recoverySourceContext } from './failed-project-plan.mjs';

// Only select existing guarded API operations after their actual prerequisites
// verify. Unknown errors continue through diagnosis; no native input is resent.
export function knownRecovery(root, incident, snapshot) {
  const task = snapshot.tasks.find((t) => t.id === incident.taskId);
  const turn = task?.turns.find((r) => r.id === incident.turnId);
  if (!task || !turn || isExternalBlock(task, turn, incident.reason))
    return null;
  const action = recoveryAction(task, turn);
  if (!action) return null;
  const reason = incident.reason || '';
  if (/无法读取冻结源码|无法读源码|只读源码访问|可见界面对访达/.test(reason)) {
    const source = turn.projectRecovery?.sourceSnapshot;
    if (source?.verified) {
      // The planner and independent audit both receive this verified context.
      const context = JSON.parse(recoverySourceContext(source));
      if (context.files.some((f) => typeof f.content === 'string'))
        return {
          id: 'verified-source-replan',
          action,
          reason: '已核验续题源码，使用现有恢复入口将源码提供给出题和审核',
        };
    }
  }
  if (/当前项目容器身份不符/.test(reason)) {
    const container = readJSON(
      path.join(root, '.runner', task.id, 'container.json'),
    );
    if (archivedPredecessor(task, turn, container))
      return {
        id: 'archived-predecessor-replan',
        action,
        reason: '新题尚未发送，先核验上一题归档，再在同项目恢复独立出题',
      };
  }
  return null;
}

export function knownRecoveryDue(incident, recovery) {
  return (
    !!recovery &&
    !(incident.fixedRecoveries || []).some(
      (r) => r.id === recovery.id && r.conditionsKey === incident.conditionsKey,
    )
  );
}
