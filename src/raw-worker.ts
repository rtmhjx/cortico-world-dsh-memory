import { parentPort, workerData } from 'node:worker_threads';
import { syncRaw, rawStats, scrubText, type RawSyncOptions } from './raw.ts';
try {
  const opts = workerData as RawSyncOptions;
  const result = await syncRaw(opts);
  const stats = rawStats(opts.rawDir, { ...opts, allowedBuckets: opts.allowedBuckets, sessionsDir: opts.sessionsDir });
  parentPort!.postMessage({ ok: true, result, stats });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: scrubText(error instanceof Error ? error.message : String(error)) });
}
