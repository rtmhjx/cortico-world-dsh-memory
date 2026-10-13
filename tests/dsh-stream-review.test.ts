/** Independent stream/cursor review. All source and mirror fixtures remain in this workbench. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { readRaw, syncRaw, type RawSyncOptions } from '../src/raw.ts';

const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch', 'tests');
mkdirSync(scratch, { recursive: true });
const bucket = '--F-AI-stream-review--';
const day = '2026-10-06';
const ts = Date.parse(`${day}T00:00:00Z`);
const line = (event: unknown): string => JSON.stringify(event) + '\n';
const header = line({ type: 'session', version: 3, id: 'stream-review-session', createdAt: ts });
const human = (text = 'start') => line({ type: 'user/message', seq: 1, time: ts, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
const assistant = (text = 'tail result') => line({ type: 'assistant/message', seq: 9999, time: ts + 1, data: { message: { content: [{ type: 'text', text }] } } });

function fixture(): { opts: RawSyncOptions; file: string; manifest: string; mirror: string } {
  const dir = mkdtempSync(join(scratch, 'dsh-stream-review-'));
  const sessionsDir = join(dir, 'sessions'), rawDir = join(dir, 'raw');
  const session = join(sessionsDir, bucket, 'session-one'); mkdirSync(session, { recursive: true });
  return { opts: { sessionsDir, rawDir, dbFile: join(dir, 'unused.db'), buckets: [bucket], allowedBuckets: [bucket], maxTurns: 100, maxSourceBytes: 64 * 1024 * 1024 },
    file: join(session, 'session.v3.jsonl.zstd'), manifest: join(rawDir, '.manifest.json'), mirror: join(rawDir, bucket, `${day}.jsonl`) };
}

test('a verified 64+ MiB frame advances through budgeted rescans and reaches its final public answer', async () => {
  const f = fixture();
  // Individual JSONL lines stay below the line guard; the single decoded frame exceeds 64 MiB.
  const filler = line({ type: 'tool/result', seq: 2, data: { output: 'x'.repeat(512 * 1024) } });
  const plaintext = header + human() + filler.repeat(130) + assistant('result after 64 MiB prefix');
  assert.ok(Buffer.byteLength(plaintext) > 64 * 1024 * 1024);
  writeFileSync(f.file, zstdCompressSync(plaintext));
  assert.ok(readFileSync(f.file).length < f.opts.maxSourceBytes!);
  let total = 0, previousCursor = '', completed = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await syncRaw({ ...f.opts, maxTurns: 1 }); total += result.newTurns;
    assert.ok(result.scannedBytes <= f.opts.maxSourceBytes!, 'validated source bytes must stay within the configured compressed-byte budget');
    const manifest = JSON.parse(readFileSync(f.manifest, 'utf8'));
    const entries = Object.values(manifest.files) as Array<{ cursor: unknown }>;
    assert.equal(entries.length, 1); const entry = entries[0];
    const cursor = JSON.stringify(entry.cursor);
    assert.ok(cursor !== previousCursor || !result.capped, 'replaying an already consumed large prefix must not hold the cursor permanently');
    previousCursor = cursor;
    if (!result.capped) { completed = true; break; }
  }
  assert.equal(completed, true, 'bounded retries should finish a finite verified frame');
  assert.equal(total, 2);
  const page = readRaw({ rawDir: f.opts.rawDir, bucket, day, limit: 10, allowedBuckets: [bucket] });
  assert.deepEqual(page.turns.map(turn => turn.text), ['start', 'result after 64 MiB prefix']);
  assert.equal((await syncRaw(f.opts)).newTurns, 0);
});

test('multibyte UTF-8 straddling decode chunks survives mirror commit exactly', async () => {
  const f = fixture(); const text = '甲🙂乙é'.repeat(20_000);
  writeFileSync(f.file, zstdCompressSync(header + human(text) + assistant('完成🙂')));
  const result = await syncRaw(f.opts); assert.equal(result.newTurns, 2);
  const page = readRaw({ rawDir: f.opts.rawDir, bucket, day, limit: 10, allowedBuckets: [bucket] });
  assert.equal(page.turns[0].text, text); assert.equal(page.turns[1].text, '完成🙂');
  assert.ok(!page.turns[0].text.includes('\ufffd'));
});

test('validation plus processing does not charge the same compressed frame twice against source budget', async () => {
  const f = fixture(); const budget = 12 * 1024 * 1024;
  const fillers = Array.from({ length: 20 }, (_, index) => line({ type: 'tool/result', seq: index + 2,
    data: { output: randomBytes(384 * 1024).toString('base64') } }));
  const compressed = zstdCompressSync(header + human() + fillers.join('') + assistant('after both passes'));
  assert.ok(compressed.length > budget / 2 && compressed.length < budget, 'fixture must fit once but not twice in its compressed source budget');
  writeFileSync(f.file, compressed);
  const result = await syncRaw({ ...f.opts, maxSourceBytes: budget });
  assert.equal(result.newTurns, 2); assert.equal(result.capped, false); assert.ok(result.scannedBytes <= budget);
  assert.deepEqual(readRaw({ rawDir: f.opts.rawDir, bucket, day, limit: 10 }).turns.map(turn => turn.text), ['start', 'after both passes']);
});

test('a complete checksum-bad frame never contributes a public row or a committed source cursor', async () => {
  const f = fixture();
  const broken = zstdCompressSync(header + human('unverified public request') + assistant('unverified answer'), { params: { 201: 1 } });
  broken[broken.length - 1] ^= 1; writeFileSync(f.file, broken);
  await assert.rejects(async () => { await syncRaw(f.opts); }, /解压|checksum|zstd|原文验证/i);
  assert.equal(existsSync(f.manifest), false, 'failed full-frame validation cannot stamp a completed cursor');
  assert.equal(existsSync(f.mirror), false, 'lines emitted before a checksum failure must not enter the public mirror');
});

test('resuming inside a frame rejects same-header source rewrites and preserves the previous mirror/checkpoint', async () => {
  const f = fixture(); writeFileSync(f.file, zstdCompressSync(header + human() + assistant('original answer')));
  assert.equal((await syncRaw({ ...f.opts, maxTurns: 1 })).newTurns, 1);
  const checkpoint = readFileSync(f.manifest), mirror = readFileSync(f.mirror);
  const entries = Object.values(JSON.parse(checkpoint.toString()).files) as Array<{ cursor: { frameHash?: string } }>;
  assert.equal(entries.length, 1); assert.match(entries[0].cursor.frameHash ?? '', /^[a-f0-9]{64}$/);
  // Session identity remains the same, while the already verified frame bytes change.
  writeFileSync(f.file, zstdCompressSync(header + human() + assistant('rewritten answer')));
  await assert.rejects(async () => { await syncRaw(f.opts); }, /帧|源.*变|fingerprint|游标/i);
  assert.deepEqual(readFileSync(f.manifest), checkpoint);
  assert.deepEqual(readFileSync(f.mirror), mirror);
});

test('a completed uncompressed source rewritten in place at equal size cannot silently keep an EOF cursor', async () => {
  const f = fixture(); const plainFile = f.file.replace(/\.zstd$/, '');
  const original = header + human() + assistant('original answer');
  const rewritten = header + human() + assistant('rewritten reply');
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(rewritten));
  writeFileSync(plainFile, original); await syncRaw(f.opts);
  const checkpoint = readFileSync(f.manifest), mirror = readFileSync(f.mirror);
  writeFileSync(plainFile, rewritten);
  await assert.rejects(async () => { await syncRaw(f.opts); }, /源|会话|变化|改写|replac|changed/i);
  assert.deepEqual(readFileSync(f.manifest), checkpoint);
  assert.deepEqual(readFileSync(f.mirror), mirror);
});

test('a 2+ MiB JSONL event fails explicitly without stamping the source as complete', async () => {
  const f = fixture();
  const oversized = human('x'.repeat(2 * 1024 * 1024));
  writeFileSync(f.file, zstdCompressSync(header + oversized + assistant()));
  await assert.rejects(async () => { await syncRaw(f.opts); }, /单条|单行|行.*预算|2 MiB|line/i);
  assert.equal(existsSync(f.manifest), false);
  assert.equal(existsSync(f.mirror), false);
});
