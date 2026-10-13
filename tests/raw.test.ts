/**
 * 原文镜像（v0.3.0）的行为测试：多帧 zstd 解码、对话抽取、增量同步、清洗、检索。
 * 全部用合成数据落在 scratch/ 下的临时目录，不碰真实库与真实会话。
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { scanZstdFrames, decodeZstdStream } from '../src/zstd.ts';
import { bucketLabel, extractTurns, readRaw, resolveRawPaths, scrubText, searchRaw, syncRaw } from '../src/raw.ts';
const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch', 'tests');
mkdirSync(scratch, { recursive: true });
const runDir = mkdtempSync(join(scratch, 'raw-'));
const sessionsDir = join(runDir, 'sessions');
const rawDir = join(runDir, 'raw');
after(() => rmSync(runDir, { recursive: true, force: true }));
/** 合成一份会话明文：两轮真人对白 + 夹着插件注入、思维链、工具调用（都该被滤掉）。 */
/** 夹具的固定日期：镜像按轮次的 UTC 日期分文件，所以时间要落在同一天。 */
const FIXTURE_DAY = '2026-09-30';
const BASE = Date.parse(`${FIXTURE_DAY}T02:00:00Z`);
function sessionPlaintext(): string {
    const line = (o: unknown) => JSON.stringify(o) + '\n';
    return line({ type: 'session', version: 3 })
        + line({ type: 'user/message', time: BASE, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句：帮我看下 sk-TESTONLY0123456789TESTONLY0123456789 这个 key' }] } })
        + line({ type: 'assistant/message', time: BASE + 100, data: { message: { content: [{ type: 'reasoning', text: '心里话不该进镜像' }, { type: 'text', text: '第一答：好的' }] } } })
        + line({ type: 'turn/end', time: BASE + 110, data: { turn: 1 } })
        + line({ type: 'tool/call', time: BASE + 150, data: { name: 'pwsh', arguments: '{"command":"dir"}' } })
        + line({ type: 'tool/result', time: BASE + 160, data: { output: '工具回执不该进镜像' } })
        + line({ type: 'user/message', time: BASE + 200, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '插件注入不该进镜像' }] } })
        + line({ type: 'assistant/message', time: BASE + 250, data: { message: { content: [{ type: 'text', text: '没有真人输入时的助手话不该成轮' }] } } })
        + line({ type: 'user/message', time: BASE + 300, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二句：apikey_0123456789abcdef0123456789abcdef0123_a50a372b98799701f95229267d03ce99 拿到了' }] } })
        + line({ type: 'assistant/message', time: BASE + 400, data: { message: { content: [{ type: 'text', text: '第二答：收到' }] } } });
}
/** 把明文按「每两行一帧」压成多帧 zstd —— 与 DSH 的追加式容器同形。 */
function multiFrame(text: string, linesPerFrame = 2): Buffer {
    const lines = text.split('\n').filter((l) => l.trim()).map((l) => l + '\n');
    const frames: Buffer[] = [];
    for (let i = 0; i < lines.length; i += linesPerFrame) {
        frames.push(zstdCompressSync(lines.slice(i, i + linesPerFrame).join('')));
    }
    return Buffer.concat(frames);
}
// ── 多帧解码 ────────────────────────────────────────────────────────────────
test('多帧 zstd：扫出每一帧，拼接后与原文逐字相同（Node 自带解压只吃第一帧，所以要自己扫）', () => {
    const text = sessionPlaintext();
    const buffer = multiFrame(text, 2);
    const { frames, tornStart } = scanZstdFrames(buffer);
    assert.equal(tornStart, undefined);
    assert.ok(frames.length >= 4, `应扫出多帧，实际 ${frames.length}`);
    assert.equal(decodeZstdStream(buffer), text);
});
test('多帧 zstd：末尾半帧不算完整帧，已完整的照解（会话文件正在写时就是这样）', () => {
    const buffer = multiFrame(sessionPlaintext(), 2);
    const torn = Buffer.concat([buffer, zstdCompressSync('{"type":"user/message"').subarray(0, 12)]);
    const scan = scanZstdFrames(torn);
    assert.equal(typeof scan.tornStart, 'number');
    assert.equal(decodeZstdStream(torn), decodeZstdStream(buffer));
});
test('多帧 zstd：魔数不对就抛错，不静默返回空', () => {
    assert.throws(() => scanZstdFrames(Buffer.from('not a zstd frame at all')), /魔数/);
});
// ── 对话抽取 ────────────────────────────────────────────────────────────────
test('抽取：只留真人输入与助手正文；插件注入、思维链、工具调用回执都不进来', () => {
    const turns = extractTurns(sessionPlaintext());
    assert.equal(turns.length, 4);
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
    assert.match(turns[0]!.text, /第一句/);
    assert.match(turns[1]!.text, /第一答/);
    assert.match(turns[3]!.text, /第二答/);
    const all = turns.map((t) => t.text).join('\n');
    for (const banned of ['心里话', '工具回执', '插件注入', '没有真人输入']) {
        assert.ok(!all.includes(banned), `不该收录：${banned}`);
    }
});
// ── 清洗 ────────────────────────────────────────────────────────────────────
test('清洗：sk- 与「key 字样后跟高熵串」都替换掉（包括没有冒号的 apikey_ 写法）', () => {
    const out = scrubText('a sk-TESTONLY0123456789TESTONLY0123456789 b apikey_0123456789abcdef0123456789abcdef0123 c');
    assert.ok(!out.includes('sk-TESTONLY0123456789TESTONLY0123456789'));
    assert.ok(!out.includes('0123456789abcdef0123456789abcdef0123'));
    assert.match(out, /<已隐去>/);
});
// ── 增量同步 / 检索 / 读取 ───────────────────────────────────────────────────
test('同步：首次收录全部新轮次、二次调用不重复收录；镜像里已洗净密钥', async () => {
    const bucket = '--F-AI-test--';
    const sessionDir = join(sessionsDir, bucket, 'session-aaaa1111');
    mkdirSync(sessionDir, { recursive: true });
    // 小会话也必须可读，完整帧后不能加任意坏字节伪装大小。
    const head = zstdCompressSync(JSON.stringify({ type: 'session', version: 3 }) + '\n');
    const body = multiFrame(sessionPlaintext(), 2);
    writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), Buffer.concat([head, body]));
    const first = await syncRaw({ sessionsDir, rawDir, dbFile: join(runDir, 'memory.db'), buckets: [], maxTurns: 1000 });
    assert.equal(first.ok, true);
    assert.equal(first.newTurns, 4);
    assert.equal(first.perBucket[bucket], 4);
    const second = await syncRaw({ sessionsDir, rawDir, dbFile: join(runDir, 'memory.db'), buckets: [], maxTurns: 1000 });
    assert.equal(second.newTurns, 0, '第二次同步不该重复收录');
    const files = readFileSync(join(rawDir, bucket, `${FIXTURE_DAY}.jsonl`), 'utf8');
    assert.ok(files.includes('第一句'));
    assert.ok(!files.includes('sk-TESTONLY0123456789TESTONLY0123456789'), '镜像里不该留明文 key');
    assert.ok(!files.includes('0123456789abcdef0123456789abcdef0123'), '镜像里不该留 apikey_ 长串');
});
test('检索：字面子串命中并带工作区/日期/角色；读原文可按行分页', () => {
    const hits = searchRaw({ rawDir, query: '第一答', limit: 10 });
    assert.equal(hits.hits.length, 1);
    assert.equal(hits.hits[0]!.role, 'assistant');
    assert.match(hits.hits[0]!.excerpt, /第一答/);
    const bucket = '--F-AI-test--';
    const day = FIXTURE_DAY;
    const page = readRaw({ rawDir, bucket, day, offset: 0, limit: 2 });
    assert.equal(page.total, 4);
    assert.equal(page.returned, 2);
    assert.equal(page.truncated, true);
    const rest = readRaw({ rawDir, bucket, day, offset: 2, limit: 10 });
    assert.equal(rest.returned, 2);
    assert.equal(rest.truncated, false);
});
test('路径：sessionsDir/rawDir 留空时分别落到 ~/.dsh/sessions 与记忆库同级的 raw/', () => {
    const paths = resolveRawPaths({ sessionsDir: '', rawDir: '', dbFile: '/tmp/deploy/data/memory.db' });
    assert.ok(paths.sessionsDir.endsWith(join('.dsh', 'sessions')));
    assert.equal(paths.rawDir, join('/tmp/deploy/data', 'raw'));
});
test('桶名：波浪号十六进制还原成可读标签，非法文件名字符被换掉', () => {
    assert.equal(bucketLabel('--F-AI-~5411~91CF~8BB0~5FC6~5E93--'), 'AI-向量记忆库');
    assert.equal(bucketLabel('--C-Users-example-3D~0020Objects-AI-app--'), 'AI-app');
});
test('同步：maxTurns 上限生效并如实报告 capped（剩下的留到下次）', async () => {
    const bucket = '--F-AI-cap--';
    const sessionDir = join(sessionsDir, bucket, 'session-bbbb2222');
    mkdirSync(sessionDir, { recursive: true });
    const head = zstdCompressSync(JSON.stringify({ type: 'session', version: 3 }) + '\n');
    writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), Buffer.concat([head, multiFrame(sessionPlaintext(), 2)]));
    const capped = await syncRaw({ sessionsDir, rawDir, dbFile: join(runDir, 'memory.db'), buckets: [bucket], maxTurns: 2 });
    assert.equal(capped.newTurns, 2);
    assert.equal(capped.capped, true);
    const rest = await syncRaw({ sessionsDir, rawDir, dbFile: join(runDir, 'memory.db'), buckets: [bucket], maxTurns: 1000 });
    assert.equal(rest.newTurns, 2, '被上限挡住的轮次下次补齐');
    assert.equal(rest.capped, false);
});
test('同步：会话目录不存在时报错，不静默成功', async () => {
    await assert.rejects(async () => await syncRaw({ sessionsDir: join(runDir, 'nope'), rawDir, dbFile: join(runDir, 'memory.db'), buckets: [], maxTurns: 10 }), /会话目录不存在/);
});
test('镜像区不存在时检索返回空、不抛错（还没同步过就是这样）', () => {
    const empty = join(runDir, 'raw-empty');
    assert.equal(existsSync(empty), false);
    assert.deepEqual(searchRaw({ rawDir: empty, query: '任意', limit: 5 }).hits, []);
});
