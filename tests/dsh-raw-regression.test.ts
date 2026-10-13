import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { bucketLabel, extractTurns, rawStats, readRaw, SCRUB_VERSION, scrubText, searchRaw, syncRaw, type RawSyncOptions } from '../src/raw.ts';
const scratch = resolve('scratch/tests');
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, 'dsh-raw-regression-'));
after(() => { assert.ok(root.startsWith(scratch + '\\') || root.startsWith(scratch + '/')); rmSync(root, { recursive: true, force: true }); });
const DAY = '2026-10-05';
const TS = Date.parse(`${DAY}T01:00:00Z`);
let count = 0;
function fixture(): RawSyncOptions {
    const dir = join(root, String(++count));
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    return { sessionsDir, rawDir: join(dir, 'raw'), dbFile: join(dir, 'memory.db'), buckets: [], maxTurns: 1000 };
}
const line = (event: unknown): string => JSON.stringify(event) + '\n';
const human = (text = 'question', seq = 1): unknown => ({ type: 'user/message', seq, time: TS + seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
const assistant = (text = 'answer', seq = 2): unknown => ({ type: 'assistant/message', seq, time: TS + seq, data: { message: { content: [{ type: 'text', text }] } } });
function source(opts: RawSyncOptions, bucket: string, events: unknown[] = [human(), assistant()], suffix = '.zstd', header: unknown = { type: 'session', version: 3, id: 'session-a', createdAt: TS }): string {
    const dir = join(opts.sessionsDir, bucket, 'session-a');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v3.jsonl' + suffix);
    const rows = [header, ...events].map(line);
    writeFileSync(file, suffix ? Buffer.concat(rows.map((row) => zstdCompressSync(row))) : rows.join(''));
    return file;
}
function mirror(opts: RawSyncOptions, bucket: string, rows: unknown[], day = DAY): string {
    const dir = join(opts.rawDir, bucket);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${day}.jsonl`);
    writeFileSync(file, rows.map(line).join(''));
    return file;
}
function row(text: string, ts = `${DAY}T01:00:00.000Z`): unknown { return { ts, role: 'assistant', win: 'session-', text }; }
test('all public assistant steps survive tools/plugin messages; lifecycle closes the human turn', () => {
    const messages = [human(), assistant('progress'), { type: 'user/message', time: TS + 3, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'injected' }] } }, { type: 'tool/result', data: { output: 'secret tool' } }, assistant('final', 5), { type: 'turn/end' }, assistant('orphan', 6)];
    const turns = extractTurns(messages.map(line).join(''));
    assert.deepEqual(turns.map((turn) => turn.text), ['question', 'progress', 'final']);
    assert.notEqual(turns[1]!.sourceId, turns[2]!.sourceId);
});
test('quoted JSON, short quoted credentials, bare keys, URL tokens and Bearer values are scrubbed', () => {
    const secrets = ['tiny-secret', 'longSecret123456789', 'long-token-987654321', 'aaaaaaaaaaaaaaaaaaaa'];
    const out = scrubText(`{"api_key":"${secrets[0]}","access_token":"${secrets[1]}"} token=${secrets[2]} Bearer ${secrets[3]} https://test.invalid?q=one&token=abcdef`);
    for (const secret of [...secrets, 'abcdef'])
        assert.ok(!out.includes(secret), secret);
    assert.match(out, /已隐去/);
});
test('legacy read and search scrub at the boundary without rewriting original mirror bytes', () => {
    const opts = fixture();
    const bucket = 'legacy';
    const file = mirror(opts, bucket, [row('needle {"api_key":"tiny-secret"}')]);
    const before = readFileSync(file, 'utf8');
    const page = readRaw({ rawDir: opts.rawDir, bucket, day: DAY, limit: 10 });
    const hits = searchRaw({ rawDir: opts.rawDir, query: 'needle', limit: 10 });
    assert.ok(!page.turns[0]!.text.includes('tiny-secret'));
    assert.ok(!hits.hits[0]!.excerpt.includes('tiny-secret'));
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(rawStats(opts.rawDir).legacy, true);
    assert.equal(rawStats(opts.rawDir).scrubMismatch, true);
});
test('bucket traversal and absolute paths are rejected before filesystem reads', () => {
    const opts = fixture();
    mirror(opts, 'safe', [row('safe')]);
    for (const bucket of ['../outside', '..\\outside', 'F:\\outside', '/outside', '.', '..', 'a/b', 'safe.']) {
        assert.throws(() => readRaw({ rawDir: opts.rawDir, bucket, day: DAY, limit: 10 }), /bucket/);
        assert.throws(() => searchRaw({ rawDir: opts.rawDir, bucket, query: 'safe', limit: 10 }), /bucket/);
    }
    assert.throws(() => readRaw({ rawDir: opts.rawDir, bucket: 'safe', day: '2026-02-30', limit: 1 }), /day/);
});
test('raw read/search/stats enforce the same exact source bucket scope', () => {
    const opts = fixture();
    mirror(opts, '--F-AI-C--', [row('allowed')]);
    mirror(opts, '--F-CODEX-C--', [row('denied')]);
    const scope = ['--F-AI-C--'];
    assert.throws(() => readRaw({ rawDir: opts.rawDir, bucket: '--F-CODEX-C--', day: DAY, limit: 10, allowedBuckets: scope }), /rawBuckets/);
    assert.throws(() => searchRaw({ rawDir: opts.rawDir, bucket: '--F-CODEX-C--', query: 'denied', limit: 10, allowedBuckets: scope }), /rawBuckets/);
    assert.deepEqual(searchRaw({ rawDir: opts.rawDir, query: 'denied', limit: 10, allowedBuckets: scope }).hits, []);
    assert.equal(rawStats(opts.rawDir, { allowedBuckets: scope }).totalTurns, 1);
});
test('sync caller buckets cannot broaden configured scope, and short label aliases cannot broaden it', async () => {
    const opts = fixture();
    source(opts, '--F-AI-C--');
    source(opts, '--G-AI-C--');
    assert.equal(bucketLabel('--F-AI-C--'), bucketLabel('--G-AI-C--'));
    await assert.rejects(async () => await syncRaw({ ...opts, buckets: ['--G-AI-C--'], allowedBuckets: ['--F-AI-C--'] }), /rawBuckets/);
    const result = await syncRaw({ ...opts, allowedBuckets: ['--F-AI-C--'] });
    assert.equal(result.newTurns, 2);
    assert.equal(existsSync(join(opts.rawDir, '--G-AI-C--')), false);
    await syncRaw({ ...opts, buckets: ['--G-AI-C--'] });
    assert.equal(rawStats(opts.rawDir).buckets.length, 2);
});
test('protected source buckets are excluded without opening their content; mirror buckets also excluded', async () => {
    const opts = fixture();
    const protectedBucket = '--F-AI-~5BF9~8BDD~5907~4EFD--';
    const denied = join(opts.sessionsDir, protectedBucket);
    mkdirSync(denied, { recursive: true });
    writeFileSync(join(denied, 'session.v3.jsonl.zstd'), 'BROKEN MUST NOT READ');
    source(opts, '--F-AI-safe--');
    assert.equal((await syncRaw(opts)).newTurns, 2);
    const protectedMirror = join(opts.rawDir, protectedBucket);
    mkdirSync(protectedMirror, { recursive: true });
    writeFileSync(join(protectedMirror, `${DAY}.jsonl`), 'BROKEN MUST NOT READ');
    assert.equal(rawStats(opts.rawDir).totalTurns, 2);
    assert.equal(searchRaw({ rawDir: opts.rawDir, query: 'BROKEN', limit: 10 }).hits.length, 0);
    await assert.rejects(async () => await syncRaw({ ...opts, buckets: [protectedBucket] }), /受保护/);
});
test('source session header rejects a protected cwd even in a renamed bucket', async () => {
    const opts = fixture();
    source(opts, '--renamed--', [human()], '.zstd', { type: 'session', cwd: 'F:\\AI\\对话备份\\nested' });
    await assert.rejects(async () => await syncRaw(opts), /受保护/);
    assert.equal(existsSync(join(opts.rawDir, '--renamed--')), false);
});
test('junction escapes are rejected for mirror read/search/stats and for source recursion', async () => {
    const opts = fixture();
    const outside = join(root, 'outside-' + count);
    mkdirSync(outside);
    writeFileSync(join(outside, `${DAY}.jsonl`), line(row('outside')));
    mkdirSync(opts.rawDir);
    symlinkSync(outside, join(opts.rawDir, 'escape'), 'junction');
    assert.throws(() => readRaw({ rawDir: opts.rawDir, bucket: 'escape', day: DAY, limit: 10 }), /越过/);
    assert.throws(() => searchRaw({ rawDir: opts.rawDir, query: 'outside', limit: 10 }), /越过/);
    assert.throws(() => rawStats(opts.rawDir), /越过/);
    symlinkSync(outside, join(opts.sessionsDir, 'escape'), 'junction');
    await assert.rejects(async () => await syncRaw({ ...opts, rawDir: join(root, 'raw-new-' + count) }), /越过/);
});
test('malformed manifest refuses sync and preserves existing source/mirror bytes', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    const file = mirror(opts, '--safe--', [row('existing')]);
    const before = readFileSync(file);
    writeFileSync(join(opts.rawDir, '.manifest.json'), '{broken');
    await assert.rejects(async () => await syncRaw(opts), /清单.*损坏/);
    assert.deepEqual(readFileSync(file), before);
    assert.throws(() => rawStats(opts.rawDir), /清单.*损坏/);
});
test('malformed manifest cursor is rejected, not implicitly reset', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    mkdirSync(opts.rawDir);
    writeFileSync(join(opts.rawDir, '.manifest.json'), JSON.stringify({ version: 2, scrub: SCRUB_VERSION, files: { x: { turns: -1 } } }));
    await assert.rejects(async () => await syncRaw(opts), /游标无效/);
});
test('scrub mismatch remains after multiple successful incremental syncs', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    mkdirSync(opts.rawDir);
    writeFileSync(join(opts.rawDir, '.manifest.json'), JSON.stringify({ version: 1, scrub: 2, files: {} }));
    assert.equal((await syncRaw(opts)).scrubMismatch, true);
    assert.equal((await syncRaw(opts)).scrubMismatch, true);
    assert.equal(rawStats(opts.rawDir).scrubMismatch, true);
    assert.equal(JSON.parse(readFileSync(join(opts.rawDir, '.manifest.json'), 'utf8')).scrub, 2);
});
test('new mirrors use current scrub stamp, complete metadata counts and source status', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    const result = await syncRaw(opts);
    const stats = rawStats(opts.rawDir, { sessionsDir: opts.sessionsDir });
    assert.equal(result.scrubMismatch, false);
    assert.equal(stats.scrubMismatch, false);
    assert.equal(stats.totalTurns, 2);
    assert.equal(stats.lastSyncAt, result.lastSyncAt);
    assert.equal(stats.sourceUnavailable, false);
    assert.equal(rawStats(opts.rawDir, { sessionsDir: join(root, 'not-found') }).sourceUnavailable, true);
    assert.equal(readdirSync(opts.rawDir).some((file) => file.endsWith('.tmp') || file === '.sync.lock'), false);
});
test('raw search considers all buckets before applying newest-first limit', () => {
    const opts = fixture();
    mirror(opts, 'a-first', [row('needle old', '2026-10-01T00:00:00Z')]);
    mirror(opts, 'z-last', [row('needle newest', '2026-10-05T23:00:00Z'), row('needle second', '2026-10-04T23:00:00Z')]);
    const result = searchRaw({ rawDir: opts.rawDir, query: 'needle', limit: 1 });
    assert.equal(result.hits[0]!.bucket, 'z-last');
    assert.match(result.hits[0]!.excerpt, /newest/);
    assert.equal(result.scannedFiles, 2);
    assert.equal(result.truncated, true);
});
test('unchanged session stat signature skips decompression; appends resume frame cursor', async () => {
    const opts = fixture();
    const file = source(opts, '--safe--');
    assert.equal((await syncRaw(opts)).newTurns, 2);
    const unchanged = await syncRaw(opts);
    assert.equal(unchanged.scannedBytes, 0);
    assert.equal(unchanged.sessionsScanned, 0);
    appendFileSync(file, zstdCompressSync(line(assistant('final reply', 3))));
    const result = await syncRaw(opts);
    assert.equal(result.newTurns, 1);
    assert.deepEqual(readRaw({ rawDir: opts.rawDir, bucket: '--safe--', day: DAY, limit: 10 }).turns.map((turn) => turn.text), ['question', 'answer', 'final reply']);
});
test('lost checkpoint commit recovers by source itemId, not timestamp watermark', async () => {
    const opts = fixture();
    const file = source(opts, '--safe--');
    await syncRaw(opts);
    const checkpoint = readFileSync(join(opts.rawDir, '.manifest.json'));
    appendFileSync(file, zstdCompressSync(line(assistant('same-time final', 2)))); // Same seq is a duplicate identity, not a distinct event.
    appendFileSync(file, zstdCompressSync(line(assistant('new distinct final', 3))));
    await syncRaw(opts);
    writeFileSync(join(opts.rawDir, '.manifest.json'), checkpoint);
    assert.equal((await syncRaw(opts)).newTurns, 0);
    const page = readRaw({ rawDir: opts.rawDir, bucket: '--safe--', day: DAY, limit: 10 });
    assert.equal(page.total, 3);
    assert.equal(new Set(page.turns.map((turn) => turn.itemId)).size, 3);
});
test('missing manifest after append does not duplicate mirrors with stable IDs', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    await syncRaw(opts);
    rmSync(join(opts.rawDir, '.manifest.json'));
    assert.equal((await syncRaw(opts)).newTurns, 0);
    assert.equal(readRaw({ rawDir: opts.rawDir, bucket: '--safe--', day: DAY, limit: 10 }).total, 2);
});
test('actual atomic manifest rename failure leaves durable appends recoverable without duplicates', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    const rename = fs.renameSync;
    try {
        fs.renameSync = (() => { throw new Error('synthetic disk failure at checkpoint commit'); }) as typeof fs.renameSync;
        syncBuiltinESMExports();
        await assert.rejects(async () => await syncRaw(opts), /synthetic disk failure/);
    }
    finally {
        fs.renameSync = rename;
        syncBuiltinESMExports();
    }
    assert.equal(existsSync(join(opts.rawDir, '.manifest.json')), false);
    assert.equal((await syncRaw(opts)).newTurns, 0);
    assert.equal(readRaw({ rawDir: opts.rawDir, bucket: '--safe--', day: DAY, limit: 10 }).total, 2);
});
test('maxTurns is a bounded public-record scan; frames with multiple lines resume without loss', async () => {
    const opts = fixture();
    const file = source(opts, '--safe--');
    writeFileSync(file, zstdCompressSync([line({ type: 'session', version: 3 }), line(human()), ...[2, 3, 4, 5].map((seq) => line(assistant('answer-' + seq, seq)))].join('')));
    assert.equal((await syncRaw({ ...opts, maxTurns: 1 })).newTurns, 1);
    assert.equal((await syncRaw({ ...opts, maxTurns: 2 })).newTurns, 2);
    assert.equal((await syncRaw({ ...opts, maxTurns: 2 })).newTurns, 2);
    assert.equal((await syncRaw(opts)).newTurns, 0);
    assert.equal(readRaw({ rawDir: opts.rawDir, bucket: '--safe--', day: DAY, limit: 10 }).total, 5);
});
test('valid immutable generation frame above 8 MiB streams both passes and resumes by frame line cursor', async () => {
    const opts = fixture();
    const file = source(opts, '--large-frame--');
    const filler = line({ type: 'tool/result', seq: 2, data: { output: 'x'.repeat(256 * 1024) } });
    const publicEvents = line(human('start', 1)) + filler.repeat(36) + line(assistant('first reply', 3)) + line(assistant('final reply', 4));
    const plaintext = line({ type: 'session', version: 3 }) + publicEvents;
    const bytes = Buffer.byteLength(plaintext);
    assert.ok(bytes > 8 * 1024 * 1024);
    writeFileSync(file, zstdCompressSync(plaintext));
    const first = await syncRaw({ ...opts, maxTurns: 2 });
    assert.equal(first.newTurns, 2);
    assert.equal(first.validationDecodedBytes, bytes);
    assert.ok(first.decodedBytes < bytes && first.decodedBytes > 8 * 1024 * 1024);
    const second = await syncRaw(opts);
    assert.equal(second.newTurns, 1);
    assert.deepEqual(readRaw({ rawDir: opts.rawDir, bucket: '--large-frame--', day: DAY, limit: 10 }).turns.map((turn) => turn.text), ['start', 'first reply', 'final reply']);
});
test('truly corrupt complete frame preserves Node error and byte location and does not commit cursor', async () => {
    const opts = fixture();
    const file = source(opts, '--broken-frame--');
    const valid = readFileSync(file);
    const broken = zstdCompressSync(line(assistant('never decode', 3)), { params: { 201: 1 } });
    broken[broken.length - 1] ^= 0xff;
    appendFileSync(file, broken);
    await assert.rejects(async () => await syncRaw(opts), (error: unknown) => error instanceof Error && /file=.*broken-frame.*frameOffset=/.test(error.message) && /nodeCode=/.test(error.message) && /nodeMessage=/.test(error.message));
    assert.equal(existsSync(join(opts.rawDir, '.manifest.json')), false);
    writeFileSync(file, valid);
    assert.equal((await syncRaw(opts)).newTurns, 0);
});
test('source byte budget is explicit and retains complete-record cursor', async () => {
    const opts = fixture();
    source(opts, '--safe--', [human(), assistant('x'.repeat(5000))]);
    await assert.rejects(() => syncRaw({ ...opts, maxSourceBytes: 10 }), /单压缩帧超过完整校验预算.*不能追赶/);
    assert.equal(existsSync(join(opts.rawDir, '.manifest.json')), false);
    assert.equal((await syncRaw(opts)).newTurns, 2);
});
test('partial final compression frame waits and only advances once complete', async () => {
    const opts = fixture();
    const file = source(opts, '--safe--');
    const extra = zstdCompressSync(line(assistant('delayed-final', 3)));
    appendFileSync(file, extra.subarray(0, 8));
    assert.equal((await syncRaw(opts)).newTurns, 2);
    assert.equal((await syncRaw(opts)).newTurns, 0);
    appendFileSync(file, extra.subarray(8));
    assert.equal((await syncRaw(opts)).newTurns, 1);
});
test('complete malformed source JSON fails without committing manifest and recovery dedupes prior appends', async () => {
    const opts = fixture();
    const file = source(opts, '--safe--');
    const valid = readFileSync(file);
    appendFileSync(file, zstdCompressSync('{broken}\n'));
    await assert.rejects(async () => await syncRaw(opts), /JSON 损坏/);
    assert.equal(existsSync(join(opts.rawDir, '.manifest.json')), false);
    writeFileSync(file, valid);
    assert.equal((await syncRaw(opts)).newTurns, 0);
    assert.equal(readRaw({ rawDir: opts.rawDir, bucket: '--safe--', day: DAY, limit: 10 }).total, 2);
});
test('truncated/replaced sources fail closed instead of resetting an established cursor', async () => {
    const opts = fixture();
    const file = source(opts, '--safe--');
    await syncRaw(opts);
    const before = readFileSync(join(opts.rawDir, '.manifest.json'));
    writeFileSync(file, zstdCompressSync(line({ type: 'session', version: 3, id: 'session-a', createdAt: TS })));
    await assert.rejects(async () => await syncRaw(opts), /截短/);
    assert.deepEqual(readFileSync(join(opts.rawDir, '.manifest.json')), before);
});
test('highest immutable source generation is selected once; uncompressed JSONL also supported', async () => {
    const opts = fixture();
    const file = source(opts, '--safe--', [human(), assistant('current')], '');
    writeFileSync(join(file, '..', 'session.v2.jsonl.zstd'), zstdCompressSync(line({ type: 'session', version: 2 }) + line(human()) + line(assistant('obsolete'))));
    assert.equal((await syncRaw(opts)).newTurns, 2);
    assert.deepEqual(readRaw({ rawDir: opts.rawDir, bucket: '--safe--', day: DAY, limit: 10 }).turns.map((turn) => turn.text), ['question', 'current']);
});
test('subagent session headers are excluded', async () => {
    const opts = fixture();
    source(opts, '--safe--', [human()], '.zstd', { type: 'session', origin: 'subagent', delegationDepth: 1 });
    assert.equal((await syncRaw(opts)).newTurns, 0);
});
test('source and mirror roots cannot overlap', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    await assert.rejects(async () => await syncRaw({ ...opts, rawDir: join(opts.sessionsDir, 'raw') }), /必须分离/);
});
test('World raw worker runs TypeScript source and returns metadata without transcript bodies', async () => {
    const opts = fixture();
    source(opts, '--safe--');
    const result = await new Promise<any>((resolveResult, reject) => {
        const worker = new Worker(new URL('../src/raw-worker.ts', import.meta.url), { workerData: opts });
        worker.once('message', resolveResult);
        worker.once('error', reject);
        worker.once('exit', (code) => { if (code !== 0)
            reject(new Error('worker exit ' + code)); });
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.newTurns, 2);
    assert.equal(result.stats.totalTurns, 2);
    assert.ok(!JSON.stringify(result).includes('question'));
});
