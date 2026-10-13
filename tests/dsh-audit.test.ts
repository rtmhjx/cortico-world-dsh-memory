import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const base = join(process.cwd(), 'scratch', 'dsh-audit-tests'); mkdirSync(base, { recursive: true });
const script = join(process.cwd(), 'scripts', 'audit-dsh-bridge.mjs');
const now = '2026-10-05T12:00:00.000Z', clock = Date.parse(now);
const stamp = (seconds: number) => new Date(clock + seconds * 1000).toISOString();
const row = (seconds: number, kind: string, meta: Record<string, unknown> = {}) => ({ at: stamp(seconds), source: 'dshmemory', kind, ...meta });
const settings = { healthCheckIntervalSeconds: 5, watchIntervalSeconds: 5, writeEnabled: true, writeFlushSeconds: 10, rawEnabled: false, rawIntervalSeconds: 60 };
function fixture(records: unknown[], extra: Record<string, unknown> = {}) {
  const data = mkdtempSync(join(base, 'run-'));
  writeFileSync(join(data, 'checkpoint.json'), JSON.stringify({ version: 1, scopeHash: 'fixture-scope', updatedAt: now, queue: [], pendingDelivery: null, cursor: null,
    counters: { polls: 0, pushedEvents: 0, pushedItems: 0, writtenRows: 0, failures: 0, toolReads: 0 }, watch: { lastSuccessAt: stamp(-5) }, write: { error: null }, raw: { error: null }, lastFailure: null, ...extra }));
  writeFileSync(join(data, 'audit-2026-10-05.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const run = (args: string[] = []) => spawnSync(process.execPath, [script, '--data', data, '--now', now, ...args], { encoding: 'utf8' });
  const report = (args: string[] = []) => { const result = run(args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  return { data, run, report };
}
const fresh = () => [row(-10, 'start', settings), row(-5, 'heartbeat', { component: 'reader', ok: true }), row(-5, 'poll', { ok: true })];

test('database-free workspace mode monitors workspace health without requiring memory polls or write receipts', () => {
  const r = fixture([row(-10, 'start', { ...settings, sourceMode: 'workspace', workspaceFilesEnabled: true }),
    row(-5, 'heartbeat', { component: 'workspace', ok: true }), row(-4, 'tool_read', { tool: 'dshmemory_file_read', ok: true, content: 'PRIVATE PROJECT BODY' })]).report();
  assert.equal(r.sourceMode, 'workspace'); assert.equal(r.heartbeats.workspace.stale, false); assert.equal(r.samples.workspace.state, 'observed');
  assert.equal(r.heartbeats.reader.automatic, false); assert.equal(r.samples.reader.state, 'disabled'); assert.equal(r.heartbeats.watch.automatic, false);
  assert.equal(r.samples.writeback.state, 'disabled'); assert.equal(r.samples.memoryRead.state, 'disabled'); assert.equal(r.samples.fileRead.state, 'observed');
  assert.ok(!r.issues.some((i: { code: string }) => i.code.startsWith('heartbeat_'))); assert.equal(r.stabilityAccepted, false);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE PROJECT BODY/);
});

test('workspace heartbeat gaps are reported even when database-free mode has no active memory reader', () => {
  const r = fixture([row(-200, 'start', { ...settings, sourceMode: 'workspace', rawEnabled: false }), row(-150, 'heartbeat', { component: 'workspace', ok: true })]).report();
  assert.equal(r.assessment, 'needs_attention'); assert.equal(r.heartbeats.workspace.stale, true);
  assert.ok(r.issues.some((i: { code: string; component: string }) => i.code === 'heartbeat_stale' && i.component === 'workspace'));
  assert.ok(!r.issues.some((i: { component: string }) => i.component === 'reader' || i.component === 'watch'));
});

test('raw streaming inspection separates new JSONL processing from validation and replay without exporting source bodies', () => {
  const r = fixture([...fresh(), row(-4, 'raw_sync', { ok: true, newTurns: 2, capped: true, scannedBytes: 20,
    decodedBytes: 30, validationDecodedBytes: 100, processingReadBytes: 18, replayedDecodedBytes: 70, headerReadBytes: 4,
    text: 'PRIVATE RAW BODY' }), row(-3, 'raw_sync', { ok: true, newTurns: 0, scannedBytes: 0, decodedBytes: 0 })]).report();
  assert.equal(r.rawWork.streamingSamples, 1);
  assert.deepEqual(r.rawWork.totals, { scannedBytes: 20, decodedBytes: 30, validationDecodedBytes: 100, processingReadBytes: 18, replayedDecodedBytes: 70, headerReadBytes: 4 });
  assert.equal(r.rawWork.latest.validationDecodedBytes, null, 'old-format evidence must not claim a streaming measurement');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE RAW BODY/);
});

test('healthy idle components stay online while writes and deliveries without samples remain unproven', () => {
  const r = fixture(fresh()).report(); assert.equal(r.assessment, 'insufficient_evidence'); assert.equal(r.window.complete, false); assert.equal(r.stabilityAccepted, false);
  assert.equal(r.heartbeats.reader.stale, false); assert.equal(r.heartbeats.watch.stale, false); assert.equal(r.samples.delivery.state, 'no_production_sample'); assert.equal(r.samples.writeback.state, 'no_production_sample');
  assert.equal(r.samples.rawSync.state, 'disabled'); assert.ok(!r.issues.some((i: { component: string }) => i.component === 'raw'));
});
test('a complete clean window proves metadata coverage without accepting source correctness', () => {
  const records = [row(-86405, 'start', { ...settings, healthCheckIntervalSeconds: 3600, watchIntervalSeconds: 3600 })];
  for (let seconds = -86400; seconds <= 0; seconds += 3600) records.push(row(seconds, 'heartbeat', { component: 'reader', ok: true }), row(seconds, 'poll', { ok: true }));
  const r = fixture(records).report(); assert.equal(r.assessment, 'healthy_observed_window'); assert.equal(r.window.complete, true); assert.equal(r.stabilityAccepted, false);
  assert.equal(r.heartbeats.reader.maxGapSeconds, 3600); assert.equal(r.totals.polls, 25);
});
test('flat and nested journal metadata have the same delivery and write receipt accounting', () => {
  const records = [...fresh(), { ts: stamp(-4), source: 'dshmemory', kind: 'delivery', meta: { deliveryId: 'delivery-a', items: 2, eventCursor: 10, recovered: false } },
    row(-3, 'delivery', { deliveryId: 'delivery-a', items: 2, eventCursor: 10, recovered: true }), row(-2, 'enqueue', { id: 'write-a' }),
    row(-1, 'write_receipt', { id: 'write-a', recovered: false }), row(0, 'write_receipt', { id: 'write-a', recovered: true })];
  const r = fixture(records).report(); assert.equal(r.totals.uniqueDeliveries, 1); assert.equal(r.totals.deliveredItems, 2); assert.equal(r.totals.uniqueWrittenIds, 1);
  assert.equal(r.receipts.duplicateDeliveryReceipts[0].recoveredReceipts, 1); assert.equal(r.receipts.duplicateDeliveryCommits.length, 0); assert.equal(r.receipts.duplicateWriteInsertReceipts.length, 0);
});
test('one delivery saved under different event cursors is detected separately from recovery', () => {
  const r = fixture([...fresh(), row(-4, 'delivery', { deliveryId: 'duplicate', eventCursor: 10, items: 1 }), row(-3, 'delivery', { deliveryId: 'duplicate', eventCursor: 11, items: 1 })]).report();
  assert.equal(r.assessment, 'needs_attention'); assert.deepEqual(r.receipts.duplicateDeliveryCommits[0].eventCursors, [10, 11]);
});
test('pending writes and outbox report receipt metadata and never export queued memory bodies', () => {
  const r = fixture(fresh(), { queue: [{ id: 'waiting', queuedAt: stamp(-60), attempts: 2, draft: { content: 'PRIVATE MEMORY BODY', keywords: ['PRIVATE KEYWORD'] } }],
    pendingDelivery: { deliveryId: 'pending', rows: [{ content: 'PRIVATE DELIVERY BODY' }] } }).report();
  assert.equal(r.pending.writes, 1); assert.equal(r.pending.oldestQueueAgeSeconds, 60); assert.equal(r.pending.delivery.items, 1); assert.equal(r.assessment, 'needs_attention');
  assert.ok(r.issues.some((i: { code: string }) => i.code === 'write_queue_stale')); assert.doesNotMatch(JSON.stringify(r), /PRIVATE MEMORY|PRIVATE KEYWORD|PRIVATE DELIVERY/);
});
test('automatic raw sync requires a recent success, while manual raw sync has no heartbeat requirement', () => {
  const records = [...fresh()]; records[0] = row(-10, 'start', { ...settings, rawEnabled: true, rawIntervalSeconds: 60 });
  const waiting = fixture(records).report(); assert.equal(waiting.heartbeats.raw.awaitingFirstSample, true); assert.equal(waiting.assessment, 'insufficient_evidence');
  records[0] = row(-200, 'start', { ...settings, rawEnabled: true, rawIntervalSeconds: 60 });
  const missing = fixture(records).report(); assert.equal(missing.heartbeats.raw.missing, true); assert.equal(missing.heartbeats.raw.awaitingFirstSample, false); assert.equal(missing.assessment, 'needs_attention');
  records[0] = row(-10, 'start', { ...settings, rawEnabled: true, rawIntervalSeconds: 0 }); const manual = fixture(records).report();
  assert.equal(manual.heartbeats.raw.automatic, false); assert.equal(manual.heartbeats.raw.missing, false); assert.equal(manual.samples.rawSync.state, 'no_production_sample');
});
test('failure components and incomplete raw coverage remain visible after another component succeeds', () => {
  const r = fixture([...fresh(), row(-4, 'failure', { component: 'raw', message: 'token=super-secret' }), row(-3, 'raw_sync', { ok: false, warnings: 1, newTurns: 3, capped: true }), row(-2, 'poll', { ok: true })],
    { raw: { error: 'api_key="super-private"' }, lastFailure: { at: stamp(-4), component: 'raw', message: 'token=super-secret' } }).report();
  assert.equal(r.totals.failuresByComponent.raw, 1); assert.equal(r.totals.rawSyncsFailed, 1); assert.equal(r.totals.rawNewTurns, 3); assert.equal(r.checkpoint.currentFailures[0].component, 'raw');
  assert.doesNotMatch(JSON.stringify(r), /super-secret|super-private/); assert.match(JSON.stringify(r), /REDACTED/);
});
test('malformed and torn journal rows make the audit incomplete without exposing raw contents', () => {
  const f = fixture(fresh()); writeFileSync(join(f.data, 'audit-2026-10-05.jsonl'), JSON.stringify(row(-5, 'poll', { ok: true })) + '\n{"password":"SECRET TAIL');
  const r = f.report(); assert.equal(r.journals.invalidLines, 1); assert.equal(r.assessment, 'needs_attention'); assert.equal(r.window.complete, false); assert.doesNotMatch(JSON.stringify(r), /SECRET TAIL/);
});
test('invalid checkpoint is not silently replaced by an empty healthy state', () => {
  const f = fixture(fresh()); writeFileSync(join(f.data, 'checkpoint.json'), '{"version":1,"queue":"broken"}');
  const r = f.report(); assert.equal(r.checkpoint, null); assert.equal(r.assessment, 'needs_attention'); assert.ok(r.issues.some((i: { code: string }) => i.code === 'checkpoint_invalid'));
});
test('missing required counters or an invalid cursor cannot masquerade as a valid checkpoint', () => {
  const noCounters = fixture(fresh(), { counters: {} }).report(); assert.equal(noCounters.checkpoint, null); assert.equal(noCounters.assessment, 'needs_attention');
  const badCursor = fixture(fresh(), { cursor: { updatedAt: -1, level: 'fact', id: 'invalid' } }).report(); assert.equal(badCursor.checkpoint, null); assert.equal(badCursor.assessment, 'needs_attention');
});
test('past and future failures do not inflate the requested window totals', () => {
  const r = fixture([row(-90000, 'failure', { component: 'write', message: 'historical' }), ...fresh(), row(1, 'failure', { component: 'raw', message: 'future' })]).report();
  assert.equal(r.totals.failures, 0); assert.equal(r.journals.futureRecords, 1); assert.equal(r.assessment, 'insufficient_evidence');
});
test('CLI protects source journals and backup paths while supporting an external report output', () => {
  const f = fixture(fresh()), out = join(base, 'report.json'); const r = f.report(['--out', out]); assert.equal(JSON.parse(readFileSync(out, 'utf8')).source, r.source);
  assert.equal(f.run(['--out', join(f.data, 'checkpoint.json')]).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--data', '.'], { encoding: 'utf8' }).status, 2);
  const denied = join(base, 'protected-fixture');
  const protectedPath = spawnSync(process.execPath, [script, '--data', denied], { encoding: 'utf8', env: { ...process.env, CORTICO_BRIDGE_PROTECTED_DIR: denied } }); assert.equal(protectedPath.status, 2); assert.match(protectedPath.stderr, /protected/);
});
test('a raw-v2 directory and unrelated files are never discovered by the metadata audit', () => {
  const f = fixture(fresh()); mkdirSync(join(f.data, 'raw-v2')); writeFileSync(join(f.data, 'raw-v2', 'audit-2026-10-05.jsonl'), 'NOT JSON PRIVATE RAW'); writeFileSync(join(f.data, 'chat.jsonl'), 'NOT JSON PRIVATE CHAT');
  const r = f.report(); assert.equal(r.journals.invalidLines, 0); assert.deepEqual(r.journals.files, ['audit-2026-10-05.jsonl']);
});
test('status-only calls do not become production evidence for memory search or content retrieval', () => {
  const r = fixture([...fresh(), row(-4, 'tool_read', { tool: 'dshmemory_status', ok: true }), row(-3, 'tool_read', { tool: 'dshmemory_search', ok: true })]).report();
  assert.equal(r.totals.toolsByName.dshmemory_status.succeeded, 1); assert.equal(r.samples.memorySearch.state, 'observed');
  assert.equal(r.samples.memoryRead.state, 'no_production_sample'); assert.equal(r.samples.rawRead.state, 'disabled');
});
