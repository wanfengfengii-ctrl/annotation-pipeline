export type OperationProject = {
  taskId: string;
  projectName: string;
  title: string;
  turnId?: string;
  stage: string;
  status: string;
  owner: string;
  next: string;
  reason: string;
  lastProgressAt: string | null;
  lastDeliveryAt: string | null;
};
export type RepairMetric = {
  id: string;
  taskId?: string;
  mode: string;
  state: string;
  phase?: string;
  startedAt: string;
  elapsedMs: number;
  modelInvocations: number;
  usageKnown: number;
  inputTokens: number | null;
  outputTokens: number | null;
  restored: boolean;
  effect: string;
};
export type OperationsReport = {
  observationError?: string;
  version: string;
  checkedAt: string;
  reportedAt: string;
  guardian: {
    enabled: boolean;
    repairEnabled: boolean;
    activeJob: string | null;
    intervalMs: number;
    unlimited: boolean;
  };
  projects: OperationProject[];
  metrics: {
    attempts: number;
    modelInvocations: number;
    usageKnown: number;
    inputTokens: number | null;
    outputTokens: number | null;
    restored: number;
    fixedRestored24h: number;
    jobs: RepairMetric[];
  };
  throughput: {
    observedAt: string;
    counts: { qcPassed: number };
    flow: { firstDeliveries24h: number; revalidations24h: number } | null;
  } | null;
  release: {
    target: string | null;
    finalization: string | null;
    supply: string | null;
    boundaryCheckedAt: string | null;
  };
};
