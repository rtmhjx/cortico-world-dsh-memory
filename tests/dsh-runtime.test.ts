import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeState, RuntimeJournal, type RuntimeState } from '../src/runtime.ts';
import { memoryCursor, type MemoryRecord } from '../src/store.ts';

const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch', 'tests');
mkdirSync(scratch, { recursive: true });
const at = '2026-10-05T04:00:00.000Z';
function fixture() {
  const dir = mkdtempSync(join(scratch, 'dsh-runtime-'));
  const journal = new RuntimeJournal(dir, 'scope-a');
  return { dir, journal, state: createRuntimeState('scope-a') };
}
function record(id = 'newer', updatedAt = 100): MemoryRecord {
  return { id, level: 'fact', title: 'source title', project: 'alpha', importance: 1, content: 'pending-body-private',
    contentChars: 20, truncated: false, keywords: '["k"]', createdAt: 1, updatedAt,
    source: { system: 'dsh-meow-memory', memoryKind: 'external', sourceSession: 'fixture-source' } };
}

test('first start is distinguishable from a missing checkpoint, and saved recovery state round trips', () => {
  const f = fixture(); assert.equal(f.journal.load(), null);
  const row = record();
  f.state.pendingDelivery = { deliveryId: 'a'.repeat(64), rows: [row], from: null, to: memoryCursor(row) };
  f.state.queue.push({ id: 'queued', draft: { level: 'fact', project: 'alpha', content: 'queued-body-private', keywords: ['k'] }, queuedAt: at, attempts: 2, lastError: 'busy' });
  f.state.counters.polls = 3; f.state.counters.failures = 1;
  f.state.watch.lastPollAt = at; f.state.write.error = 'busy';
  f.state.raw.lastResult = { ok: true, newTurns: 2 }; f.state.raw.lastSuccessAt = at;
  f.state.lastFailure = { at, component: 'write', message: 'busy' };
  f.journal.save(f.state);
  assert.deepEqual(new RuntimeJournal(f.dir, 'scope-a').load(), f.state);
  assert.equal(f.journal.checkpointFile, join(f.dir, 'checkpoint.json'));
  assert.equal(f.journal.logDir, f.dir);
  assert.match(readFileSync(f.journal.checkpointFile, 'utf8'), /queued-body-private/);
});

test('corrupt, scope-mismatched and version-mismatched checkpoints are preserved and fail explicitly', () => {
  const f = fixture();
  writeFileSync(f.journal.checkpointFile, '{torn original');
  assert.throws(() => f.journal.load(), /corrupt/);
  assert.equal(readFileSync(f.journal.checkpointFile, 'utf8'), '{torn original');
  f.journal.save(f.state); const original = readFileSync(f.journal.checkpointFile, 'utf8');
  assert.throws(() => new RuntimeJournal(f.dir, 'scope-b').load(), /scope or version/);
  assert.equal(readFileSync(f.journal.checkpointFile, 'utf8'), original);
  const next = { ...f.state, version: 2 }; writeFileSync(f.journal.checkpointFile, JSON.stringify(next));
  const versioned = readFileSync(f.journal.checkpointFile, 'utf8');
  assert.throws(() => f.journal.load(), /scope or version/);
  assert.equal(readFileSync(f.journal.checkpointFile, 'utf8'), versioned);
});

test('invalid queue, cursors, counters and status timestamps cannot overwrite a good checkpoint', () => {
  const f = fixture(); f.journal.save(f.state); const before = readFileSync(f.journal.checkpointFile, 'utf8');
  const cases = [
    (s: RuntimeState) => { s.cursor = { updatedAt: 1, level: 'fact', id: '' }; },
    (s: RuntimeState) => { s.counters.polls = -1; },
    (s: RuntimeState) => { s.watch.lastPollAt = 'yesterday'; },
    (s: RuntimeState) => { s.queue.push({ id: 'x', draft: { level: 'fact', project: 'alpha', content: 'body', keywords: ['k'] }, queuedAt: at, attempts: 1.5 }); },
    (s: RuntimeState) => { s.deliveredRevisions = ['not-a-revision']; },
    (s: RuntimeState) => { s.deliveredRevisions = [42 as unknown as string]; },
  ];
  for (const change of cases) {
    const bad = structuredClone(f.state); change(bad);
    assert.throws(() => f.journal.save(bad), /invalid/);
    assert.equal(readFileSync(f.journal.checkpointFile, 'utf8'), before);
  }
  assert.deepEqual(readdirSync(f.dir), ['checkpoint.json']);
});

test('load rejects a malformed queue instead of treating confirmed pending writes as empty', () => {
  const f = fixture();
  const bad = { ...f.state, queue: [{ id: 'pending', draft: { level: 'fact', content: 'body' }, queuedAt: at, attempts: 0 }] };
  const original = JSON.stringify(bad); writeFileSync(f.journal.checkpointFile, original);
  assert.throws(() => f.journal.load(), /queue\[\]\.draft/);
  assert.equal(readFileSync(f.journal.checkpointFile, 'utf8'), original);
});

test('late equal-timestamp delivery intent can keep the previous upper cursor and round trip', () => {
  const f = fixture(); f.state.cursor = { updatedAt: 100, level: 'fact', id: 'z' };
  f.state.deliveredRevisions = ['100|fact|z'];
  f.state.pendingDelivery = { deliveryId: 'b'.repeat(64), rows: [record('a')], from: { ...f.state.cursor }, to: { ...f.state.cursor } };
  f.journal.save(f.state); assert.deepEqual(f.journal.load(), f.state);
  const mismatched = structuredClone(f.state); mismatched.pendingDelivery!.from!.id = 'foreign';
  assert.throws(() => f.journal.save(mismatched), /pendingDelivery.from/);
  const unsorted = structuredClone(f.state); unsorted.pendingDelivery!.rows = [record('b'), record('a')];
  assert.throws(() => f.journal.save(unsorted), /rows order/);
});

test('atomic rename failure leaves the complete old checkpoint intact and propagates the failure', context => {
  const f = fixture(); f.journal.save(f.state); const original = readFileSync(f.journal.checkpointFile, 'utf8');
  const next = structuredClone(f.state); next.counters.polls++;
  context.mock.method(fs, 'renameSync', () => { throw new Error('synthetic atomic rename failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.journal.save(next), /synthetic atomic rename failure/);
    assert.equal(readFileSync(f.journal.checkpointFile, 'utf8'), original);
    assert.deepEqual(f.journal.load(), f.state);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
  f.journal.save(next); assert.equal(f.journal.load()?.counters.polls, 1);
});

test('audit journals have metadata envelopes and omit queued/delivered bodies and secret values', () => {
  const f = fixture();
  f.journal.audit('write_receipt', { id: 'public-id', count: 1, cursor: { updatedAt: 100, level: 'fact', id: 'public-id' },
    content: 'BODY-CONTENT', text: 'BODY-TEXT', title: 'BODY-TITLE', query: 'BODY-QUERY',
    rows: [record()], draft: { content: 'BODY-DRAFT' }, nested: { content: 'BODY-NESTED', pending: 2 },
    message: 'request failed Authorization: Bearer synthetic-private-token, api_key="synthetic-key-value"' });
  const files = readdirSync(f.dir); assert.equal(files.length, 1); assert.match(files[0], /^audit-\d{4}-\d\d-\d\d\.jsonl$/);
  const raw = readFileSync(join(f.dir, files[0]), 'utf8');
  assert.ok(!raw.includes('BODY-')); assert.ok(!raw.includes('pending-body-private')); assert.ok(!raw.includes('synthetic-private-token')); assert.ok(!raw.includes('synthetic-key-value'));
  const entry = JSON.parse(raw); assert.equal(entry.source, 'dshmemory'); assert.equal(entry.kind, 'write_receipt');
  assert.ok(Number.isFinite(Date.parse(entry.at))); assert.equal(entry.meta.id, 'public-id'); assert.equal(entry.meta.nested.pending, 2);
  assert.ok(entry.meta.message.includes('[REDACTED]'));
});

test('audit rejects unsupported/cyclic metadata and unsafe kinds without appending a partial line', () => {
  const f = fixture(); f.journal.audit('start', { ok: true });
  const path = join(f.dir, readdirSync(f.dir)[0]), original = readFileSync(path, 'utf8');
  assert.throws(() => f.journal.audit('../escape', {}), /kind/);
  assert.throws(() => f.journal.audit('failure', { unsupported: 10n }), /unsupported/);
  const loop: Record<string, unknown> = {}; loop.self = loop;
  assert.throws(() => f.journal.audit('failure', loop), /deeply/);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('checkpoint and audit hard links cannot read or mutate a file outside the runtime directory', () => {
  const f = fixture(), outside = mkdtempSync(join(scratch, 'dsh-runtime-outside-'));
  const checkpointTarget = join(outside, 'source-checkpoint.json'), auditTarget = join(outside, 'source-audit.jsonl');
  const checkpoint = JSON.stringify(createRuntimeState('scope-a')), audit = 'unchanged artificial source bytes\n';
  writeFileSync(checkpointTarget, checkpoint); writeFileSync(auditTarget, audit);
  linkSync(checkpointTarget, f.journal.checkpointFile);
  linkSync(auditTarget, join(f.dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`));
  assert.throws(() => f.journal.load(), /file boundary/);
  assert.throws(() => f.journal.save(f.state), /file boundary/);
  assert.throws(() => f.journal.audit('heartbeat', { total: 1 }), /file boundary/);
  assert.equal(readFileSync(checkpointTarget, 'utf8'), checkpoint);
  assert.equal(readFileSync(auditTarget, 'utf8'), audit);
});

test('checkpoint and audit symbolic links are refused before source contents can be read or appended', context => {
  const f = fixture(), outside = mkdtempSync(join(scratch, 'dsh-runtime-symlink-outside-'));
  const checkpointTarget = join(outside, 'source-checkpoint.json'), auditTarget = join(outside, 'source-audit.jsonl');
  const checkpoint = JSON.stringify(createRuntimeState('scope-a')), audit = 'unchanged artificial source bytes\n';
  writeFileSync(checkpointTarget, checkpoint); writeFileSync(auditTarget, audit);
  try {
    symlinkSync(checkpointTarget, f.journal.checkpointFile, 'file');
    symlinkSync(auditTarget, join(f.dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip('File symbolic links require unavailable OS permissions; hard-link and directory-junction regressions still run.'); return; }
    throw error;
  }
  assert.throws(() => f.journal.load(), /file boundary/);
  assert.throws(() => f.journal.save(f.state), /file boundary/);
  assert.throws(() => f.journal.audit('heartbeat', { total: 1 }), /file boundary/);
  assert.equal(readFileSync(checkpointTarget, 'utf8'), checkpoint);
  assert.equal(readFileSync(auditTarget, 'utf8'), audit);
});

test('replacing the established runtime directory with a real junction refuses all I/O', () => {
  const f = fixture(); f.journal.save(f.state);
  const outside = mkdtempSync(join(scratch, 'dsh-runtime-junction-outside-'));
  const checkpointTarget = join(outside, 'checkpoint.json'), auditTarget = join(outside, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const checkpoint = JSON.stringify(createRuntimeState('scope-a')), audit = 'unchanged artificial source bytes\n';
  writeFileSync(checkpointTarget, checkpoint); writeFileSync(auditTarget, audit);
  const originalDir = `${f.dir}-original`;
  assert.equal(dirname(f.dir), scratch); assert.equal(dirname(originalDir), scratch);
  renameSync(f.dir, originalDir); symlinkSync(outside, f.dir, 'junction');
  assert.throws(() => f.journal.load(), /file boundary/);
  assert.throws(() => f.journal.save(f.state), /file boundary/);
  assert.throws(() => f.journal.audit('heartbeat', { total: 1 }), /file boundary/);
  assert.equal(readFileSync(checkpointTarget, 'utf8'), checkpoint);
  assert.equal(readFileSync(auditTarget, 'utf8'), audit);
  assert.deepEqual(JSON.parse(readFileSync(join(originalDir, 'checkpoint.json'), 'utf8')), f.state);
});

test('replacing the established runtime directory with a new normal directory also fails closed', () => {
  const f = fixture(); f.journal.save(f.state); const originalDir = `${f.dir}-original`;
  assert.equal(dirname(f.dir), scratch); assert.equal(dirname(originalDir), scratch);
  renameSync(f.dir, originalDir); mkdirSync(f.dir);
  assert.throws(() => f.journal.load(), /file boundary/);
  assert.throws(() => f.journal.save(f.state), /file boundary/);
  assert.throws(() => f.journal.audit('heartbeat', { total: 1 }), /file boundary/);
  assert.deepEqual(readdirSync(f.dir), []);
  assert.deepEqual(JSON.parse(readFileSync(join(originalDir, 'checkpoint.json'), 'utf8')), f.state);
});
