import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEVELS, type Level } from './config.ts';
import { compareMemoryCursor, memoryCursor, type MemoryCursor, type MemoryDraft, type MemoryRecord } from './store.ts';

export interface PendingDelivery {
  deliveryId: string;
  rows: MemoryRecord[];
  from: MemoryCursor | null;
  to: MemoryCursor;
}
export interface QueuedMemory {
  id: string;
  draft: MemoryDraft;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}
export interface RuntimeState {
  version: 1;
  scopeHash: string;
  updatedAt: string;
  cursor: MemoryCursor | null;
  deliveredRevisions?: string[];
  recordedChanges?: { total: number; groups: Record<string, RecordedChangeGroup> };
  pendingDelivery: PendingDelivery | null;
  queue: QueuedMemory[];
  counters: { polls: number; pushedEvents: number; pushedItems: number; writtenRows: number; failures: number; toolReads: number };
  watch: { lastPollAt: string | null; lastSuccessAt: string | null; lastPushAt: string | null };
  write: { lastAttemptAt: string | null; lastWriteAt: string | null; error: string | null };
  raw: { lastSyncAt: string | null; lastSuccessAt: string | null; lastResult: Record<string, unknown> | null; error: string | null };
  lastFailure: { at: string; component: string; message: string } | null;
}

export interface RecordedChangeGroup {
  sourceSession: string | null;
  project: string | null;
  count: number;
  firstUpdatedAt: number;
  lastUpdatedAt: number;
  levels: Partial<Record<Level, number>>;
  references: Array<{ id: string; level: Level; updatedAt: number }>;
}

export function createRuntimeState(scopeHash: string): RuntimeState {
  validScope(scopeHash);
  return { version: 1, scopeHash, updatedAt: new Date().toISOString(), cursor: null, pendingDelivery: null, queue: [],
    deliveredRevisions: [], counters: { polls: 0, pushedEvents: 0, pushedItems: 0, writtenRows: 0, failures: 0, toolReads: 0 },
    watch: { lastPollAt: null, lastSuccessAt: null, lastPushAt: null },
    write: { lastAttemptAt: null, lastWriteAt: null, error: null },
    raw: { lastSyncAt: null, lastSuccessAt: null, lastResult: null, error: null }, lastFailure: null };
}

function invalid(field: string): never { throw new Error(`DSH runtime checkpoint contains invalid ${field}; preserve the file before recovery.`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(field);
}
function text(value: unknown, field: string, max = 4_000): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max) invalid(field);
}
function validScope(value: unknown): asserts value is string { text(value, 'scopeHash', 200); }
function count(value: unknown, field: string): void { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(field); }
function timestamp(value: unknown, field: string, nullable = true): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(field);
}
function cursor(value: unknown, field: string, nullable = true): MemoryCursor | null {
  if (nullable && value === null) return null;
  const item = object(value, field); keys(item, ['updatedAt', 'level', 'id'], field);
  count(item.updatedAt, `${field}.updatedAt`); text(item.id, `${field}.id`, 200);
  if (!LEVELS.includes(item.level as Level)) invalid(`${field}.level`);
  return item as unknown as MemoryCursor;
}
function errorText(value: unknown, field: string): void { if (value !== null) text(value, field); }
function primitive(value: unknown, field: string): void {
  if (value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) invalid(field);
}
function validateRow(value: unknown): MemoryRecord {
  const row = object(value, 'pendingDelivery.rows[]');
  keys(row, ['id', 'level', 'title', 'project', 'importance', 'content', 'contentChars', 'truncated', 'keywords', 'createdAt', 'updatedAt', 'source'], 'pendingDelivery.rows[]');
  text(row.id, 'pendingDelivery.rows[].id', 200);
  if (!LEVELS.includes(row.level as Level)) invalid('pendingDelivery.rows[].level');
  for (const key of ['title', 'project', 'importance', 'content', 'contentChars', 'keywords', 'createdAt', 'updatedAt']) primitive(row[key], `pendingDelivery.rows[].${key}`);
  if (typeof row.truncated !== 'boolean') invalid('pendingDelivery.rows[].truncated');
  const source = object(row.source, 'pendingDelivery.rows[].source');
  keys(source, ['system', 'memoryKind', 'sourceSession'], 'pendingDelivery.rows[].source');
  text(source.system, 'pendingDelivery.rows[].source.system', 200); text(source.memoryKind, 'pendingDelivery.rows[].source.memoryKind', 200);
  primitive(source.sourceSession, 'pendingDelivery.rows[].source.sourceSession');
  try { memoryCursor(row as unknown as MemoryRecord); } catch { invalid('pendingDelivery.rows[].cursor'); }
  return row as unknown as MemoryRecord;
}
function validateDraft(value: unknown): void {
  const draft = object(value, 'queue[].draft');
  keys(draft, ['level', 'project', 'content', 'title', 'importance', 'keywords', 'subcategory', 'goal', 'corrected'], 'queue[].draft');
  if (!LEVELS.includes(draft.level as Level)) invalid('queue[].draft.level');
  text(draft.project, 'queue[].draft.project', 200); text(draft.content, 'queue[].draft.content', 32_000);
  if (!Array.isArray(draft.keywords) || draft.keywords.length > 20 || draft.keywords.some(k => typeof k !== 'string')) invalid('queue[].draft.keywords');
  for (const key of ['title', 'subcategory', 'goal']) if (draft[key] !== undefined && draft[key] !== null && typeof draft[key] !== 'string') invalid(`queue[].draft.${key}`);
  if (draft.importance !== undefined && (typeof draft.importance !== 'number' || !Number.isFinite(draft.importance))) invalid('queue[].draft.importance');
  if (draft.corrected !== undefined && typeof draft.corrected !== 'boolean') invalid('queue[].draft.corrected');
}

function validateState(value: unknown, scopeHash: string): RuntimeState {
  const state = object(value, 'root');
  if (state.version !== 1 || state.scopeHash !== scopeHash) throw new Error('DSH runtime checkpoint scope or version does not match this configuration; preserve the file before recovery.');
  keys(state, ['version', 'scopeHash', 'updatedAt', 'cursor', 'deliveredRevisions', 'recordedChanges', 'pendingDelivery', 'queue', 'counters', 'watch', 'write', 'raw', 'lastFailure'], 'root');
  timestamp(state.updatedAt, 'updatedAt', false);
  const savedCursor = cursor(state.cursor, 'cursor');
  if (state.recordedChanges !== undefined) {
    const changes = object(state.recordedChanges, 'recordedChanges');
    keys(changes, ['total', 'groups'], 'recordedChanges'); count(changes.total, 'recordedChanges.total');
    const groups = object(changes.groups, 'recordedChanges.groups');
    if (Object.keys(groups).length > 10000) invalid('recordedChanges.groups');
    let total = 0;
    for (const [key, value] of Object.entries(groups)) {
      if (!/^[a-f0-9]{64}$/.test(key)) invalid('recordedChanges.group key');
      const group = object(value, 'recordedChanges.group');
      keys(group, ['sourceSession', 'project', 'count', 'firstUpdatedAt', 'lastUpdatedAt', 'levels', 'references'], 'recordedChanges.group');
      for (const field of ['sourceSession', 'project']) if (group[field] !== null) text(group[field], `recordedChanges.${field}`, 2000);
      for (const field of ['count', 'firstUpdatedAt', 'lastUpdatedAt']) count(group[field], `recordedChanges.${field}`);
      if (Number(group.count) < 1 || Number(group.firstUpdatedAt) > Number(group.lastUpdatedAt)) invalid('recordedChanges.range');
      const levels = object(group.levels, 'recordedChanges.levels'); keys(levels, [...LEVELS], 'recordedChanges.levels');
      for (const [level, countValue] of Object.entries(levels)) count(countValue, `recordedChanges.levels.${level}`);
      if (Object.values(levels).reduce((sum: number, value) => sum + Number(value), 0) !== group.count) invalid('recordedChanges.level counts');
      if (!Array.isArray(group.references) || group.references.length < 1 || group.references.length > 20) invalid('recordedChanges.references');
      for (const reference of group.references) {
        const ref = object(reference, 'recordedChanges.reference'); keys(ref, ['id', 'level', 'updatedAt'], 'recordedChanges.reference');
        text(ref.id, 'recordedChanges.reference.id', 200); count(ref.updatedAt, 'recordedChanges.reference.updatedAt');
        if (!LEVELS.includes(ref.level as Level)) invalid('recordedChanges.reference.level');
      }
      total += Number(group.count);
    }
    if (total !== changes.total) invalid('recordedChanges.total');
  }
  if (state.deliveredRevisions !== undefined) {
    if (!Array.isArray(state.deliveredRevisions) || state.deliveredRevisions.length > 100_000) invalid('deliveredRevisions');
    for (const revision of state.deliveredRevisions as unknown[]) {
      if (typeof revision !== 'string') invalid('deliveredRevisions[]');
      const match = /^(\d+)\|(soul|user|project|fact|lesson|topic|rules)\|([\s\S]{1,200})$/.exec(revision);
      if (!match || !Number.isSafeInteger(Number(match[1]))) invalid('deliveredRevisions[]');
    }
  }
  if (state.pendingDelivery !== null) {
    const pending = object(state.pendingDelivery, 'pendingDelivery');
    keys(pending, ['deliveryId', 'rows', 'from', 'to'], 'pendingDelivery');
    if (typeof pending.deliveryId !== 'string' || !/^[a-f0-9]{64}$/.test(pending.deliveryId)) invalid('pendingDelivery.deliveryId');
    const from = cursor(pending.from, 'pendingDelivery.from'), to = cursor(pending.to, 'pendingDelivery.to', false)!;
    if ((from === null) !== (savedCursor === null) || from && savedCursor && compareMemoryCursor(from, savedCursor) !== 0) invalid('pendingDelivery.from');
    if (from && compareMemoryCursor(to, from) < 0) invalid('pendingDelivery.to');
    if (!Array.isArray(pending.rows) || pending.rows.length < 1 || pending.rows.length > 100) invalid('pendingDelivery.rows');
    let previous: MemoryCursor | null = null;
    for (const value of pending.rows as unknown[]) {
      const rowCursor = memoryCursor(validateRow(value));
      // A late row at the current millisecond may sort before `from`; its receipt still matters.
      if (from && rowCursor.updatedAt < from.updatedAt || compareMemoryCursor(rowCursor, to) > 0 || previous && compareMemoryCursor(previous, rowCursor) >= 0) invalid('pendingDelivery.rows order');
      previous = rowCursor;
    }
  }
  if (!Array.isArray(state.queue) || state.queue.length > 100_000) invalid('queue');
  const queuedIds = new Set<string>();
  for (const value of state.queue as unknown[]) {
    const item = object(value, 'queue[]'); keys(item, ['id', 'draft', 'queuedAt', 'attempts', 'lastError'], 'queue[]');
    text(item.id, 'queue[].id', 200);
    if (queuedIds.has(item.id)) invalid('queue duplicate id'); queuedIds.add(item.id);
    timestamp(item.queuedAt, 'queue[].queuedAt', false); count(item.attempts, 'queue[].attempts'); validateDraft(item.draft);
    if (item.lastError !== undefined) text(item.lastError, 'queue[].lastError');
  }
  const counters = object(state.counters, 'counters');
  const counterKeys = ['polls', 'pushedEvents', 'pushedItems', 'writtenRows', 'failures', 'toolReads']; keys(counters, counterKeys, 'counters');
  for (const key of counterKeys) count(counters[key], `counters.${key}`);
  const watch = object(state.watch, 'watch'); keys(watch, ['lastPollAt', 'lastSuccessAt', 'lastPushAt'], 'watch');
  for (const key of ['lastPollAt', 'lastSuccessAt', 'lastPushAt']) timestamp(watch[key], `watch.${key}`);
  const write = object(state.write, 'write'); keys(write, ['lastAttemptAt', 'lastWriteAt', 'error'], 'write');
  for (const key of ['lastAttemptAt', 'lastWriteAt']) timestamp(write[key], `write.${key}`); errorText(write.error, 'write.error');
  const raw = object(state.raw, 'raw'); keys(raw, ['lastSyncAt', 'lastSuccessAt', 'lastResult', 'error'], 'raw');
  for (const key of ['lastSyncAt', 'lastSuccessAt']) timestamp(raw[key], `raw.${key}`); errorText(raw.error, 'raw.error');
  if (raw.lastResult !== null) object(raw.lastResult, 'raw.lastResult');
  if (state.lastFailure !== null) {
    const failure = object(state.lastFailure, 'lastFailure'); keys(failure, ['at', 'component', 'message'], 'lastFailure');
    timestamp(failure.at, 'lastFailure.at', false); text(failure.component, 'lastFailure.component', 200); text(failure.message, 'lastFailure.message');
  }
  return state as unknown as RuntimeState;
}

// Checkpoints must keep the original pending bodies for recovery. Audit journals carry metadata only.
const bodyKey = /^(?:content|text|title|keywords|draft|rows|memory|messages|turns?|prompt|response|body|query|sourceSession|input|output)$/i;
function safeMeta(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('DSH audit metadata is nested too deeply.');
  if (typeof value === 'string') return value.slice(0, 4_000)
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)["']?)\s*[:=]\s*)["']?[^\s"',;}]+["']?/gi, '$1[REDACTED]');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 1_000).map(item => safeMeta(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !bodyKey.test(key)).map(([key, item]) => [key, safeMeta(item, depth + 1)]));
  if (value === undefined) return undefined;
  throw new Error('DSH audit metadata contains an unsupported value.');
}

export class RuntimeJournal {
  readonly checkpointFile: string;
  readonly logDir: string;
  private readonly directoryIdentity: Stats;
  constructor(dir: string, private readonly scopeHash: string) {
    validScope(scopeHash);
    if (!isAbsolute(dir)) throw new Error('DSH runtime directory must be absolute.');
    this.rejectProtectedDirectory(resolve(dir));
    mkdirSync(dir, { recursive: true });
    this.logDir = realpathSync.native(dir);
    this.rejectProtectedDirectory(this.logDir);
    this.directoryIdentity = lstatSync(this.logDir);
    if (!this.directoryIdentity.isDirectory() || this.directoryIdentity.isSymbolicLink()) this.boundaryError();
    this.checkpointFile = join(this.logDir, 'checkpoint.json');
  }
  private boundaryError(): never { throw new Error('DSH runtime file boundary changed or contains a link; preserve the files before recovery.'); }
  private pathKey(path: string): string { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value; }
  private sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
  private rejectProtectedDirectory(path: string): void {
    for (const root of ['F:/AI/对话备份', 'F:/AI/对话记录']) if (isAbsolute(root)) {
      const difference = relative(this.pathKey(root), this.pathKey(path));
      if (difference === '' || !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`)) throw new Error('DSH runtime directory is within a protected conversation or backup directory.');
    }
  }
  private guardDirectory(): void {
    const current = lstatSync(this.logDir, { throwIfNoEntry: false });
    if (!current || !current.isDirectory() || current.isSymbolicLink() || !this.sameIdentity(current, this.directoryIdentity) ||
      this.pathKey(realpathSync.native(this.logDir)) !== this.pathKey(this.logDir)) this.boundaryError();
  }
  private guardFile(path: string): Stats | undefined {
    this.guardDirectory();
    if (this.pathKey(dirname(path)) !== this.pathKey(this.logDir)) this.boundaryError();
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (!current) return undefined;
    // A hard link also shares writes with a file outside this directory; refuse it even if realpath looks local.
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 ||
      this.pathKey(realpathSync.native(path)) !== this.pathKey(path)) this.boundaryError();
    return current;
  }
  private guardDescriptor(fd: number, path: string, expected?: Stats): void {
    const current = this.guardFile(path), opened = fstatSync(fd);
    if (!current || !opened.isFile() || opened.nlink !== 1 || !this.sameIdentity(current, opened) ||
      expected && !this.sameIdentity(expected, opened)) this.boundaryError();
  }
  load(): RuntimeState | null {
    const expected = this.guardFile(this.checkpointFile);
    if (!expected) return null;
    const fd = openSync(this.checkpointFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let value: unknown;
    try {
      this.guardDescriptor(fd, this.checkpointFile, expected);
      try { value = JSON.parse(readFileSync(fd, 'utf8')); }
      catch { throw new Error('DSH runtime checkpoint is corrupt or unreadable; preserve the file before recovery.'); }
    } finally { closeSync(fd); }
    return validateState(value, this.scopeHash);
  }
  save(state: RuntimeState): void {
    // Validate the JSON representation before touching either the old checkpoint or a temporary file.
    const json = JSON.stringify(state, null, 2) + '\n'; validateState(JSON.parse(json), this.scopeHash);
    const expected = this.guardFile(this.checkpointFile);
    const temp = `${this.checkpointFile}.${randomUUID()}.tmp`;
    this.guardFile(temp);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { this.guardDescriptor(fd, temp); writeFileSync(fd, json, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    const current = this.guardFile(this.checkpointFile);
    if (expected && (!current || !this.sameIdentity(expected, current)) || !expected && current) this.boundaryError();
    this.guardFile(temp);
    renameSync(temp, this.checkpointFile);
  }
  audit(kind: string, meta: Record<string, unknown> = {}): void {
    if (!/^[a-z][a-z0-9_-]{0,79}$/i.test(kind)) throw new Error('DSH audit kind is invalid.');
    object(meta, 'audit metadata'); const at = new Date().toISOString();
    const line = JSON.stringify({ at, source: 'dshmemory', kind, meta: safeMeta(meta) }) + '\n';
    const path = join(this.logDir, `audit-${at.slice(0, 10)}.jsonl`), expected = this.guardFile(path);
    const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (expected ? 0 : constants.O_CREAT | constants.O_EXCL);
    const fd = openSync(path, flags, 0o600);
    try { this.guardDescriptor(fd, path, expected); writeFileSync(fd, line, 'utf8'); } finally { closeSync(fd); }
  }
}
