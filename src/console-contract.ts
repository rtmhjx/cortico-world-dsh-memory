/** 数据来自 World 当前运行状态；来源时间只描述数据新鲜度。 */
export interface DshConsoleSnapshot {
  running: boolean;
  lastError: string | null;
  lastFailure: { at: string; component?: string; message: string } | null;
  counters: {
    polls: number;
    pushedEvents: number;
    pushedItems: number;
    writtenRows: number;
    failures: number;
    toolReads: number;
  };
  reader: {
    state: 'ready' | 'loading' | 'error' | 'unconfigured' | 'stopped' | string;
    dbFile: string;
    counts?: { total: number; byLevel: Record<string, number | undefined> } | null;
    latestUpdatedAt: number | string | null;
    lastCheckedAt: number | string | null;
    error: string | null;
  };
  watch: {
    enabled: boolean;
    intervalSeconds: number;
    cursor: { updatedAt: number; level: string; id: string } | null;
    lastPollAt: number | string | null;
    lastSuccessAt: number | string | null;
    lastPushAt: number | string | null;
    pendingDelivery: unknown | null;
  };
  write: {
    enabled: boolean;
    flushSeconds: number;
    pending: number;
    writtenRows: number;
    lastWriteAt: number | string | null;
    lastAttemptAt: number | string | null;
    error: string | null;
  };
  raw: {
    enabled: boolean;
    intervalSeconds: number;
    sessionsDir: string | null;
    rawDir: string | null;
    lastSyncAt: number | string | null;
    lastSuccessAt: number | string | null;
    lastResult: {
      newTurns: number;
      sessionsScanned: number;
      filesTouched: number;
      capped: boolean;
    } | null;
    error: string | null;
    scrubMismatch: boolean;
    totalTurns: number;
    buckets: Array<{ bucket: string; days: number; turns: number; latest: string }>;
  };
  runtime: { logDir: string | null; checkpointFile: string | null };
}
