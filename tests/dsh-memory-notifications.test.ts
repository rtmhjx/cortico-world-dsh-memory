import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldHost } from 'cortico/core/types.ts';
import { dshMemoryDefaults, resolveAccessConfig } from '../src/config.ts';
import { DshMemoryWorld } from '../src/world.ts';
import { RuntimeJournal } from '../src/runtime.ts';

function fixture() {
  const scratch = join(process.cwd(), 'scratch', 'tests'); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'memory-notifications-'));
  const dbFile = join(dir, 'memory.db');
  const writer = new DatabaseSync(dbFile);
  writer.exec(`CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL, importance INTEGER DEFAULT 1,
    keywords TEXT DEFAULT '[]', status TEXT DEFAULT 'active', source_session TEXT, hit_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER, project TEXT)`);
  const insert = (id: string, session: string | null, at: number) => writer.prepare(
    'INSERT INTO fact (id,content,source_session,created_at,updated_at,project) VALUES (?,?,?,?,?,?)'
  ).run(id, 'PRIVATE-BODY-DO-NOT-PUSH', session, at, at, 'alpha');
  insert('baseline', 'baseline-session', 1);
  const cfg = { ...dshMemoryDefaults(), enabled: true, dbFile, allowedProjects: 'alpha', levels: 'fact', writeLevels: 'fact',
    includeGlobal: false, rawEnabled: false, writeEnabled: false, watchIntervalSeconds: 0, healthCheckIntervalSeconds: 3600,
    watchMaxPerTick: 100, stateDir: join(dir, 'state') };
  let calls = 0;
  const host = { store: { grep: () => [] }, pushEvent: async () => { calls++; throw new Error('ordinary memory must not enter Core'); } } as unknown as WorldHost;
  return { dir, cfg, host, insert, writer, calls: () => calls };
}

test('memory changes record source groups without a Core event and survive a restart', async () => {
  const f = fixture();
  assert.equal(resolveAccessConfig(f.cfg).watchTrigger, 'record');
  let world = new DshMemoryWorld(f.cfg);
  await world.start(f.host);
  try {
    f.insert('first', 'session-a', 2); f.insert('second', 'session-b', 2);
    assert.equal(await world.pollOnce(), 0);
    assert.equal(f.calls(), 0);
    let status = world.status();
    assert.equal(status.counters.pushedEvents, 0);
    assert.equal(status.watch.recordedChanges.total, 2);
    assert.equal(status.watch.recordedChanges.groupCount, 2);
    assert.deepEqual(status.watch.recordedChanges.groups.map(g => g.sourceSession).sort(), ['session-a', 'session-b']);
    assert.equal(await world.pollOnce(), 0);
    assert.equal(world.status().watch.recordedChanges.total, 2);
    const checkpoint = readFileSync(join(f.cfg.stateDir, 'checkpoint.json'), 'utf8');
    assert.ok(!checkpoint.includes('PRIVATE-BODY-DO-NOT-PUSH'));
    await world.stop();
    world = new DshMemoryWorld(f.cfg); await world.start(f.host);
    f.insert('a-late-equal-timestamp', 'session-a', 2);
    assert.equal(await world.pollOnce(), 0);
    status = world.status();
    assert.equal(status.watch.recordedChanges.total, 3);
    assert.equal(status.watch.recordedChanges.groups.find(g => g.sourceSession === 'session-a')?.count, 2);
    assert.equal(f.calls(), 0);
  } finally { await world.stop(); f.writer.close(); }
});

test('memory record metadata has bounded references and rejects a corrupt aggregate', async () => {
  const f = fixture(); const world = new DshMemoryWorld(f.cfg);
  await world.start(f.host);
  try {
    for (let i = 0; i < 45; i++) f.insert(`row-${String(i).padStart(2, '0')}`, null, i + 2);
    await world.pollOnce();
    const status = world.status();
    assert.equal(status.watch.recordedChanges.total, 45);
    const group = status.watch.recordedChanges.groups[0];
    assert.equal(group.sourceSession, null); assert.equal(group.count, 45); assert.equal(group.references.length, 20);
    assert.equal(f.calls(), 0);
    const file = join(f.cfg.stateDir, 'checkpoint.json');
    const original = readFileSync(file, 'utf8'), state = JSON.parse(original);
    const journal = new RuntimeJournal(f.cfg.stateDir, state.scopeHash);
    state.recordedChanges.total++;
    assert.throws(() => journal.save(state), /recordedChanges.total/);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { await world.stop(); f.writer.close(); }
});
