/** Append-only DSH public-message mirror. Source files are never modified. */
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { decodeZstdFrameChunks, inspectZstdFrameAt, type ZstdFrameRange } from './zstd.ts';
import { authorizedWorkspace, workspaceScopeHash, type WorkspaceScopeOptions } from './scope.ts';

export const SCRUB_VERSION = 3;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_MIRROR_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROTECTED = ['f:\\ai\\对话备份', 'f:\\ai\\对话记录'];
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Also applied on reads, so existing mirrors cannot expose an old scrub rule. */
export function scrubText(text: string): string {
  return text
    .replace(/(["'`]?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|passwd|password)["'`]?[\s]*[:=＝][\s]*)(["'`])([^"'`\r\n]+)\2/gi, '$1$2<已隐去>$2')
    .replace(/\b(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|passwd|password)[_\-:=＝\s]{1,3}[A-Za-z0-9_\-./+]{8,}/gi, (m) => `${m.split(/[:=＝\s]/)[0].split(/_(?=[A-Za-z0-9]{8,})/)[0]}=<已隐去>`)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-<已隐去>')
    .replace(/\b8ZZ[A-Za-z0-9]{16,}/g, '<token 已隐去>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, 'Bearer <已隐去>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '<jwt 已隐去>')
    .replace(/((?:[?&])(?:token|access_token|key)=)[^\s"'`&]+/gi, '$1<已隐去>')
    .replace(/[0-9a-f]{32,}/gi, '<长十六进制已隐去>');
}
export interface RawTurn { ts: number; role: 'user' | 'assistant'; text: string; sourceId?: string; }
type JsonRecord = Record<string, unknown>;
interface ExtractState { active: boolean; }
function object(value: unknown): JsonRecord | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null; }
function plainContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(object).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c!.text as string).join('\n').trim();
}
function extractEvent(event: JsonRecord, state: ExtractState, ordinal: number): RawTurn | null {
  if (event.type === 'turn/end' || event.type === 'turn/abort') { state.active = false; return null; }
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return null;
  const data = object(event.data);
  const message = event.type === 'user/message' ? data : object(data?.message);
  if (event.type === 'user/message') {
    // Plugin/tool injection does not end a human turn. Only lifecycle boundaries do.
    if (object(data?.source)?.kind !== 'user') return null;
    state.active = true;
  } else if (!state.active) return null;
  const text = plainContent(message?.content); if (!text) return null;
  const role = event.type === 'user/message' ? 'user' : 'assistant';
  const source = Number.isSafeInteger(event.seq) ? `seq:${event.seq}` : typeof message?.id === 'string' ? `id:${message.id}` : `line:${ordinal}`;
  return { ts: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0, role, text, sourceId: `${role}:${source}` };
}
/** Keep later assistant steps and final replies until the next nonhuman/user turn boundary. */
export function extractTurns(plaintext: string): RawTurn[] {
  const state: ExtractState = { active: false }; const turns: RawTurn[] = []; let ordinal = 0;
  for (const line of plaintext.split('\n')) {
    ordinal += 1; if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error(`DSH 原文 JSON 损坏：第 ${ordinal} 行。`); }
    const row = object(event); if (!row) throw new Error(`DSH 原文事件不是对象：第 ${ordinal} 行。`);
    const turn = extractEvent(row, state, ordinal); if (turn) turns.push(turn);
  }
  return turns;
}
function decodeBucket(bucket: string): string { return bucket.replace(/^--|--$/g, '').replace(/~([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))); }
export function bucketLabel(bucket: string): string {
  const decoded = decodeBucket(bucket); const segments = decoded.split('-').filter(Boolean);
  return (segments.slice(-2).join('-') || decoded).replace(/[\\/:*?"<>|]/g, '_').trim();
}
function protectedPath(value: string): boolean {
  const normalized = value.replaceAll('/', '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase();
  return PROTECTED.some(path => normalized === path || normalized.startsWith(path + '\\'));
}
function protectedBucket(bucket: string): boolean { const value = decodeBucket(bucket); return value.includes('对话备份') || value.includes('对话记录'); }
function validateBucket(bucket: string): string {
  if (!bucket || bucket !== bucket.trim() || bucket === '.' || bucket === '..' || /[\\/:\x00-\x1f*?"<>|]/.test(bucket) || bucket.endsWith('.') || bucket.endsWith(' ')) throw new Error('bucket 必须是一个安全目录名，不能含路径分隔符或相对路径。');
  if (protectedBucket(bucket)) throw new Error('受保护的对话备份工作区不允许读取。');
  return bucket;
}
function contained(root: string, target: string): boolean {
  const delta = relative(root, target); return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + sep));
}
/** Resolve existing ancestors so junctions/symlinks cannot bypass the configured root. */
function canonical(path: string): string {
  if (protectedPath(resolve(path))) throw new Error('受保护的对话记录或备份路径不允许访问。');
  let current = resolve(path); const suffix: string[] = [];
  while (!existsSync(current)) { const parent = dirname(current); if (parent === current) break; suffix.unshift(basename(current)); current = parent; }
  const result = join(realpathSync(current), ...suffix);
  if (protectedPath(result)) throw new Error('受保护的对话记录或备份路径不允许访问。');
  return result;
}
function checked(root: string, ...parts: string[]): string {
  const base = canonical(root); const target = canonical(join(root, ...parts));
  if (!contained(base, target)) throw new Error('原文路径越过配置根目录（含符号链接或 junction）。');
  return target;
}
function allowed(bucket: string, scope?: readonly string[]): boolean { return !scope?.length || scope.includes(bucket); }
function enforceAllowed(bucket: string, scope?: readonly string[]): void { validateBucket(bucket); if (!allowed(bucket, scope)) throw new Error(`bucket 不在配置 rawBuckets 范围：${bucket}`); }
function validateScope(scope?: readonly string[]): void { for (const bucket of scope ?? []) validateBucket(bucket); }
function positiveInt(value: number, label: string, max: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} 必须是 1 到 ${max} 的整数。`); }
export interface RawPaths { sessionsDir: string; rawDir: string; }
export function resolveRawPaths(opts: { sessionsDir: string; rawDir: string; dbFile: string }): RawPaths {
  return { sessionsDir: opts.sessionsDir.trim() || join(homedir(), '.dsh', 'sessions'), rawDir: opts.rawDir.trim() || join(dirname(opts.dbFile), 'raw') };
}

interface SourceCursor { frame: number; line: number; ordinal: number; active: boolean; identity: string; frameHash?: string; }
interface ManifestFile { turns: number; updatedAt?: number; cursor?: SourceCursor; size?: number; mtimeMs?: number; ctimeMs?: number; complete?: boolean; sourceCwd?: string; }
interface BucketCounts { days: Record<string, number>; }
interface RawManifest { version: number; scrub: number; updatedAt?: string; sourceSessionsDir?: string; workspaceScopeHash?: string; legacy?: boolean; files: Record<string, ManifestFile>; buckets?: Record<string, BucketCounts>; }
function mirrorBuckets(rawDir: string, scope?: readonly string[]): string[] {
  if (!existsSync(rawDir)) return []; checked(rawDir);
  return readdirSync(rawDir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.') && !protectedBucket(d.name) && (d.isDirectory() || d.isSymbolicLink())).map((d) => d.name)
    .filter((b) => allowed(b, scope)).map((b) => { validateBucket(b); checked(rawDir, b); return b; }).sort();
}
function loadManifest(rawDir: string): RawManifest {
  const file = checked(rawDir, '.manifest.json');
  if (!existsSync(file)) return { version: 2, scrub: SCRUB_VERSION, legacy: mirrorBuckets(rawDir).length > 0, files: {}, buckets: {} };
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('原文清单 .manifest.json 损坏；已保留镜像，拒绝从零重新导入。'); }
  const parsed = object(value); const files = object(parsed?.files);
  if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !Number.isSafeInteger(parsed.scrub) || !files) throw new Error('原文清单格式无效；拒绝重新导入。');
  for (const [key, entry] of Object.entries(files)) {
    const item = object(entry);
    if (!item || !Number.isSafeInteger(item.turns) || (item.turns as number) < 0) throw new Error(`原文清单游标无效：${key}`);
    if (item.cursor !== undefined) {
      const cursor = object(item.cursor);
      if (!cursor || !['frame', 'line', 'ordinal'].every((k) => Number.isSafeInteger(cursor[k]) && (cursor[k] as number) >= 0) || typeof cursor.active !== 'boolean' || typeof cursor.identity !== 'string' || (cursor.frameHash !== undefined && (typeof cursor.frameHash !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.frameHash)))) throw new Error(`原文清单源游标无效：${key}`);
    }
  }
  if (parsed.updatedAt !== undefined && (typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt)))) throw new Error('原文清单同步时间无效。');
  if (parsed.sourceSessionsDir !== undefined && typeof parsed.sourceSessionsDir !== 'string') throw new Error('原文清单源目录无效。');
  if (parsed.buckets !== undefined) {
    const counts = object(parsed.buckets); if (!counts) throw new Error('原文清单计数无效。');
    for (const b of Object.values(counts)) { const days = object(object(b)?.days); if (!days || !Object.entries(days).every(([d, n]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isSafeInteger(n) && (n as number) >= 0)) throw new Error('原文清单日期计数无效。'); }
  }
  return { ...parsed, files, legacy: parsed.legacy === true || parsed.version === 1 } as unknown as RawManifest;
}
function saveManifest(rawDir: string, manifest: RawManifest): void {
  const file = checked(rawDir, '.manifest.json'); const temp = checked(rawDir, `.manifest-${randomUUID()}.tmp`); const fd = openSync(temp, 'wx');
  try { writeFileSync(fd, JSON.stringify(manifest, null, 2) + '\n', 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
}
interface MirrorRow { ts: string; win: string; role: string; text: string; itemId?: string; sourceBucket?: string; sourceCwd?: string; }
function* mirrorRows(file: string): Generator<{ row: MirrorRow; line: number }> {
  if (statSync(file).size > MAX_MIRROR_BYTES) throw new Error('镜像文件超过读取预算（64 MiB）；需要分片后再访问。');
  const fd = openSync(file, 'r'); let pending = ''; let lineNo = 0; const chunk = Buffer.alloc(64 * 1024); const decoder = new TextDecoder();
  try {
    let bytes: number;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      pending += decoder.decode(chunk.subarray(0, bytes), { stream: true }); let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1); lineNo += 1; if (!line.trim()) continue;
        let value: unknown; try { value = JSON.parse(line); } catch { throw new Error(`镜像 JSON 损坏：${basename(file)} 第 ${lineNo} 行。`); }
        const row = object(value);
        if (!row || !['ts', 'win', 'role', 'text'].every((k) => typeof row[k] === 'string')) throw new Error(`镜像记录无效：${basename(file)} 第 ${lineNo} 行。`);
        if (typeof row.sourceBucket === 'string' && protectedBucket(row.sourceBucket)) continue;
        yield { row: row as unknown as MirrorRow, line: lineNo };
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new Error('镜像单条消息超过读取预算（2 MiB）。');
    }
    pending += decoder.decode(); if (pending.trim()) throw new Error(`镜像末尾记录未完成：${basename(file)}；保留原文件，拒绝追加。`);
  } finally { closeSync(fd); }
}
function fingerprint(row: Pick<MirrorRow, 'ts' | 'win' | 'role' | 'text'>): string { return hash(JSON.stringify([row.ts, row.win, row.role, scrubText(row.text)])); }
interface Budget {
  limit: number; remaining: number; scanned: number; decoded: number;
  validationDecodedBytes: number; processingReadBytes: number; replayedDecodedBytes: number; headerReadBytes: number;
}
class SourceBudgetError extends Error { constructor() { super('DSH 本轮帧校验或新行处理预算已用尽；已保存完整行游标，下次续扫。'); } }
function frameError(file: string, frame: ZstdFrameRange, error: unknown): Error {
  const nodeError = error as Error & { code?: string };
  return new Error(`DSH 原文流解码失败：file=${file}; frameOffset=${frame.start}; compressedBytes=${frame.end - frame.start}; nodeCode=${nodeError.code ?? 'unknown'}; nodeMessage=${scrubText(nodeError.message ?? String(error))}；游标未推进。`);
}
function inspectFrame(fd: number, file: string, size: number, start: number): ZstdFrameRange | null {
  if (start > size) throw new Error('DSH 源会话被截短；保留同步游标，不重新导入。');
  if (file.endsWith('.zstd')) {
    try { return inspectZstdFrameAt(fd, size, start); } catch (error) { throw frameError(file, { start, end: size }, error); }
  }
  let offset = start;
  while (offset < size) {
    const chunk = Buffer.alloc(Math.min(32 * 1024, size - offset)); const bytes = readSync(fd, chunk, 0, chunk.length, offset);
    const lf = chunk.subarray(0, bytes).indexOf(10); if (lf >= 0) return { start, end: offset + lf + 1 };
    offset += bytes; if (!bytes) return null;
    if (offset - start > MAX_LINE_BYTES) throw new Error('DSH 单条事件超过 2 MiB 读取预算。');
  }
  return null;
}
async function* frameChunks(fd: number, file: string, frame: ZstdFrameRange, onInput: (chunk: Buffer) => void): AsyncGenerator<Buffer> {
  if (file.endsWith('.zstd')) {
    try { yield* decodeZstdFrameChunks(fd, frame, onInput); } catch (error) { throw frameError(file, frame, error); }
  } else {
    for (let at = frame.start; at < frame.end;) {
      const chunk = Buffer.alloc(Math.min(32 * 1024, frame.end - at)); const bytes = readSync(fd, chunk, 0, chunk.length, at);
      if (bytes !== chunk.length) throw new Error('DSH 源会话被截短。');
      at += bytes; onInput(chunk); yield chunk;
    }
  }
}
function assertSourceStable(fd: number, before: Stats): void {
  const now = fstatSync(fd);
  if (now.ino !== before.ino || now.dev !== before.dev || now.size < before.size
    || (now.size === before.size && (now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs))) {
    throw new Error('DSH 源帧在校验/读取之间发生改写；保留已提交游标，拒绝提交本轮清单。');
  }
}
async function validateFrame(fd: number, file: string, frame: ZstdFrameRange, budget: Budget): Promise<string> {
  const bytes = frame.end - frame.start;
  if (bytes > budget.limit) throw new Error(`DSH 单压缩帧超过完整校验预算，不能追赶：file=${file}; frameOffset=${frame.start}; compressedBytes=${bytes}; validationBudget=${budget.limit}。`);
  if (bytes > budget.remaining) throw new SourceBudgetError();
  const digest = createHash('sha256');
  // Validation is a full first pass. No message is published before its checksum succeeds.
  for await (const chunk of frameChunks(fd, file, frame, (input) => { digest.update(input); budget.scanned += input.length; budget.remaining -= input.length; })) budget.validationDecodedBytes += chunk.length;
  return digest.digest('hex');
}
async function sourceHeader(fd: number, file: string, size: number, budget: Budget): Promise<JsonRecord> {
  const frame = inspectFrame(fd, file, size, 0); if (!frame) throw new Error('DSH 会话头尚未完成。');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '';
  for await (const chunk of frameChunks(fd, file, frame, (input) => { budget.headerReadBytes += input.length; })) {
    pending += decoder.decode(chunk, { stream: true }); const lf = pending.indexOf('\n');
    if (lf >= 0) {
      let value: unknown; try { value = JSON.parse(pending.slice(0, lf)); } catch { throw new Error('DSH 会话头损坏。'); }
      const header = object(value); if (!header || header.type !== 'session') throw new Error('DSH 会话缺少 session 头。');
      if (typeof header.cwd === 'string' && protectedPath(header.cwd)) throw new Error('DSH 会话头属于受保护工作区。');
      return header;
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new Error('DSH 会话头超过 2 MiB 读取预算。');
  }
  throw new Error('DSH 会话头 JSONL 不完整。');
}
async function* sourceLines(fd: number, file: string, frame: ZstdFrameRange, skip: number, budget: Budget): AsyncGenerator<{ text: string; number: number }> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = ''; let number = 0;
  for await (const chunk of frameChunks(fd, file, frame, (input) => { budget.processingReadBytes += input.length; })) {
    pending += decoder.decode(chunk, { stream: true }); let lf: number;
    while ((lf = pending.indexOf('\n')) >= 0) {
      const text = pending.slice(0, lf); pending = pending.slice(lf + 1); number += 1;
      const bytes = Buffer.byteLength(text) + 1;
      if (bytes > MAX_LINE_BYTES) throw new Error(`DSH 单条事件超过 2 MiB 读取预算：file=${file}; frameOffset=${frame.start}; line=${number}。`);
      if (number <= skip) { budget.replayedDecodedBytes += bytes; continue; }
      if (budget.decoded + bytes > MAX_DECODED_BYTES) throw new SourceBudgetError();
      budget.decoded += bytes; yield { text, number };
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new Error(`DSH 单条事件超过 2 MiB 读取预算：file=${file}; frameOffset=${frame.start}; line=${number + 1}。`);
  }
  pending += decoder.decode();
  if (pending.length) throw new Error(`DSH 已完成帧中的 JSONL 尾行不完整：file=${file}; frameOffset=${frame.start}。`);
  if (number < skip) throw new Error('DSH 同步行游标超过源帧。');
}
function sessionFiles(sessionsDir: string, bucket: string): string[] {
  const result: string[] = [];
  const visit = (rel: string, depth: number): void => {
    if (depth > 8) throw new Error('DSH 会话目录嵌套超过预算。');
    const entries = readdirSync(checked(sessionsDir, bucket, rel), { withFileTypes: true });
    const generations = entries.filter((e) => e.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(e.name)).sort((a, b) => Number(/\.v(\d+)/.exec(b.name)?.[1] ?? 0) - Number(/\.v(\d+)/.exec(a.name)?.[1] ?? 0));
    if (generations[0]) { result.push(join(rel, generations[0].name)); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) if (entry.isDirectory() || entry.isSymbolicLink()) visit(join(rel, entry.name), depth + 1);
  };
  visit('', 0); return result;
}
export interface RawSyncOptions extends WorkspaceScopeOptions { sessionsDir: string; rawDir: string; dbFile: string; buckets: readonly string[]; maxTurns: number; allowedBuckets?: readonly string[]; maxSourceBytes?: number; }
export interface RawSyncResult { ok: true; sessionsScanned: number; newTurns: number; filesTouched: number; perBucket: Record<string, number>; rawDir: string; scrubMismatch: boolean; capped: boolean; budgetLimited?: boolean; legacy: boolean; lastSyncAt: string; scannedBytes: number; decodedBytes: number; validationDecodedBytes: number; processingReadBytes: number; replayedDecodedBytes: number; headerReadBytes: number; sourceWarnings: string[]; }
export async function syncRaw(opts: RawSyncOptions): Promise<RawSyncResult> {
  positiveInt(opts.maxTurns, 'maxTurns', 1_000_000); positiveInt(opts.maxSourceBytes ?? 64 * 1024 * 1024, 'maxSourceBytes', 1024 * 1024 * 1024); validateScope(opts.buckets); validateScope(opts.allowedBuckets);
  for (const bucket of opts.buckets) enforceAllowed(bucket, opts.allowedBuckets);
  const { sessionsDir, rawDir } = resolveRawPaths(opts); if (!existsSync(sessionsDir)) throw new Error(`会话目录不存在：${sessionsDir}`);
  const sourceRoot = checked(sessionsDir); const mirrorRoot = checked(rawDir); if (contained(sourceRoot, mirrorRoot) || contained(mirrorRoot, sourceRoot)) throw new Error('原文镜像目录和源会话目录必须分离。');
  const manifest = loadManifest(rawDir); const scrubMismatch = manifest.legacy === true || manifest.scrub !== SCRUB_VERSION;
  const scoped = opts.allowedWorkspaces !== undefined;
  const scopeHash = scoped ? workspaceScopeHash(opts) : undefined;
  if (manifest.workspaceScopeHash !== undefined && manifest.workspaceScopeHash !== scopeHash) throw new Error('原文授权工作区范围发生变化；保留镜像和游标，拒绝混用状态。');
  mkdirSync(mirrorRoot, { recursive: true }); const lock = checked(rawDir, '.sync.lock'); let lockFd: number;
  try { lockFd = openSync(lock, 'wx'); writeFileSync(lockFd, String(process.pid)); } catch { throw new Error('原文同步锁已占用；保留原游标，请确认没有另一个同步进程。'); }
  const perBucket: Record<string, number> = {}; let sessionsScanned = 0; let newTurns = 0; let filesTouched = 0; let examined = 0; let capped = false; let budgetLimited = false;
  const budget: Budget = { limit: opts.maxSourceBytes ?? 64 * 1024 * 1024, remaining: opts.maxSourceBytes ?? 64 * 1024 * 1024, scanned: 0, decoded: 0, validationDecodedBytes: 0, processingReadBytes: 0, replayedDecodedBytes: 0, headerReadBytes: 0 }; const sourceWarnings: string[] = [];
  const dedup = new Map<string, { ids: Set<string>; legacy: Set<string>; count: number }>();
  try {
    const buckets = readdirSync(sourceRoot, { withFileTypes: true }).filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !protectedBucket(d.name)).map((d) => d.name).filter((b) => allowed(b, opts.allowedBuckets) && allowed(b, opts.buckets)).sort();
    outer: for (const bucket of buckets) {
      validateBucket(bucket); checked(sessionsDir, bucket);
      for (const rel of sessionFiles(sessionsDir, bucket)) {
        if (examined >= opts.maxTurns) { capped = true; break outer; }
        const file = checked(sessionsDir, bucket, rel); const info = statSync(file); const key = `${bucket}/${rel}`;
        const entry = manifest.files[key] ?? { turns: 0 };
        if (!scoped && entry.complete && entry.size === info.size && entry.mtimeMs === info.mtimeMs && entry.ctimeMs === info.ctimeMs) continue;
        if (entry.complete && entry.size !== undefined && info.size <= entry.size && (entry.mtimeMs !== info.mtimeMs || entry.ctimeMs !== info.ctimeMs)) throw new Error('DSH 已完成源会话被截短或同大小改写；保留原文游标，拒绝重置。');
        const fd = openSync(file, 'r'); const snapshot = fstatSync(fd);
        try {
        let header: JsonRecord;
        try { header = await sourceHeader(fd, file, snapshot.size, budget); }
        catch (error) { if (!scoped) throw error; sourceWarnings.push('DSH 候选会话头不可验证，未收录且未推进游标。'); continue; }
        if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) continue;
        let sourceCwd: string | undefined;
        if (scoped) {
          if (typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || /[\x00-\x1f]/.test(header.cwd)) { sourceWarnings.push('DSH 候选会话缺少合法绝对 cwd，未收录且未推进游标。'); continue; }
          const authorized = authorizedWorkspace(header.cwd, opts); if (!authorized) continue;
          sourceCwd = resolve(header.cwd);
          if (entry.sourceCwd !== undefined && entry.sourceCwd !== sourceCwd) throw new Error('DSH 会话工作区归属发生变化；保留原游标。');
          if (entry.cursor && entry.sourceCwd === undefined) throw new Error('旧原文游标没有已验证工作区归属；请使用独立 workspace 状态目录。');
          if (entry.complete && entry.size === info.size && entry.mtimeMs === info.mtimeMs && entry.ctimeMs === info.ctimeMs) continue;
        }
        const sessionId = typeof header.id === 'string' ? header.id : rel.split(/[\\/]/)[0]!.replace(/^session-?/, '');
        const identity = hash(JSON.stringify(scoped ? [bucket, sessionId, header.createdAt ?? null, sourceCwd] : [bucket, sessionId, header.createdAt ?? null]));
        const cursor = entry.cursor ?? { frame: 0, line: 0, ordinal: 0, active: false, identity };
        if (cursor.identity !== identity) throw new Error('DSH 会话身份发生变化；保留同步游标。');
        if (cursor.frame > snapshot.size) throw new Error('DSH 源会话被截短；保留同步游标，不重新导入。');
        const state: ExtractState = { active: cursor.active }; let ordinal = cursor.ordinal; let next: SourceCursor = { ...cursor }; let budgetEnd = false;
        sessionsScanned += 1;
        try {
          for (let position = cursor.frame; position < snapshot.size;) {
            const frame = inspectFrame(fd, file, snapshot.size, position); if (!frame) break;
            const frameHash = await validateFrame(fd, file, frame, budget); assertSourceStable(fd, snapshot);
            if (frame.start === cursor.frame && cursor.line > 0 && cursor.frameHash && cursor.frameHash !== frameHash) throw new Error('DSH 未完成源帧的压缩指纹发生变化；保留原游标，拒绝跳过旧前缀。');
            const skip = frame.start === cursor.frame ? cursor.line : 0;
            for await (const sourceLine of sourceLines(fd, file, frame, skip, budget)) {
              const line = sourceLine.text; ordinal += 1;
              let event: unknown; try { event = line.trim() ? JSON.parse(line) : null; } catch { throw new Error(`DSH 原文 JSON 损坏：${bucket}/${basename(rel)} 第 ${ordinal} 行。`); }
              const row = object(event); if (line.trim() && !row) throw new Error('DSH 原文事件必须是对象。');
              const turn = row ? extractEvent(row, state, ordinal) : null; next = { frame: frame.start, line: sourceLine.number, ordinal, active: state.active, identity, frameHash }; if (!turn) continue;
              examined += 1; const day = new Date(turn.ts || 0).toISOString().slice(0, 10);
              mkdirSync(checked(rawDir, bucket), { recursive: true }); const target = checked(rawDir, bucket, `${day}.jsonl`); let seen = dedup.get(target);
              if (!seen) {
                // A bounded cache avoids retaining an index for every historical daily file.
                dedup.clear();
                seen = { ids: new Set(), legacy: new Set(), count: 0 };
                if (existsSync(target)) for (const { row: old } of mirrorRows(target)) { if (old.itemId) seen.ids.add(old.itemId); else seen.legacy.add(fingerprint(old)); seen.count += 1; }
                dedup.set(target, seen);
              }
              const itemId = hash(`${identity}/${turn.sourceId}`); const mirrorRow: MirrorRow = { ts: new Date(turn.ts || 0).toISOString(), win: sessionId.slice(0, 8), role: turn.role, text: scrubText(turn.text), itemId, sourceBucket: bucket, ...(sourceCwd ? { sourceCwd } : {}) };
              if (!seen.ids.has(itemId) && !seen.legacy.has(fingerprint(mirrorRow))) {
                const appendFd = openSync(target, 'a');
                try { writeFileSync(appendFd, JSON.stringify(mirrorRow) + '\n', 'utf8'); fsyncSync(appendFd); } finally { closeSync(appendFd); }
                seen.ids.add(itemId); seen.count += 1; newTurns += 1; filesTouched += 1; perBucket[bucket] = (perBucket[bucket] ?? 0) + 1;
              }
              manifest.buckets ??= {}; manifest.buckets[bucket] ??= { days: {} }; manifest.buckets[bucket]!.days[day] = seen.count;
              entry.turns += 1;
              if (examined >= opts.maxTurns) { budgetEnd = true; break; }
            }
            assertSourceStable(fd, snapshot);
            if (budgetEnd) break;
            next = { frame: frame.end, line: 0, ordinal, active: state.active, identity };
            position = frame.end;
          }
        } catch (error) { if (error instanceof SourceBudgetError) { sourceWarnings.push(error.message); budgetEnd = true; budgetLimited = true; } else throw error; }
        assertSourceStable(fd, snapshot);
        entry.cursor = next; if (sourceCwd) entry.sourceCwd = sourceCwd; entry.updatedAt = Date.now(); entry.size = info.size; entry.mtimeMs = info.mtimeMs; entry.ctimeMs = info.ctimeMs; entry.complete = !budgetEnd; manifest.files[key] = entry;
        if (budgetEnd) { capped = true; break outer; }
        } finally { closeSync(fd); }
      }
    }
    manifest.version = 2; // Preserve historical scrub stamp: appending is not a rebuild.
    if (scopeHash) manifest.workspaceScopeHash = scopeHash;
    manifest.updatedAt = new Date().toISOString(); manifest.sourceSessionsDir = sourceRoot; saveManifest(rawDir, manifest);
    return { ok: true, sessionsScanned, newTurns, filesTouched, perBucket, rawDir, scrubMismatch, capped, budgetLimited, legacy: manifest.legacy === true, lastSyncAt: manifest.updatedAt, scannedBytes: budget.scanned, decodedBytes: budget.decoded, validationDecodedBytes: budget.validationDecodedBytes, processingReadBytes: budget.processingReadBytes, replayedDecodedBytes: budget.replayedDecodedBytes, headerReadBytes: budget.headerReadBytes, sourceWarnings };
  } finally { closeSync(lockFd); unlinkSync(lock); }
}
export interface RawHit { bucket: string; day: string; line: number; ts: string; win: string; role: string; excerpt: string; itemId?: string; }
function dayFiles(rawDir: string, bucket: string): string[] { return readdirSync(checked(rawDir, bucket)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => { checked(rawDir, bucket, f); return f; }).sort().reverse(); }
function scopedMirrorRow(row: MirrorRow, opts: WorkspaceScopeOptions): boolean {
  return opts.allowedWorkspaces === undefined || !!authorizedWorkspace(row.sourceCwd, opts);
}
export function searchRaw(opts: WorkspaceScopeOptions & { rawDir: string; query: string; bucket?: string; limit: number; maxFiles?: number; allowedBuckets?: readonly string[] }): { ok: true; hits: RawHit[]; scannedFiles: number; truncated: boolean } {
  const query = opts.query.trim(); if (!query) throw new Error('query 不能为空。'); positiveInt(opts.limit, 'limit', 500); positiveInt(opts.maxFiles ?? 2000, 'maxFiles', 100_000); validateScope(opts.allowedBuckets);
  if (opts.bucket !== undefined && opts.bucket !== '') enforceAllowed(opts.bucket, opts.allowedBuckets);
  if (!existsSync(opts.rawDir)) return { ok: true, hits: [], scannedFiles: 0, truncated: false }; checked(opts.rawDir);
  const buckets = opts.bucket ? [opts.bucket] : mirrorBuckets(opts.rawDir, opts.allowedBuckets); const needle = query.toLowerCase(); const hits: RawHit[] = []; let scanned = 0; let matched = 0; let truncated = false;
  const compare = (a: RawHit, b: RawHit): number => b.ts.localeCompare(a.ts) || a.bucket.localeCompare(b.bucket) || a.day.localeCompare(b.day) || a.line - b.line;
  outer: for (const bucket of buckets) {
    if (!existsSync(checked(opts.rawDir, bucket))) continue;
    for (const file of dayFiles(opts.rawDir, bucket)) {
      if (scanned >= (opts.maxFiles ?? 2000)) { truncated = true; break outer; } scanned += 1;
      for (const { row, line } of mirrorRows(checked(opts.rawDir, bucket, file))) {
        if (!scopedMirrorRow(row, opts)) continue;
        if (row.sourceBucket && !allowed(row.sourceBucket, opts.allowedBuckets)) continue;
        const text = scrubText(row.text); const at = text.toLowerCase().indexOf(needle); if (at < 0) continue; matched += 1;
        hits.push({ bucket, day: file.slice(0, -6), line, ts: row.ts, win: row.win, role: row.role, excerpt: text.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 220).replace(/\s+/g, ' '), ...(row.itemId ? { itemId: row.itemId } : {}) });
        hits.sort(compare); if (hits.length > opts.limit) hits.pop();
      }
    }
  }
  return { ok: true, hits, scannedFiles: scanned, truncated: truncated || matched > opts.limit };
}
export function readRaw(opts: WorkspaceScopeOptions & { rawDir: string; bucket: string; day: string; win?: string; offset?: number; limit: number; allowedBuckets?: readonly string[] }): { ok: true; bucket: string; day: string; total: number; returned: number; turns: MirrorRow[]; truncated: boolean } {
  enforceAllowed(opts.bucket, opts.allowedBuckets); validateScope(opts.allowedBuckets); positiveInt(opts.limit, 'limit', 10_000);
  const date = Date.parse(`${opts.day}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.day) || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== opts.day) throw new Error('day 必须是合法的 YYYY-MM-DD。');
  const offset = opts.offset ?? 0; if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数。');
  const file = checked(opts.rawDir, opts.bucket, `${opts.day}.jsonl`); if (!existsSync(file)) throw new Error(`镜像区里没有这一份：${opts.bucket}/${opts.day}.jsonl`);
  const turns: MirrorRow[] = []; let total = 0; let outputBytes = 0; let outputCapped = false;
  for (const { row } of mirrorRows(file)) {
    if (!scopedMirrorRow(row, opts)) continue;
    if (row.sourceBucket && !allowed(row.sourceBucket, opts.allowedBuckets)) continue;
    if (opts.win?.trim() && row.win !== opts.win.trim()) continue;
    if (total >= offset && turns.length < opts.limit && !outputCapped) {
      const cleaned = { ...row, text: scrubText(row.text) }; const bytes = Buffer.byteLength(JSON.stringify(cleaned));
      if (outputBytes + bytes > MAX_READ_OUTPUT_BYTES) outputCapped = true;
      else { turns.push(cleaned); outputBytes += bytes; }
    }
    total += 1;
  }
  return { ok: true, bucket: opts.bucket, day: opts.day, total, returned: turns.length, turns, truncated: offset + turns.length < total };
}
export function rawStats(rawDir: string, opts: WorkspaceScopeOptions & { allowedBuckets?: readonly string[]; sessionsDir?: string } = {}): { ok: true; rawDir: string; exists: boolean; buckets: Array<{ bucket: string; days: number; turns: number; latest: string }>; totalTurns: number; lastSyncAt: string | null; scrubMismatch: boolean; legacy: boolean; sourceUnavailable: boolean | null } {
  validateScope(opts.allowedBuckets); checked(rawDir); const exists = existsSync(rawDir); const manifest = loadManifest(rawDir); const source = opts.sessionsDir || manifest.sourceSessionsDir;
  const sourceUnavailable = source ? !existsSync(checked(source)) : null; const buckets: Array<{ bucket: string; days: number; turns: number; latest: string }> = []; let totalTurns = 0;
  for (const bucket of mirrorBuckets(rawDir, opts.allowedBuckets)) {
    const files = dayFiles(rawDir, bucket); let turns = 0;
    if (manifest.buckets?.[bucket] && !manifest.legacy && opts.allowedWorkspaces === undefined) turns = files.reduce((n, file) => n + (manifest.buckets![bucket]!.days[file.slice(0, -6)] ?? 0), 0);
    else for (const file of files) for (const { row } of mirrorRows(checked(rawDir, bucket, file))) if (scopedMirrorRow(row, opts) && (!row.sourceBucket || allowed(row.sourceBucket, opts.allowedBuckets))) turns += 1;
    buckets.push({ bucket, days: files.length, turns, latest: files[0]?.slice(0, -6) ?? '' }); totalTurns += turns;
  }
  buckets.sort((a, b) => b.turns - a.turns || a.bucket.localeCompare(b.bucket));
  return { ok: true, rawDir, exists, buckets, totalTurns, lastSyncAt: manifest.updatedAt ?? null, scrubMismatch: manifest.legacy === true || manifest.scrub !== SCRUB_VERSION, legacy: manifest.legacy === true, sourceUnavailable };
}
