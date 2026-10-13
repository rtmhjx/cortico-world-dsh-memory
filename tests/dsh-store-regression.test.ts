import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dshMemoryDefaults, resolveAccessConfig, LEVELS, SCOPED_LEVELS, type DshMemoryAccess, type Level } from '../src/config.ts';
import { DshMemoryStore, DshMemoryWriter, MemoryError, compareMemoryCursor, memoryCursor, type MemoryCursor, type MemoryDraft } from '../src/store.ts';

const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch', 'tests');
mkdirSync(scratch, { recursive: true });
const code = (expected: string) => (error: unknown) => error instanceof MemoryError && error.code === expected;
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function fixture(wal = true) {
  const dir = mkdtempSync(join(scratch, 'dsh-store-'));
  const dbFile = join(dir, 'memory.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA journal_mode=${wal ? 'WAL' : 'DELETE'}; PRAGMA wal_autocheckpoint=0;`);
  for (const level of LEVELS) {
    const extra = level === 'soul' || level === 'user' ? ''
      : level === 'lesson' ? ', project TEXT, corrected INTEGER NOT NULL DEFAULT 0'
        : level === 'project' ? ', project TEXT NOT NULL, subcategory TEXT'
          : level === 'topic' ? ', project TEXT, goal TEXT' : ', project TEXT';
    db.exec(`CREATE TABLE "${level}" (id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 1, keywords TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
      source_session TEXT, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_accessed_at INTEGER ${extra})`);
  }
  const cfg: DshMemoryAccess = { ...resolveAccessConfig(dshMemoryDefaults()), enabled: true, dbFile,
    allowedProjects: ['alpha', 'beta'], levels: [...LEVELS], includeGlobal: true, writeLevels: [...SCOPED_LEVELS] };
  const store = new DshMemoryStore(cfg);
  const writer = new DshMemoryWriter(cfg);
  function insert(level: Level, id: string, project: string | null, updatedAt = 100, status = 'active') {
    const global = level === 'soul' || level === 'user';
    db.prepare(`INSERT INTO "${level}" (id, title, content, keywords, status, source_session, created_at, updated_at${global ? '' : ', project'})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?${global ? '' : ', ?'})`).run(id, `title-${id}`, `content-${id}`, '["fixture"]', status, 'fixture', 1, updatedAt,
      ...(global ? [] : [project]));
  }
  return { dir, dbFile, db, cfg, store, writer, insert, close() { writer.close(); db.close(); } };
}

test('composite cursor drains equal timestamps across levels and every allowed project without duplicate global/joint rows', () => {
  const f = fixture();
  try {
    f.insert('fact', 'A', 'alpha'); f.insert('fact', 'Z', 'beta'); f.insert('fact', 'a', 'alpha,beta');
    f.insert('fact', 'ä', null); f.insert('lesson', 'a', 'beta'); f.insert('topic', 'a', 'alpha'); f.insert('user', 'a', null);
    f.insert('fact', 'hidden-project', 'alphabet'); f.insert('fact', 'inactive', 'alpha', 100, 'archived');
    f.insert('rules', 'newer', 'beta', 101);
    let cursor: MemoryCursor | null = null;
    const found: string[] = [];
    for (;;) {
      const page = f.store.recentAfter(cursor, 2, 400);
      if (!page.length) break;
      found.push(...page.map(row => `${row.level}:${row.id}`));
      const next = memoryCursor(page.at(-1)!);
      if (cursor) assert.ok(compareMemoryCursor(next, cursor) > 0);
      cursor = next;
    }
    assert.deepEqual(found, ['fact:A', 'fact:Z', 'fact:a', 'fact:ä', 'lesson:a', 'topic:a', 'user:a', 'rules:newer']);
    assert.equal(new Set(found).size, found.length);
    assert.deepEqual(f.store.latestCursor(), { updatedAt: 101, level: 'rules', id: 'newer' });
  } finally { f.close(); }
});

test('SQLite tie filters match the public binary comparator at every cursor boundary', () => {
  const f = fixture();
  try {
    for (const level of ['fact', 'topic', 'rules'] as Level[]) {
      for (const id of ['A', 'Z', 'a', 'ä', '😀']) f.insert(level, id, 'alpha');
    }
    const all = f.store.recentAfter(null, 100, 400);
    for (let i = 0; i < all.length; i++) {
      const expected = all.slice(i + 1).map(row => `${row.level}:${row.id}`);
      const actual = f.store.recentAfter(memoryCursor(all[i]), 100, 400).map(row => `${row.level}:${row.id}`);
      assert.deepEqual(actual, expected);
    }
  } finally { f.close(); }
});

test('latestCursor and metadata stats cover second project, deduplicate repeated levels, and respect global visibility', () => {
  const f = fixture();
  try {
    f.insert('fact', 'alpha', 'alpha', 20); f.insert('fact', 'beta', 'beta', 50); f.insert('fact', 'joint', 'alpha,beta', 30);
    f.insert('fact', 'global', '全局', 40); f.insert('soul', 'global-soul', null, 45);
    f.insert('fact', 'denied', 'alphabet', 999); f.insert('fact', 'inactive', 'alpha', 998, 'stale');
    const store = new DshMemoryStore({ ...f.cfg, levels: ['fact', 'soul', 'fact'] });
    assert.deepEqual(store.stats(), { total: 5, byLevel: { fact: 4, soul: 1 }, latestUpdatedAt: 50 });
    assert.deepEqual(store.latestCursor(), { updatedAt: 50, level: 'fact', id: 'beta' });
    const closed = new DshMemoryStore({ ...f.cfg, includeGlobal: false, levels: ['fact', 'soul'] });
    assert.deepEqual(closed.stats(), { total: 3, byLevel: { fact: 3, soul: 0 }, latestUpdatedAt: 50 });
    assert.ok(!JSON.stringify(store.stats()).includes('content'));
    assert.deepEqual(new DshMemoryStore({ ...f.cfg, levels: ['topic'] }).stats(), { total: 0, byLevel: { topic: 0 }, latestUpdatedAt: null });
    assert.equal(new DshMemoryStore({ ...f.cfg, levels: ['topic'] }).latestCursor(), null);
  } finally { f.close(); }
});

test('legacy timestamp recent remains strictly after watermark and includes the second project', () => {
  const f = fixture();
  try {
    f.insert('fact', 'equal', 'alpha', 20); f.insert('fact', 'second', 'beta', 21);
    assert.deepEqual(f.store.recent(20, 5, 400).map(row => row.id), ['second']);
    assert.equal(f.store.maxUpdatedAt(), 21);
  } finally { f.close(); }
});

test('cursor and SQL truncation inputs fail before constructing an unsafe query', () => {
  const f = fixture();
  try {
    for (const bad of [{ updatedAt: NaN, level: 'fact', id: 'x' }, { updatedAt: 1, level: 'injection', id: 'x' },
      { updatedAt: 1, level: 'fact', id: 42 }, { updatedAt: 1.5, level: 'fact', id: 'x' }]) {
      assert.throws(() => f.store.recentAfter(bad as MemoryCursor, 2, 20), code('invalid_arguments'));
    }
    for (const maxChars of [0, 32_001, 1.5, '1); DROP TABLE fact; --' as unknown as number]) {
      assert.throws(() => f.store.recentAfter(null, 2, maxChars), code('invalid_arguments'));
    }
    f.insert('fact', 'still-present', 'alpha'); assert.equal(f.store.stats().total, 1);
  } finally { f.close(); }
});

test('an empty-ID cursor is a scan boundary but cannot represent an actual memory record', () => {
  const f = fixture();
  try {
    f.insert('fact', 'a', 'alpha', 100); f.insert('fact', 'z', 'beta', 100); f.insert('topic', 'later-level', 'beta', 100);
    f.insert('fact', 'old', 'alpha', 99);
    assert.deepEqual(f.store.recentAfter({ updatedAt: 100, level: 'fact', id: '' }, 100, 1).map(row => row.id), ['a', 'z', 'later-level']);
    assert.throws(() => memoryCursor({ updatedAt: 100, level: 'fact', id: '' }), code('invalid_arguments'));
  } finally { f.close(); }
});

test('new snapshot/metadata queries leave real WAL database and access counters unchanged', () => {
  const f = fixture();
  try {
    f.insert('fact', 'alpha', 'alpha'); f.insert('fact', 'beta', 'beta');
    const before = [digest(f.dbFile), digest(`${f.dbFile}-wal`)];
    f.store.stats(); f.store.latestCursor(); f.store.maxUpdatedAt(); f.store.recentAfter(null, 2, 10);
    assert.deepEqual([digest(f.dbFile), digest(`${f.dbFile}-wal`)], before);
    assert.deepEqual({ ...f.db.prepare('SELECT hit_count,last_accessed_at FROM fact WHERE id=?').get('alpha') }, { hit_count: 0, last_accessed_at: null });
  } finally { f.close(); }
});

test('writeOnce persists once and recovers the exact ID after writer recreation without changing timestamps', () => {
  const f = fixture();
  try {
    const draft: MemoryDraft = { level: 'fact', project: 'beta', content: 'durable retry', title: 'receipt', importance: 5, keywords: ['one', 'one', 'two'] };
    assert.deepEqual(f.writer.writeOnce(draft, 'durable-id'), { id: 'durable-id', inserted: true });
    const before = { ...f.db.prepare('SELECT * FROM fact WHERE id=?').get('durable-id') };
    f.writer.close();
    const resumed = new DshMemoryWriter(f.cfg);
    try { assert.deepEqual(resumed.writeOnce(draft, 'durable-id'), { id: 'durable-id', inserted: false }); } finally { resumed.close(); }
    assert.deepEqual({ ...f.db.prepare('SELECT * FROM fact WHERE id=?').get('durable-id') }, before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM fact').get()?.n, 1);
  } finally { f.close(); }
});

test('writeOnce rejects field/source/status collisions and preserves the existing row', () => {
  const f = fixture();
  try {
    const draft: MemoryDraft = { level: 'fact', project: 'alpha', content: 'first body', title: 'title', importance: 2, keywords: ['k'] };
    f.writer.writeOnce(draft, 'conflict');
    const before = { ...f.db.prepare('SELECT * FROM fact WHERE id=?').get('conflict') };
    for (const changed of [{ content: 'different body' }, { title: 'different title' }, { project: 'beta' }, { importance: 3 }, { keywords: ['new'] }]) {
      assert.throws(() => f.writer.writeOnce({ ...draft, ...changed }, 'conflict'), code('id_conflict'));
    }
    const foreignSource = new DshMemoryWriter({ ...f.cfg, writeSourceLabel: 'different-source' });
    try { assert.throws(() => foreignSource.writeOnce(draft, 'conflict'), code('id_conflict')); } finally { foreignSource.close(); }
    assert.deepEqual({ ...f.db.prepare('SELECT * FROM fact WHERE id=?').get('conflict') }, before);
    f.db.prepare('UPDATE fact SET status=? WHERE id=?').run('archived', 'conflict');
    assert.throws(() => f.writer.writeOnce(draft, 'conflict'), code('id_conflict'));
    assert.equal(f.db.prepare('SELECT status FROM fact WHERE id=?').get('conflict')?.status, 'archived');
  } finally { f.close(); }
});

test('writeOnce checks project subcategory, lesson correction and topic goal on retry', () => {
  const f = fixture();
  try {
    const drafts: MemoryDraft[] = [
      { level: 'project', project: 'alpha', content: 'body', keywords: ['k'], subcategory: 'ops' },
      { level: 'lesson', project: 'alpha', content: 'body', keywords: ['k'], corrected: true },
      { level: 'topic', project: 'alpha', content: 'body', keywords: ['k'], goal: 'complete it' },
    ];
    for (const draft of drafts) {
      assert.equal(f.writer.writeOnce(draft, draft.level).inserted, true);
      assert.equal(f.writer.writeOnce(draft, draft.level).inserted, false);
    }
    assert.throws(() => f.writer.writeOnce({ ...drafts[0], subcategory: 'todo' }, 'project'), code('id_conflict'));
    assert.throws(() => f.writer.writeOnce({ ...drafts[1], corrected: false }, 'lesson'), code('id_conflict'));
    assert.throws(() => f.writer.writeOnce({ ...drafts[2], goal: 'something else' }, 'topic'), code('id_conflict'));
  } finally { f.close(); }
});

test('a real SQLite write lock produces no insert and the identical queued ID commits after release', () => {
  const f = fixture();
  try {
    const draft: MemoryDraft = { level: 'fact', project: 'alpha', content: 'recover after busy', keywords: ['k'] };
    f.db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => f.writer.writeOnce(draft, 'busy-retry'), code('unavailable'));
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM fact WHERE id=?').get('busy-retry')?.n, 0);
    } finally { f.db.exec('ROLLBACK'); }
    assert.deepEqual(f.writer.writeOnce(draft, 'busy-retry'), { id: 'busy-retry', inserted: true });
    assert.deepEqual(f.writer.writeOnce(draft, 'busy-retry'), { id: 'busy-retry', inserted: false });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM fact WHERE id=?').get('busy-retry')?.n, 1);
  } finally { f.close(); }
});

test('exclusive SQLite read lock is explicit and fresh metadata recovers after release', () => {
  const f = fixture(false);
  try {
    f.insert('fact', 'visible', 'beta');
    f.db.exec('BEGIN EXCLUSIVE');
    try { assert.throws(() => f.store.stats(), code('unavailable')); } finally { f.db.exec('ROLLBACK'); }
    assert.equal(f.store.stats().total, 1);
    assert.equal(f.store.latestCursor()?.id, 'visible');
  } finally { f.close(); }
});

test('writer failure does not create a missing database or bypass project/global restrictions', () => {
  const f = fixture();
  try {
    const missing = join(f.dir, 'missing.db');
    const writer = new DshMemoryWriter({ ...f.cfg, dbFile: missing });
    try { assert.throws(() => writer.writeOnce({ level: 'fact', project: 'alpha', content: 'body', keywords: ['k'] }, 'x'), code('unavailable')); } finally { writer.close(); }
    assert.equal(existsSync(missing), false);
    assert.throws(() => f.writer.writeOnce({ level: 'fact', project: 'alphabet', content: 'body', keywords: ['k'] }, 'x'), code('forbidden_project'));
    assert.throws(() => f.writer.writeOnce({ level: 'soul', project: 'alpha', content: 'body', keywords: ['k'] }, 'x'), code('forbidden_level'));
    assert.equal(f.store.stats().total, 0);
  } finally { f.close(); }
});
