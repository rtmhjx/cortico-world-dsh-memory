import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { dshMemoryDefaults, resolveAccessConfig } from '../src/config.ts';
import { DshMemoryWorld } from '../src/world.ts';
import { readRaw, searchRaw, rawStats, syncRaw } from '../src/raw.ts';
import { bindWorkspaces } from '../src/scope.ts';

const DAY = '2026-10-13', TIME = Date.parse(`${DAY}T01:00:00Z`), BUCKET = '--deliberately-wrong-bucket--';
function fixture() {
  const base = resolve('scratch/tests'); mkdirSync(base, { recursive: true }); const dir = mkdtempSync(join(base, 'dsh-workspace-'));
  const project = join(dir, 'project'), denied = join(project, 'private'), outside = join(dir, 'foreign'), sessionsDir = join(dir, 'sources'), rawDir = join(dir, 'raw-v2');
  for (const path of [project, denied, outside, sessionsDir]) mkdirSync(path, { recursive: true });
  const config = { ...dshMemoryDefaults(), sourceMode: 'workspace' as const, enabled: true, workspaceRoots: JSON.stringify([project]), workspaceDenied: JSON.stringify([denied]), sessionsDir, stateDir: join(dir, 'state'), rawDir, rawSyncIntervalSeconds: 0, watchIntervalSeconds: 1, writeEnabled: true };
  const opts = { sessionsDir, rawDir, dbFile: '', buckets: [], maxTurns: 100, allowedWorkspaces: [project], deniedWorkspaces: [denied] };
  const session = (id: string, cwd: unknown, bucket = BUCKET) => {
    const folder = join(sessionsDir, bucket, id); mkdirSync(folder, { recursive: true });
    const rows = [{ type: 'session', id, createdAt: TIME, ...(cwd === undefined ? {} : { cwd }) },
      { type: 'user/message', seq: 1, time: TIME, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${id} synthetic question` }] } },
      { type: 'assistant/message', seq: 2, time: TIME + 1, data: { message: { content: [{ type: 'text', text: `${id} synthetic answer` }] } } }];
    const file = join(folder, 'session.v3.jsonl.zstd'); writeFileSync(file, zstdCompressSync(rows.map(row => JSON.stringify(row) + '\n').join(''))); return file;
  };
  const events: unknown[] = []; const host = { store: { grep: () => [] }, pushEvent: async (event: unknown) => { events.push(event); throw new Error('workspace must not wake Core'); } } as unknown as WorldHost;
  const make = () => new DshMemoryWorld(config, { dataDir: join(dir, 'deployment-data') });
  return { dir, project, denied, outside, config, opts, session, events, host, make };
}
const tool = (world: DshMemoryWorld, name: string, args: Record<string, unknown>) => world.tools().find(item => item.name === name)!.handler(args, {} as ToolCallContext);
const parse = (result: unknown) => JSON.parse(result as string);
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('workspace config is explicit JSON with denied-first paths and effective write disabled', () => {
  const f = fixture(), access = resolveAccessConfig(f.config); assert.equal(access.writeEnabled, false);
  assert.deepEqual(access.workspaceRoots, [f.project]); assert.deepEqual(access.workspaceDenied, [f.denied]);
  assert.throws(() => resolveAccessConfig({ ...f.config, workspaceRoots: f.project }), /JSON/);
  assert.throws(() => resolveAccessConfig({ ...f.config, workspaceRoots: '["relative"]' }), /绝对路径/);
  assert.throws(() => resolveAccessConfig({ ...f.config, workspaceRoots: '[]' }), /至少一个/);
});
test('DBless World starts with empty and invalid DB paths without opening or creating SQLite', async () => {
  const f = fixture(); const brokenDb = join(f.dir, 'not-sqlite.db'); writeFileSync(brokenDb, 'synthetic definitely not a SQLite database');
  for (const dbFile of ['', join(f.dir, 'must-not-create.db'), brokenDb]) {
    const before = existsSync(dbFile) ? sha(dbFile) : null; const w = new DshMemoryWorld({ ...f.config, dbFile }); await w.start(f.host);
    assert.equal(w.status().running, true); assert.equal(w.status().reader.state, 'disabled'); assert.equal((w as any).store, undefined); assert.equal((w as any).writer, undefined);
    assert.equal(w.status().write.enabled, false); assert.equal(w.status().watch.enabled, false); assert.equal(await w.pollOnce(), 0); assert.equal(await w.flush(), 0);
    assert.deepEqual(w.tools().map(item => item.name).sort(), ['dshmemory_status', 'dshmemory_raw_sync', 'dshmemory_raw_search', 'dshmemory_raw_read'].sort());
    assert.deepEqual(w.console().lamps!.map(lamp => lamp.state), ['online', 'offline', 'offline', 'online']); await w.stop();
    if (before) assert.equal(sha(dbFile), before); else if (dbFile) assert.equal(existsSync(dbFile), false);
  }
  assert.equal(f.events.length, 0);
});
test('workspace default runtime and mirror use separate mode directories and never derive from empty dbFile', async () => {
  const f = fixture(); Object.assign(f.config, { stateDir: '', rawDir: '' }); const w = f.make(); await w.start(f.host);
  const expected = join(f.dir, 'deployment-data', 'dshmemory-workspace'); assert.equal(w.status().runtime.checkpointFile, join(expected, 'checkpoint.json')); assert.equal(w.status().raw.rawDir, join(expected, 'raw-v2'));
  assert.equal(w.status().reader.dbFile, null); await w.stop();
});
test('workspace sync trusts the actual session cwd, not the bucket directory name', async () => {
  const f = fixture(); const source = f.session('allowed-session', f.project), before = sha(source); const result = await syncRaw(f.opts);
  assert.equal(result.newTurns, 2); assert.equal(result.sourceWarnings.length, 0); const data = readRaw({ ...f.opts, bucket: BUCKET, day: DAY, limit: 10 });
  assert.equal(data.turns[0].sourceCwd, f.project); assert.equal(data.returned, 2); assert.equal(sha(source), before);
  const manifest = JSON.parse(readFileSync(join(f.opts.rawDir, '.manifest.json'), 'utf8')); assert.equal(manifest.files[`${BUCKET}/${join('allowed-session', 'session.v3.jsonl.zstd')}`].sourceCwd, f.project);
  assert.equal((await syncRaw(f.opts)).newTurns, 0);
});
test('workspace scope excludes denied and foreign cwd even if a bucket looks authorized, without advancing their cursors', async () => {
  const f = fixture(); f.session('allowed', f.project); f.session('denied', f.denied); f.session('foreign', f.outside);
  const result = await syncRaw(f.opts); assert.equal(result.newTurns, 2); const manifest = JSON.parse(readFileSync(join(f.opts.rawDir, '.manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files), [`${BUCKET}/${join('allowed', 'session.v3.jsonl.zstd')}`]);
  assert.deepEqual(searchRaw({ ...f.opts, query: 'denied', limit: 10 }).hits, []); assert.deepEqual(searchRaw({ ...f.opts, query: 'foreign', limit: 10 }).hits, []);
});
test('missing and relative session cwd yield coverage warnings, preserve cursors, and do not block authorized sources', async () => {
  const f = fixture(); f.session('valid', f.project); f.session('missing', undefined); f.session('relative', 'relative/path'); const result = await syncRaw(f.opts);
  assert.equal(result.newTurns, 2); assert.equal(result.sourceWarnings.length, 2); assert.equal(result.budgetLimited, false);
  const manifest = JSON.parse(readFileSync(join(f.opts.rawDir, '.manifest.json'), 'utf8')); assert.equal(Object.keys(manifest.files).length, 1);
});
test('rawBuckets can narrow workspace scope but cannot authorize a foreign cwd', async () => {
  const f = fixture(); f.session('kept', f.project, 'one'); f.session('excluded', f.project, 'two'); f.session('foreign', f.outside, 'one');
  const result = await syncRaw({ ...f.opts, allowedBuckets: ['one'], buckets: ['one'] }); assert.equal(result.newTurns, 2); assert.deepEqual(Object.keys(result.perBucket), ['one']);
  await assert.rejects(syncRaw({ ...f.opts, allowedBuckets: ['one'], buckets: ['two'] }), /rawBuckets/);
});
test('old mirror rows without validated sourceCwd are hidden from workspace search/read/stats', () => {
  const f = fixture(); const dayDir = join(f.opts.rawDir, BUCKET); mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, `${DAY}.jsonl`), [{ ts: `${DAY}T00:00:00Z`, win: 'old', role: 'user', text: 'legacy secret fixture' }, { ts: `${DAY}T00:00:01Z`, win: 'foreign', role: 'user', text: 'foreign fixture', sourceCwd: f.outside }].map(row => JSON.stringify(row)+'\n').join(''));
  assert.equal(readRaw({ ...f.opts, bucket: BUCKET, day: DAY, limit: 10 }).returned, 0); assert.equal(searchRaw({ ...f.opts, query: 'fixture', limit: 10 }).hits.length, 0); assert.equal(rawStats(f.opts.rawDir, f.opts).totalTurns, 0);
  assert.equal(readRaw({ rawDir: f.opts.rawDir, bucket: BUCKET, day: DAY, limit: 10 }).returned, 2);
});
test('changing workspace authorization refuses existing mirror and keeps manifest byte-for-byte', async () => {
  const f = fixture(); f.session('valid', f.project); await syncRaw(f.opts); const file = join(f.opts.rawDir, '.manifest.json'), before = sha(file);
  await assert.rejects(syncRaw({ ...f.opts, deniedWorkspaces: [] }), /范围发生变化/); assert.equal(sha(file), before);
});
test('changing World workspace scope keeps checkpoint intact and fails without broadening tools', async () => {
  const f = fixture(), w = f.make(); await w.start(f.host); await w.stop(); const file = join(f.config.stateDir, 'checkpoint.json'), before = sha(file);
  f.config.workspaceRoots = JSON.stringify([f.outside]); const other = f.make(); await assert.rejects(other.start(f.host), /scope|范围/i); assert.equal(sha(file), before); assert.equal(other.status().running, false);
});
test('World raw Worker sync preserves source files, never wakes Core, and returns scoped public messages', async () => {
  const f = fixture(); const source = f.session('allowed', f.project); const before = sha(source), w = f.make(); await w.start(f.host);
  const result = await w.syncRawOnce(); assert.equal(result.newTurns, 2); const hits = parse(await tool(w, 'dshmemory_raw_search', { query: 'synthetic' })); assert.equal(hits.hits.length, 2);
  assert.equal(w.status().lastError, null); assert.equal(w.status().raw.totalTurns, 2); assert.equal(f.events.length, 0); assert.equal(sha(source), before); await w.stop();
  assert.ok(w.console().lamps!.every(lamp => lamp.state === 'offline')); await assert.rejects(w.syncRawOnce(), /未运行/);
});
test('workspace source/coverage failures are shown on the raw lamp rather than a fictitious healthy database', async () => {
  const f = fixture(); f.session('unknown', undefined); const w = f.make(); await w.start(f.host); await w.syncRawOnce();
  assert.equal(w.status().reader.state, 'disabled'); assert.ok(w.status().raw.error?.includes('cwd')); assert.equal(w.console().lamps![3].state, 'error'); assert.equal(w.status().raw.lastSuccessAt, null); await w.stop();
});
test('a replaced authorized root is rejected while preserving the source manifest', async () => {
  const f = fixture(); f.session('valid', f.project); const bindings = bindWorkspaces([f.project]); await syncRaw({ ...f.opts, workspaceBindings: bindings });
  const file = join(f.opts.rawDir, '.manifest.json'), before = sha(file); renameSync(f.project, join(f.dir, 'former-project')); mkdirSync(f.project);
  await assert.rejects(syncRaw({ ...f.opts, workspaceBindings: bindings }), /替换|重定向/); assert.equal(sha(file), before);
});
test('junction cwd escaping the allowed project is denied using its real target', async () => {
  const f = fixture(); const alias = join(f.project, 'alias'); symlinkSync(f.outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); f.session('escape', alias);
  assert.equal((await syncRaw(f.opts)).newTurns, 0);
});
test('workspace same session ID cannot change cwd and reuse its established raw cursor', async () => {
  const f = fixture(); f.session('same-session', f.project); await syncRaw({ ...f.opts, maxTurns: 1 });
  const manifest = join(f.opts.rawDir, '.manifest.json'), before = sha(manifest); const moved = join(f.project, 'another'); mkdirSync(moved);
  f.session('same-session', moved); await assert.rejects(syncRaw(f.opts), /归属发生变化/); assert.equal(sha(manifest), before);
});
test('invalid candidate header exposes only a coverage reason, without foreign path, bucket or body', async () => {
  const f = fixture(), path = join(f.opts.sessionsDir, 'external-private-label', 'unknown'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'session.v3.jsonl.zstd'), Buffer.from('sensitive body is not a valid frame'));
  const result = await syncRaw(f.opts); assert.equal(result.newTurns, 0); assert.equal(result.sourceWarnings.length, 1);
  const warnings = JSON.stringify(result.sourceWarnings); assert.ok(!warnings.includes('external-private-label')); assert.ok(!warnings.includes(f.dir)); assert.ok(!warnings.includes('sensitive body'));
});
test('default memory mode retains the exact legacy scope hash and SQLite read behavior', async () => {
  const f = fixture(), dbFile = join(f.dir, 'memory.db'), db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE fact(id TEXT PRIMARY KEY,title TEXT,content TEXT NOT NULL,importance INTEGER,keywords TEXT,status TEXT,source_session TEXT,created_at INTEGER,updated_at INTEGER,project TEXT)");
  db.prepare("INSERT INTO fact VALUES(?,?,?,?,?,?,?,?,?,?)").run('fixture-id', 'fixture', 'synthetic memory', 1, '[]', 'active', 'session', 1, 1, 'alpha'); db.close();
  const config = { ...dshMemoryDefaults(), enabled: true, dbFile, allowedProjects: 'alpha', levels: 'fact', writeLevels: 'fact', writeEnabled: false, rawEnabled: false, sessionsDir: f.opts.sessionsDir, rawDir: f.opts.rawDir, stateDir: join(f.dir, 'memory-state') };
  const expected = createHash('sha256').update(JSON.stringify({ dbFile, projects: ['alpha'], levels: ['fact'], global: false, writeLevels: ['fact'], source: config.writeSourceLabel, sessionsDir: config.sessionsDir, rawDir: config.rawDir, rawBuckets: [] })).digest('hex');
  const w = new DshMemoryWorld(config); await w.start(f.host); assert.equal(w.status().sourceMode, 'memory'); assert.equal(w.status().reader.counts?.total, 1);
  assert.equal(JSON.parse(readFileSync(join(config.stateDir, 'checkpoint.json'), 'utf8')).scopeHash, expected);
  assert.equal(parse(await tool(w, 'dshmemory_read', { id: 'fixture-id', project: 'alpha', level: 'fact' })).memory.content, 'synthetic memory'); await w.stop();
  const restarted = new DshMemoryWorld(config); await restarted.start(f.host); assert.equal(restarted.status().reader.counts?.total, 1); await restarted.stop();
});
test('optional workspace file tools read only requested project files and never emit Core events', async () => {
  const f = fixture(); f.config.workspaceFilesEnabled = true;
  writeFileSync(join(f.project, 'README.md'), 'synthetic project guidance password="example-secret-123"');
  writeFileSync(join(f.project, '.env'), 'TOKEN=must-never-be-listed'); writeFileSync(join(f.denied, 'hidden.md'), 'synthetic denied file');
  const before = sha(join(f.project, 'README.md')), w = f.make(); await w.start(f.host);
  assert.equal(w.status().files.state, 'ready'); assert.equal(w.status().files.automaticWatch, false); assert.equal(w.console().lamps!.at(-1)!.state, 'online');
  const listing = parse(await tool(w, 'dshmemory_files_list', { root: f.project, path: '.' })); assert.deepEqual(listing.entries.map((entry: any) => entry.path), ['README.md']);
  const content = parse(await tool(w, 'dshmemory_file_read', { root: f.project, path: 'README.md' })); assert.ok(content.content.includes('synthetic project')); assert.ok(!content.content.includes('example-secret-123'));
  const matches = parse(await tool(w, 'dshmemory_files_search', { root: f.project, path: '.', query: 'synthetic' })); assert.equal(matches.matches.length, 1);
  const denied = await tool(w, 'dshmemory_file_read', { root: f.project, path: '../foreign/README.md' }) as any; assert.equal(denied.failed, true);
  assert.equal(sha(join(f.project, 'README.md')), before); assert.equal(f.events.length, 0); await w.stop();
});
test('custom-renamed DSH session source directory is automatically denied to project file tools', async () => {
  const f = fixture(); f.config.workspaceFilesEnabled = true; const source = join(f.project, 'renamed-source'); mkdirSync(source); writeFileSync(join(source, 'source.json'), '{"synthetic":"session source"}');
  f.config.sessionsDir = source; const w = f.make(); await w.start(f.host); assert.ok(w.status().files.denied.includes(source));
  const result = await tool(w, 'dshmemory_file_read', { root: f.project, path: 'renamed-source/source.json' }) as any; assert.equal(result.failed, true);
  const listing = parse(await tool(w, 'dshmemory_files_list', { root: f.project, path: '.' })); assert.ok(!listing.entries.some((entry: any) => entry.path === 'renamed-source')); await w.stop();
});
test('World stop closes file continuation handles and makes earlier cursors unusable', async () => {
  const f = fixture(); f.config.workspaceFilesEnabled = true; writeFileSync(join(f.project, 'one.md'), 'one'); writeFileSync(join(f.project, 'two.md'), 'two');
  const w = f.make(); await w.start(f.host); const reader = (w as any).files;
  const first = parse(await tool(w, 'dshmemory_files_list', { root: f.project, path: '.', limit: 1 })); assert.ok(first.nextCursor); await w.stop();
  assert.equal(reader.continuations.size, 0); assert.throws(() => reader.list({ root: f.project, path: '.', cursor: first.nextCursor }), /CURSOR/);
  const result = await tool(w, 'dshmemory_file_read', { root: f.project, path: 'one.md' }) as any; assert.equal(result.failed, true);
});
test('file features and raw sync can be disabled independently while DBless World remains active', async () => {
  const f = fixture(); f.config.rawEnabled = false; const w = f.make(); await w.start(f.host);
  assert.deepEqual(w.tools().map(item => item.name), ['dshmemory_status']); assert.equal(w.status().running, true); assert.equal(w.status().raw.enabled, false); assert.equal(w.status().files.enabled, false); await w.stop();
});
test('workspace audit records effective disabled memory timers and a separate workspace heartbeat', async () => {
  const f = fixture(), w = f.make(); await w.start(f.host); await w.stop(); const checkpoint = JSON.parse(readFileSync(join(f.config.stateDir, 'checkpoint.json'), 'utf8'));
  const day = checkpoint.updatedAt.slice(0, 10); const journal = readFileSync(join(f.config.stateDir, `audit-${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const start = journal.find((entry: any) => entry.kind === 'start'); assert.equal(start.meta.sourceMode, 'workspace'); assert.equal(start.meta.watchIntervalSeconds, 0); assert.equal(start.meta.writeEnabled, false); assert.equal(start.meta.workspaceFilesEnabled, false);
  const heartbeat = journal.find((entry: any) => entry.kind === 'heartbeat'); assert.equal(heartbeat.meta.component, 'workspace'); assert.equal(heartbeat.meta.ok, true); assert.equal(heartbeat.meta.total, null);
});
test('protected conversation buckets are excluded before probing even a malformed synthetic header', async () => {
  const f = fixture(); f.session('authorized', f.project);
  const bucket = '--F-AI-~5BF9~8BDD~8BB0~5F55--', source = join(f.opts.sessionsDir, bucket, 'protected'); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'session.v3.jsonl.zstd'), Buffer.from('malformed protected synthetic record, must never be probed'));
  const result = await syncRaw(f.opts); assert.equal(result.newTurns, 2); assert.deepEqual(result.sourceWarnings, []);
  const protectedMirror = join(f.opts.rawDir, bucket); mkdirSync(protectedMirror); writeFileSync(join(protectedMirror, `${DAY}.jsonl`), 'malformed synthetic mirror');
  assert.equal(rawStats(f.opts.rawDir, f.opts).totalTurns, 2); await assert.rejects(syncRaw({ ...f.opts, buckets: [bucket] }), /受保护/);
});
test('renaming a protected bucket cannot export a header declaring protected conversation cwd', async () => {
  const f = fixture(); f.session('protected-declaration', 'F:/AI/对话记录/private', 'innocent-name'); const result = await syncRaw(f.opts);
  assert.equal(result.newTurns, 0); assert.equal(result.sourceWarnings.length, 1); assert.ok(!JSON.stringify(result.sourceWarnings).includes('F:/AI/对话记录'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.opts.rawDir, '.manifest.json'), 'utf8')).files, {});
});
test('protected workspace literals are rejected before any root existence probe', () => {
  assert.throws(() => bindWorkspaces(['F:/AI/对话记录']), /受保护/); assert.throws(() => bindWorkspaces(['F:/AI/对话备份/private']), /受保护/);
});
test('project file tools omit the synthetic protected conversation directory', async () => {
  const f = fixture(); f.config.workspaceFilesEnabled = true; const folder = join(f.project, '对话记录'); mkdirSync(folder); writeFileSync(join(folder, 'chat.md'), 'synthetic protected source');
  const w = f.make(); await w.start(f.host); const listing = parse(await tool(w, 'dshmemory_files_list', { root: f.project, path: '.' })); assert.ok(!listing.entries.some((entry: any) => entry.path === '对话记录'));
  const result = await tool(w, 'dshmemory_file_read', { root: f.project, path: '对话记录/chat.md' }) as any; assert.equal(result.failed, true); assert.equal(JSON.parse(result.text).code, 'EXCLUDED'); await w.stop();
});
