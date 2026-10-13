#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROTECTED = process.env.CORTICO_BRIDGE_PROTECTED_DIR;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (child, root) => { const rel = relative(fold(root), fold(child)); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const ms = value => iso(value) ? Date.parse(value) : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const clean = value => String(value ?? '').replace(/(["']?(?:api[_-]?key|token|authorization|password|secret)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[\s\S])*\2/gi, '$1$2[REDACTED]$2')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+={0,2}/gi, 'Bearer [REDACTED]')
  .replace(/(\b(?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)(?!["']|Bearer\b)[^\s,;\r\n]+/gi, '$1[REDACTED]')
  .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
  .replace(/[\r\n]+/g, ' ').slice(0, 1000);
function rejectProtected(path) { if (PROTECTED && !isAbsolute(PROTECTED)) throw new Error('CORTICO_BRIDGE_PROTECTED_DIR must be absolute.'); if (PROTECTED && inside(resolve(path), resolve(PROTECTED))) throw new Error('The protected conversation-backup directory is not an audit source or destination.'); }
function safeDataDir(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('--data requires an absolute bridge data directory.');
  rejectProtected(path); const root = realpathSync.native(path); rejectProtected(root);
  if (!statSync(root).isDirectory()) throw new Error('--data must be a directory.'); return root;
}
function safeRead(root, name) {
  const path = join(root, name); if (lstatSync(path).isSymbolicLink()) throw new Error('Symbolic-link audit files are not accepted.');
  const canonical = realpathSync.native(path); rejectProtected(canonical);
  if (!inside(canonical, root)) throw new Error('Audit file escaped the requested data directory.');
  const stat = statSync(canonical); if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Audit file is not regular or exceeds the 64 MiB inspection limit.');
  return readFileSync(canonical, 'utf8');
}
function field(object, ...paths) {
  for (const path of paths) { const value = path.split('.').reduce((current, part) => current?.[part], object); if (value !== undefined && value !== null) return value; }
  return undefined;
}
const canonicalKind = kind => ({ enqueue: 'queued', enqueue_receipt: 'queued', write_receipt: 'write', reader_check: 'heartbeat' })[kind] ?? kind;
const publicId = value => typeof value === 'string' && value.length <= 200 ? clean(value) : null;
function receiptSummary(records, idKey, recoveryField) {
  const groups = new Map(); let unidentified = 0;
  for (const record of records) {
    const id = publicId(record[idKey]); if (!id) { unidentified++; continue; }
    const list = groups.get(id) ?? []; list.push(record); groups.set(id, list);
  }
  return { unique: groups.size, unidentified, duplicateReceipts: [...groups].filter(([, list]) => list.length > 1).map(([id, list]) => ({ id, receipts: list.length, recoveredReceipts: list.filter(r => r[recoveryField] === true).length })) };
}
function heartbeat(records, kind, component, enabled, interval, fromMs, toMs, firstEvidenceMs) {
  const all = records.filter(r => r.kind === kind && (!component || r.component === component) && r.ok !== false);
  const samples = all.filter(r => r.ms >= fromMs), last = all.at(-1);
  const threshold = Math.max(30, interval * 3), start = Math.max(fromMs, firstEvidenceMs ?? toMs);
  const points = [start, ...samples.map(r => r.ms), toMs];
  const maxGapSeconds = points.slice(1).reduce((max, t, i) => Math.max(max, (t - points[i]) / 1000), 0);
  const currentGapSeconds = last ? Math.max(0, (toMs - last.ms) / 1000) : null;
  const expected = enabled === true && interval > 0;
  const awaitingFirstSample = expected && !last && firstEvidenceMs !== undefined && (toMs - firstEvidenceMs) / 1000 <= threshold;
  return { enabled, automatic: expected, expectedIntervalSeconds: interval, staleAfterSeconds: threshold, samples: samples.length,
    latestSuccessAt: last?.at ?? null, currentGapSeconds, maxGapSeconds, missing: expected && !last, stale: expected && !!last && currentGapSeconds > threshold,
    awaitingFirstSample, gap: expected && maxGapSeconds > threshold, sampleState: enabled === false ? 'disabled' : all.length ? 'observed' : awaitingFirstSample ? 'awaiting_first_sample' : 'no_production_sample' };
}

/** Inspect only the checkpoint and root-level metadata journals; queue draft bodies are omitted. */
export function auditDshBridge({ dataDir, hours = 24, now = new Date().toISOString() } = {}) {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) throw new Error('--hours must be greater than zero and no more than 8760.');
  if (!iso(now)) throw new Error('--now requires an ISO timestamp with an explicit timezone.');
  const root = safeDataDir(dataDir), toMs = Date.parse(now), fromMs = toMs - hours * 3600000;
  const records = [], prior = new Map(), issues = [], files = [];
  let checkpoint = null, invalidLines = 0, ignoredRecords = 0, futureRecords = 0;
  const issue = (code, message, extra = {}) => issues.push({ code, message, ...extra });
  try {
    if (!existsSync(join(root, 'checkpoint.json'))) throw new Error('Bridge checkpoint is missing.');
    const c = JSON.parse(safeRead(root, 'checkpoint.json'));
    if (!c || c.version !== 1 || typeof c.scopeHash !== 'string' || !c.scopeHash || c.scopeHash.length > 200 || !Array.isArray(c.queue) || !c.counters || typeof c.counters !== 'object' || Array.isArray(c.counters)) throw new Error('Invalid checkpoint version, scope, queue or counters.');
    if (!iso(c.updatedAt) || ['polls', 'pushedEvents', 'pushedItems', 'writtenRows', 'failures', 'toolReads'].some(key => !Number.isSafeInteger(c.counters[key]) || c.counters[key] < 0)) throw new Error('Invalid checkpoint timestamp or counters.');
    if (c.cursor !== null && (!c.cursor || !Number.isSafeInteger(c.cursor.updatedAt) || c.cursor.updatedAt < 0 || !['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'].includes(c.cursor.level) || !publicId(c.cursor.id))) throw new Error('Invalid checkpoint cursor metadata.');
    if (c.queue.some(q => !q || !publicId(q.id) || ms(q.queuedAt) === null || !Number.isSafeInteger(q.attempts) || q.attempts < 0)) throw new Error('Invalid queue receipt metadata.');
    if (c.pendingDelivery !== null && c.pendingDelivery !== undefined && (!c.pendingDelivery || !publicId(c.pendingDelivery.deliveryId) || !Array.isArray(c.pendingDelivery.rows))) throw new Error('Invalid delivery intent metadata.');
    checkpoint = c;
  } catch (error) { issue('checkpoint_invalid', clean(error.message)); }
  for (const name of readdirSync(root).filter(name => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
    try {
      const text = safeRead(root, name); files.push(name); const lines = text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try {
          const raw = JSON.parse(lines[index]);
          const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {}), ...raw } : null;
          const at = record?.at ?? record?.ts;
          if (!record || record.source !== 'dshmemory' || typeof record.kind !== 'string' || !iso(at)) { ignoredRecords++; continue; }
          const value = { ...record, at, ms: Date.parse(at), kind: canonicalKind(record.kind) };
          if (value.ms > toMs) { futureRecords++; continue; }
          if (value.ms >= fromMs) records.push(value);
          else {
            const key = `${value.kind}:${typeof value.component === 'string' ? value.component : ''}`;
            if (!prior.has(key) || prior.get(key).ms < value.ms) prior.set(key, value);
          }
        } catch {
          invalidLines++;
          if (issues.filter(i => i.code === 'journal_invalid_line').length < 20) issue('journal_invalid_line', 'Invalid JSONL metadata record; contents omitted.', { file: name, line: index + 1 });
        }
      }
    } catch (error) { issue('journal_unavailable', clean(error.message), { file: name }); }
  }
  records.push(...prior.values()); records.sort((a, b) => a.ms - b.ms);
  const windowRecords = records.filter(r => r.ms >= fromMs), pick = kind => windowRecords.filter(r => r.kind === kind);
  const starts = records.filter(r => r.kind === 'start'), latestStart = starts.at(-1);
  const latestLifecycle = records.filter(r => r.kind === 'start' || r.kind === 'stop').at(-1);
  const configured = name => field(latestStart, name, `config.${name}`);
  const sourceMode = configured('sourceMode') ?? 'memory', workspaceMode = sourceMode === 'workspace';
  if (!['memory', 'workspace'].includes(sourceMode)) issue('component_settings_incomplete', 'Start metadata contains an unsupported source mode.');
  const intervals = { reader: number(configured('healthCheckIntervalSeconds')), watch: number(configured('watchIntervalSeconds')), write: number(configured('writeFlushSeconds')), raw: number(field(latestStart, 'rawIntervalSeconds', 'rawSyncIntervalSeconds', 'config.rawSyncIntervalSeconds')) };
  const enabled = { reader: !workspaceMode, workspace: workspaceMode, files: configured('workspaceFilesEnabled') === true, watch: !workspaceMode && intervals.watch > 0,
    write: workspaceMode ? false : configured('writeEnabled') === undefined ? null : configured('writeEnabled') === true,
    raw: configured('rawEnabled') === undefined ? null : configured('rawEnabled') === true };
  if (!latestStart) issue('start_metadata_missing', 'No start metadata establishes component settings.');
  if (enabled.write === null || enabled.raw === null || intervals.reader === 0) issue('component_settings_incomplete', 'Start metadata does not establish all component switches and health-check intervals.');
  const firstEvidenceMs = records.find(r => ['start', 'heartbeat', 'poll', 'raw_sync'].includes(r.kind))?.ms;
  const heartbeats = {
    reader: heartbeat(records, 'heartbeat', 'reader', enabled.reader, intervals.reader, fromMs, toMs, firstEvidenceMs),
    workspace: heartbeat(records, 'heartbeat', 'workspace', enabled.workspace, intervals.reader, fromMs, toMs, firstEvidenceMs),
    watch: heartbeat(records, 'poll', null, enabled.watch, intervals.watch, fromMs, toMs, firstEvidenceMs),
    raw: heartbeat(records, 'raw_sync', null, enabled.raw, intervals.raw, fromMs, toMs, firstEvidenceMs),
  };
  for (const [component, h] of Object.entries(heartbeats)) {
    if (h.missing && !h.awaitingFirstSample) issue('heartbeat_missing', `${component}: no successful automatic heartbeat is present.`, { component });
    if (h.stale) issue('heartbeat_stale', `${component}: latest success is ${h.currentGapSeconds.toFixed(1)} seconds old.`, { component });
    if (h.gap) issue('heartbeat_gap', `${component}: largest observed gap is ${h.maxGapSeconds.toFixed(1)} seconds.`, { component });
  }
  const polls = pick('poll'), deliveries = pick('delivery'), queued = pick('queued'), writes = pick('write'), tools = pick('tool_read'), rawSyncs = pick('raw_sync'), failures = pick('failure');
  const deliveryReceipts = receiptSummary(deliveries, 'deliveryId', 'recovered'), writeReceipts = receiptSummary(writes, 'id', 'recovered');
  const deliveryGroups = new Map();
  for (const record of deliveries) if (publicId(record.deliveryId)) { const values = deliveryGroups.get(record.deliveryId) ?? []; values.push(record); deliveryGroups.set(record.deliveryId, values); }
  const duplicateDeliveryCommits = [...deliveryGroups].map(([id, list]) => ({ id: publicId(id), eventCursors: [...new Set(list.map(r => field(r, 'eventCursor', 'cursor')).filter(v => Number.isSafeInteger(v) && v > 0))] })).filter(r => r.eventCursors.length > 1);
  const duplicateWriteInserts = writeReceipts.duplicateReceipts.filter(r => writes.filter(w => w.id === r.id && w.recovered !== true && w.inserted !== false).length > 1);
  if (duplicateDeliveryCommits.length) issue('duplicate_delivery_commit', 'One delivery ID has receipts for multiple Cortico event cursors.');
  if (duplicateWriteInserts.length) issue('duplicate_write_insert_receipt', 'One write ID has multiple receipts claiming a new insertion.');
  if (deliveryReceipts.unidentified || writeReceipts.unidentified) issue('receipt_id_missing', 'One or more commit receipts do not contain a verifiable ID.');
  const queue = checkpoint?.queue ?? [], pendingDelivery = checkpoint?.pendingDelivery ?? null;
  const oldestQueuedMs = queue.length ? Math.min(...queue.map(q => ms(q.queuedAt))) : null;
  const queueAgeSeconds = oldestQueuedMs === null ? null : Math.max(0, (toMs - oldestQueuedMs) / 1000);
  const queueStaleAfterSeconds = Math.max(30, intervals.write * 3);
  if (pendingDelivery) issue('pending_delivery', 'A durable delivery intent awaits acknowledgement.');
  if (queue.length && enabled.write === false) issue('queue_write_disabled', 'Previously accepted writes remain pending while writeback is disabled.');
  if (queue.length && queueAgeSeconds > queueStaleAfterSeconds) issue('write_queue_stale', `Oldest accepted write has waited ${queueAgeSeconds.toFixed(1)} seconds.`);
  const lastFailure = checkpoint?.lastFailure;
  const currentFailures = [];
  for (const component of ['reader', 'workspace', 'files', 'watch', 'write', 'raw', 'runtime']) {
    const directError = field(checkpoint, `${component}.error`, `errors.${component}`);
    const successAt = field(checkpoint, `${component}.lastSuccessAt`, component === 'write' ? 'write.lastWriteAt' : `${component}.lastSuccessAt`);
    const recentSuccess = component === 'reader' ? (workspaceMode ? heartbeats.workspace : heartbeats.reader).latestSuccessAt
      : component === 'workspace' ? heartbeats.workspace.latestSuccessAt
      : component === 'files' ? records.filter(r => r.kind === 'tool_read' && r.ok === true && ['dshmemory_files_list','dshmemory_file_read','dshmemory_files_search'].includes(r.tool)).at(-1)?.at
      : component === 'runtime' ? records.filter(r => r.kind === 'heartbeat' && r.ok === true).at(-1)?.at : successAt;
    const unresolvedFailure = lastFailure?.component === component && iso(lastFailure.at) && (ms(recentSuccess) === null || Date.parse(lastFailure.at) >= ms(recentSuccess));
    if (directError || unresolvedFailure) currentFailures.push({ component, at: lastFailure?.component === component && iso(lastFailure.at) ? lastFailure.at : null, message: clean(directError ?? lastFailure.message) });
  }
  for (const failure of currentFailures) issue('checkpoint_current_failure', failure.message, { component: failure.component });
  const incompleteLogs = invalidLines > 0 || ignoredRecords > 0 || issues.some(i => ['journal_unavailable', 'checkpoint_invalid', 'start_metadata_missing', 'component_settings_incomplete'].includes(i.code));
  const automaticHeartbeats = Object.values(heartbeats).filter(h => h.automatic);
  const completeWindow = !incompleteLogs && firstEvidenceMs !== undefined && firstEvidenceMs <= fromMs && automaticHeartbeats.length > 0 && automaticHeartbeats.every(h => h.samples > 0 && !h.missing && !h.stale && !h.gap);
  if (!completeWindow) issue('window_incomplete', 'The metadata does not establish uninterrupted coverage of the complete requested window.');
  const failuresByComponent = Object.fromEntries([...new Set(failures.map(r => typeof r.component === 'string' ? clean(r.component) : 'unknown'))].map(component => [component, failures.filter(r => (r.component ?? 'unknown') === component).length]));
  const hasFailures = failures.length > 0 || tools.some(r => r.ok === false) || polls.some(r => r.ok === false) || rawSyncs.some(r => r.ok === false);
  const operationalIssue = issues.some(i => !['window_incomplete', 'component_settings_incomplete', 'start_metadata_missing'].includes(i.code));
  const sample = (active, samples, good) => ({ enabled: active, samples: samples.length, succeeded: samples.filter(good).length, failed: samples.filter(r => !good(r)).length, state: active === false ? 'disabled' : samples.length ? 'observed' : 'no_production_sample' });
  const toolsByName = Object.fromEntries([...new Set(tools.map(r => typeof r.tool === 'string' ? clean(r.tool) : 'unknown'))].map(tool => {
    const calls = tools.filter(r => (r.tool ?? 'unknown') === tool); return [tool, { calls: calls.length, succeeded: calls.filter(r => r.ok === true).length, failed: calls.filter(r => r.ok === false).length }];
  }));
  const uniqueDeliveries = [...deliveryGroups.values()].map(list => list[0]);
  const streamMetrics = ['scannedBytes', 'decodedBytes', 'validationDecodedBytes', 'processingReadBytes', 'replayedDecodedBytes', 'headerReadBytes'];
  const successfulRaw = rawSyncs.filter(r => r.ok === true), lastRaw = successfulRaw.at(-1);
  const streamingSamples = successfulRaw.filter(r => Number.isSafeInteger(r.validationDecodedBytes));
  return {
    source: 'dshmemory-audit-v1', sourceMode, generatedAt: new Date(toMs).toISOString(), dataDir: root,
    assessment: hasFailures || operationalIssue ? 'needs_attention' : completeWindow ? 'healthy_observed_window' : 'insufficient_evidence', stabilityAccepted: false,
    window: { hours, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), complete: completeWindow, earliestAuditAt: records[0]?.at ?? null, latestAuditAt: records.at(-1)?.at ?? null,
      observedHours: firstEvidenceMs === undefined ? 0 : Math.min(hours, Math.max(0, (records.at(-1).ms - Math.max(fromMs, firstEvidenceMs)) / 3600000)) },
    lifecycle: { latest: latestLifecycle?.kind ?? null, at: latestLifecycle?.at ?? null, starts: pick('start').length, stops: pick('stop').length, observedStopped: latestLifecycle?.kind === 'stop' },
    totals: { polls: polls.length, failedPolls: polls.filter(r => r.ok === false).length, deliveryRecords: deliveries.length, uniqueDeliveries: deliveryReceipts.unique,
      deliveredItems: uniqueDeliveries.reduce((n, r) => n + number(field(r, 'items', 'count')), 0), recoveredDeliveries: deliveries.filter(r => r.recovered === true).length,
      queuedRecords: queued.length, uniqueQueuedIds: new Set(queued.map(r => publicId(r.id)).filter(Boolean)).size, writeReceiptRecords: writes.length, uniqueWrittenIds: writeReceipts.unique,
      recoveredWrites: writes.filter(r => r.recovered === true || r.inserted === false).length, toolReadsSucceeded: tools.filter(r => r.ok === true && r.tool !== 'dshmemory_remember').length,
      toolReadsFailed: tools.filter(r => r.ok === false && r.tool !== 'dshmemory_remember').length, toolsByName, rawSyncs: rawSyncs.length, rawSyncsFailed: rawSyncs.filter(r => r.ok === false).length,
      rawNewTurns: rawSyncs.reduce((n, r) => n + number(r.newTurns), 0), cappedRawSyncs: rawSyncs.filter(r => r.capped === true).length, failures: failures.length, failuresByComponent },
    rawWork: { streamingSamples: streamingSamples.length,
      totals: Object.fromEntries(streamMetrics.map(key => [key, successfulRaw.reduce((n, r) => n + number(r[key]), 0)])),
      latest: lastRaw ? { at: lastRaw.at, newTurns: number(lastRaw.newTurns), capped: lastRaw.capped === true,
        ...Object.fromEntries(streamMetrics.map(key => [key, Number.isSafeInteger(lastRaw[key]) ? number(lastRaw[key]) : null])) } : null },
    heartbeats,
    samples: { reader: sample(enabled.reader, pick('heartbeat').filter(r => r.component === 'reader'), r => r.ok === true),
      workspace: sample(enabled.workspace, pick('heartbeat').filter(r => r.component === 'workspace'), r => r.ok === true), delivery: sample(enabled.watch, deliveries, () => true),
      writeback: sample(enabled.write, writes, () => true), toolReads: sample(true, tools.filter(r => r.tool !== 'dshmemory_remember'), r => r.ok === true),
      memorySearch: sample(enabled.reader, tools.filter(r => r.tool === 'dshmemory_search'), r => r.ok === true), memoryRead: sample(enabled.reader, tools.filter(r => r.tool === 'dshmemory_read'), r => r.ok === true),
      filesList: sample(enabled.files, tools.filter(r => r.tool === 'dshmemory_files_list'), r => r.ok === true),
      fileRead: sample(enabled.files, tools.filter(r => r.tool === 'dshmemory_file_read'), r => r.ok === true),
      filesSearch: sample(enabled.files, tools.filter(r => r.tool === 'dshmemory_files_search'), r => r.ok === true),
      rawSearch: sample(enabled.raw, tools.filter(r => r.tool === 'dshmemory_raw_search'), r => r.ok === true), rawRead: sample(enabled.raw, tools.filter(r => r.tool === 'dshmemory_raw_read'), r => r.ok === true),
      rawSync: sample(enabled.raw, rawSyncs, r => r.ok === true) },
    receipts: { duplicateDeliveryReceipts: deliveryReceipts.duplicateReceipts.slice(-20), duplicateDeliveryCommits: duplicateDeliveryCommits.slice(-20),
      duplicateWriteReceipts: writeReceipts.duplicateReceipts.slice(-20), duplicateWriteInsertReceipts: duplicateWriteInserts.slice(-20), unidentifiedDeliveryReceipts: deliveryReceipts.unidentified, unidentifiedWriteReceipts: writeReceipts.unidentified },
    pending: { writes: queue.length, oldestQueuedAt: oldestQueuedMs === null ? null : new Date(oldestQueuedMs).toISOString(), oldestQueueAgeSeconds: queueAgeSeconds, queueStaleAfterSeconds,
      writeIds: queue.slice(0, 50).map(q => ({ id: publicId(q.id), queuedAt: iso(q.queuedAt) ? q.queuedAt : new Date(q.queuedAt).toISOString(), attempts: number(q.attempts) })),
      delivery: pendingDelivery ? { deliveryId: publicId(pendingDelivery.deliveryId), items: pendingDelivery.rows.length } : null },
    checkpoint: checkpoint ? { version: checkpoint.version, updatedAt: checkpoint.updatedAt, counters: Object.fromEntries(Object.entries(checkpoint.counters).map(([key, value]) => [clean(key), number(value)])),
      cursor: checkpoint.cursor ? { updatedAt: number(checkpoint.cursor.updatedAt), level: clean(checkpoint.cursor.level), id: publicId(checkpoint.cursor.id) } : null,
      lastFailure: lastFailure ? { at: iso(lastFailure.at) ? lastFailure.at : null, component: clean(lastFailure.component), message: clean(lastFailure.message) } : null, currentFailures } : null,
    recentFailures: [...failures, ...tools.filter(r => r.ok === false), ...rawSyncs.filter(r => r.ok === false)].sort((a, b) => a.ms - b.ms).slice(-20)
      .map(r => ({ at: r.at, kind: r.kind, component: clean(r.component ?? (r.kind === 'raw_sync' ? 'raw' : 'tool')), tool: r.kind === 'tool_read' ? clean(r.tool) : null, message: clean(r.message), warnings: number(r.warnings) })),
    journals: { files, recordsInWindow: windowRecords.length, invalidLines, ignoredRecords, futureRecords }, issues,
    evidenceLimits: ['This audit reads the bridge checkpoint and root-level metadata journals, omits queued draft bodies, and does not query source memory or conversation mirrors.',
      'No production sample is distinct from an offline component. Receipt recovery is distinct from multiple stored events for one delivery ID.',
      'Clean metadata does not establish memory relevance, full source coverage, conversation quality, or correct Cortico reasoning. Source and receipt reconciliation remains necessary for stability acceptance.'],
  };
}
function saveReport(path, report) {
  if (!isAbsolute(path)) throw new Error('--out requires an absolute report path.'); rejectProtected(path);
  if (inside(resolve(path), report.dataDir)) throw new Error('--out must be outside the inspected bridge data directory.');
  let ancestor = resolve(path, '..');
  while (!existsSync(ancestor)) { const parent = resolve(ancestor, '..'); if (parent === ancestor) throw new Error('Report output has no existing ancestor.'); ancestor = parent; }
  const canonicalAncestor = realpathSync.native(ancestor); rejectProtected(canonicalAncestor);
  if (inside(canonicalAncestor, report.dataDir)) throw new Error('--out must be outside the inspected bridge data directory.');
  if (existsSync(path)) { if (lstatSync(path).isSymbolicLink()) throw new Error('Symbolic-link report outputs are not accepted.'); rejectProtected(realpathSync.native(path)); }
  mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
export function main(argv = process.argv.slice(2)) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]; if (key === '--hours24') { if (values['--hours'] !== undefined) throw new Error('Duplicate --hours option.'); values['--hours'] = '24'; continue; }
    if (!['--data', '--hours', '--now', '--out'].includes(key) || values[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Usage: node audit-dsh-bridge.mjs [--data <absolute directory>] [--hours 24] [--now ISO] [--out <absolute file>]');
    values[key] = argv[++i];
  }
  const report = auditDshBridge({ dataDir: values['--data'], hours: values['--hours'] === undefined ? 24 : Number(values['--hours']), now: values['--now'] });
  if (values['--out']) saveReport(values['--out'], report); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(), null, 2) + '\n'); }
  catch (error) { process.stderr.write(clean(error.message) + '\n'); process.exitCode = 2; }
}
