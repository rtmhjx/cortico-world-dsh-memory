import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { GLOBAL_LEVELS, LEVELS, SCOPED_LEVELS, SUBCATEGORIES, type DshMemoryAccess, type Level } from './config.ts';

export class MemoryError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const invalid = (message: string): never => { throw new MemoryError('invalid_arguments', message); };
const COMMON_COLUMNS = ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'created_at', 'updated_at'];
export const MAX_CONTENT_CHARS = 32_000;
const MAX_METADATA_CHARS = 2_000;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_CHARS = 60;
const MAX_IMPORTANCE = 100;

export function validateConfig(cfg: DshMemoryAccess): void {
  if (typeof cfg.dbFile !== 'string' || !isAbsolute(cfg.dbFile)) throw new Error('dbFile 必须是 memory.db 的绝对路径。');
  if (!Array.isArray(cfg.allowedProjects) || cfg.allowedProjects.length === 0 || cfg.allowedProjects.length > 100 ||
    cfg.allowedProjects.some(p => typeof p !== 'string' || !p.trim() || p !== p.trim() || p.length > 200 || p.includes(',') || /^(global|全局)$/i.test(p))) {
    throw new Error('allowedProjects 必须包含 1–100 个精确项目名；全局范围使用 includeGlobal。');
  }
  if (typeof cfg.includeGlobal !== 'boolean') throw new Error('includeGlobal 必须是布尔值。');
  if (!Array.isArray(cfg.levels) || cfg.levels.length === 0 || cfg.levels.some(l => !LEVELS.includes(l))) throw new Error('levels 必须包含有效的记忆层。');
}

function textArg(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${name} 必须是 1–${max} 个字符的非空字符串。`);
  return value as string;
}

function onlyKeys(args: Record<string, unknown>, keys: string[]): void {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !keys.includes(k))) invalid('工具包含未知参数。');
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

/** 轮询的全序游标。同一毫秒的跨层条目也可以逐页完整投递。 */
export interface MemoryCursor { updatedAt: number; level: Level; id: string; }

function binaryCompare(a: string, b: string): number { return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }

function validateCursor(cursor: MemoryCursor, allowEmptyBoundary = false): void {
  if (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor.updatedAt) || cursor.updatedAt < 0 ||
    !LEVELS.includes(cursor.level) || typeof cursor.id !== 'string' || (!cursor.id && !allowEmptyBoundary) || cursor.id.length > 200) {
    invalid('cursor 必须包含有效的 updatedAt、level 与完整 id。');
  }
}

export function memoryCursor(record: Pick<MemoryRecord, 'updatedAt' | 'level' | 'id'>): MemoryCursor {
  const updatedAt = Number(record.updatedAt);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new MemoryError('incompatible_data', 'DSH 条目的 updated_at 不是可安全比较的整数时间戳。');
  }
  const cursor = { updatedAt, level: record.level, id: record.id };
  validateCursor(cursor);
  return cursor;
}

/** 与 SQLite COLLATE BINARY 保持一致；不使用受系统语言影响的 localeCompare。 */
export function compareMemoryCursor(a: MemoryCursor, b: MemoryCursor): number {
  return a.updatedAt - b.updatedAt || binaryCompare(a.level, b.level) || binaryCompare(a.id, b.id);
}

export interface MemoryStats {
  total: number;
  byLevel: Partial<Record<Level, number>>;
  latestUpdatedAt: number | null;
}

/** 某一层必需的列。requireExtras 为真时连该层的专有列一起要求（写入侧用）。 */
function requiredColumns(level: Level, requireExtras: boolean): string[] {
  const columns = [...COMMON_COLUMNS];
  if (!GLOBAL_LEVELS.includes(level)) columns.push('project');
  if (requireExtras) {
    if (level === 'lesson') columns.push('corrected');
    if (level === 'project') columns.push('subcategory');
    if (level === 'topic') columns.push('goal');
  }
  return columns;
}

/**
 * 校验目标库具备 meow-memory 的记忆表与必需列。
 * 读写两侧共用：只检查，不建表、不改表。读取侧只要求公共列，写入侧连专有列一起要求。
 */
function assertSchema(db: DatabaseSync, levels: readonly Level[], requireExtras = false): void {
  for (const level of levels) {
    const table = db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(level);
    if (table?.type !== 'table') throw new MemoryError('incompatible_schema', `缺少记忆表 ${level}。`);
    const columns = new Set(db.prepare(`PRAGMA table_info("${level}")`).all().map(c => c.name));
    if (requiredColumns(level, requireExtras).some(c => !columns.has(c))) {
      throw new MemoryError('incompatible_schema', `记忆表 ${level} 的字段不兼容。`);
    }
  }
}

/**
 * 与 meow-memory 同构的条目 id：base36 毫秒时间戳左补 0 到 9 位 + 32 位十六进制随机段。
 * 时间前缀保证 id 的字典序与创建顺序一致，meow-memory 的排序假设依赖这一点。
 */
export function newMemoryId(now: number = Date.now()): string {
  return `${now.toString(36).padStart(9, '0')}-${randomUUID().replaceAll('-', '')}`;
}

/** Each call opens a read-only connection so the next call sees committed DSH updates. */
export class DshMemoryStore {
  private readonly cfg: DshMemoryAccess;
  constructor(cfg: DshMemoryAccess) { validateConfig(cfg); this.cfg = structuredClone(cfg); }

  private withDatabase<T>(project: string | null, operation: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    try {
      if (!statSync(this.cfg.dbFile).isFile()) throw new Error('not a file');
      db = new DatabaseSync(this.cfg.dbFile, { readOnly: true, allowExtension: false });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF;');
      assertSchema(db, this.cfg.levels);
      db.function('dsh_project_visible', { deterministic: true }, value => {
        if (value !== null && typeof value !== 'string') return 0;
        const label = (value ?? '').trim();
        if (!label || /^(global|全局)$/i.test(label)) return this.cfg.includeGlobal ? 1 : 0;
        const memberships = label.split(',').map(p => p.trim());
        return (project === null ? this.cfg.allowedProjects.some(p => memberships.includes(p)) : memberships.includes(project)) ? 1 : 0;
      });
      db.function('dsh_keywords_match', { deterministic: true }, (value, query) => {
        if (typeof value !== 'string' || typeof query !== 'string') return 0;
        try {
          const keywords: unknown = JSON.parse(value);
          return Array.isArray(keywords) && keywords.some(k => typeof k === 'string' && k.toLowerCase().includes(query.toLowerCase())) ? 1 : 0;
        } catch { return 0; }
      });
      db.exec('BEGIN');
      return operation(db);
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError('unavailable', 'DSH 记忆库不可读、被锁定或已损坏；本次未取得查询结果。');
    } finally { db?.close(); }
  }

  check(): void { this.withDatabase(this.cfg.allowedProjects[0], () => undefined); }

  private project(value: unknown): string {
    const project = textArg(value, 'project', 200);
    if (!this.cfg.allowedProjects.includes(project)) throw new MemoryError('forbidden_project', '该项目不在配置的读取范围内。');
    return project;
  }

  private levels(value: unknown): Level[] {
    if (value === undefined) return [...new Set(this.cfg.levels)];
    if (typeof value !== 'string' || !this.cfg.levels.includes(value as Level)) invalid('level 不在配置的读取范围内。');
    return [value as Level];
  }

  private select(level: Level, maxChars: number): string {
    const project = GLOBAL_LEVELS.includes(level) ? 'NULL AS project' : `substr(project, 1, ${MAX_METADATA_CHARS}) AS project`;
    return `id, substr(title, 1, ${MAX_METADATA_CHARS}) AS title, substr(content, 1, ${maxChars}) AS content,
      length(content) AS content_chars, importance, substr(keywords, 1, ${MAX_METADATA_CHARS}) AS keywords,
      ${project}, substr(source_session, 1, ${MAX_METADATA_CHARS}) AS source_session, created_at, updated_at`;
  }

  private scope(level: Level): string {
    return GLOBAL_LEVELS.includes(level) ? (this.cfg.includeGlobal ? '1' : '0') : 'dsh_project_visible(project) = 1';
  }

  private record(level: Level, row: Row): MemoryRecord {
    return {
      id: String(row.id), level, title: row.title, project: row.project, importance: row.importance,
      content: row.content, contentChars: row.content_chars,
      truncated: Number(row.content_chars) > [...String(row.content)].length,
      keywords: row.keywords, createdAt: row.created_at, updatedAt: row.updated_at,
      source: { system: 'dsh-meow-memory', memoryKind: 'external', sourceSession: row.source_session },
    };
  }

  search(args: Record<string, unknown>) {
    onlyKeys(args, ['query', 'project', 'level', 'limit']);
    const query = textArg(args.query, 'query', 200);
    const project = this.project(args.project);
    const levels = this.levels(args.level);
    const limit = args.limit ?? 5;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) invalid('limit 必须是 1–20 的整数。');
    return this.withDatabase(project, db => {
      const hits = levels.flatMap(level => db.prepare(`SELECT ${this.select(level, 300)} FROM "${level}"
        WHERE status = 'active' AND ${this.scope(level)} AND
        (instr(lower(coalesce(title, '')), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0 OR dsh_keywords_match(keywords, ?) = 1)
        ORDER BY updated_at DESC, id ASC LIMIT ?`).all(query, query, query, limit as number).map(row => this.record(level, row)));
      hits.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt) || a.id.localeCompare(b.id) || a.level.localeCompare(b.level));
      return { ok: true, source: 'dsh-meow-memory', memoryKind: 'external', project, query,
        method: 'literal_substring', hits: hits.slice(0, limit as number) };
    });
  }

  read(args: Record<string, unknown>) {
    onlyKeys(args, ['id', 'project', 'level']);
    const id = textArg(args.id, 'id', 200);
    const project = this.project(args.project);
    if (args.level === undefined) invalid('read 必须指定 level。');
    const level = this.levels(args.level)[0];
    return this.withDatabase(project, db => {
      const row = db.prepare(`SELECT ${this.select(level, MAX_CONTENT_CHARS)} FROM "${level}"
        WHERE id = ? COLLATE BINARY AND status = 'active' AND ${this.scope(level)}`).get(id);
      if (!row) return { ok: false, code: 'not_found', message: '指定范围内未找到该完整 ID 的有效记忆。' };
      return { ok: true, memory: this.record(level, row) };
    });
  }

  /** 当前可见条目的最大 updated_at；空库返回 0。计时输入的水位起点。 */
  maxUpdatedAt(): number {
    return this.latestCursor()?.updatedAt ?? 0;
  }

  /** 范围内的最后一个全序游标；只读元数据，不读取正文。 */
  latestCursor(): MemoryCursor | null {
    return this.withDatabase(null, db => {
      const cursors = [...new Set(this.cfg.levels)].flatMap(level => {
        const row = db.prepare(`SELECT id, updated_at FROM "${level}"
          WHERE status = 'active' AND ${this.scope(level)}
          ORDER BY updated_at DESC, id COLLATE BINARY DESC LIMIT 1`).get();
        return row ? [memoryCursor({ id: String(row.id), level, updatedAt: row.updated_at })] : [];
      });
      cursors.sort(compareMemoryCursor);
      return cursors.at(-1) ?? null;
    });
  }

  /** 所有允许项目与全局范围的去重统计；不会返回记忆正文。 */
  stats(): MemoryStats {
    return this.withDatabase(null, db => {
      const byLevel: Partial<Record<Level, number>> = {};
      let total = 0;
      let latestUpdatedAt: number | null = null;
      for (const level of new Set(this.cfg.levels)) {
        const row = db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM "${level}"
          WHERE status = 'active' AND ${this.scope(level)}`).get();
        const count = Number(row?.n ?? 0);
        byLevel[level] = count;
        total += count;
        if (row?.m != null) {
          const updatedAt = Number(row.m);
          if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new MemoryError('incompatible_data', 'DSH 条目的 updated_at 不是可安全比较的整数时间戳。');
          latestUpdatedAt = Math.max(latestUpdatedAt ?? 0, updatedAt);
        }
      }
      return { total, byLevel, latestUpdatedAt };
    });
  }

  /** 全序分页：覆盖全部允许项目，每个全局／联合项目条目只返回一次。 */
  recentAfter(cursor: MemoryCursor | null, limit: number, maxChars: number): MemoryRecord[] {
    if (cursor !== null) validateCursor(cursor, true);
    this.validateRecentLimits(limit, maxChars);
    return this.withDatabase(null, db => {
      const rows = [...new Set(this.cfg.levels)].flatMap(level => {
        const after = cursor === null ? '' : `AND (updated_at > ? OR (updated_at = ? AND
          (? COLLATE BINARY > ? COLLATE BINARY OR (? COLLATE BINARY = ? COLLATE BINARY AND id COLLATE BINARY > ? COLLATE BINARY))))`;
        const params = cursor === null ? [] : [cursor.updatedAt, cursor.updatedAt, level, cursor.level, level, cursor.level, cursor.id];
        return db.prepare(`SELECT ${this.select(level, maxChars)} FROM "${level}"
          WHERE status = 'active' AND ${this.scope(level)} ${after}
          ORDER BY updated_at ASC, id COLLATE BINARY ASC LIMIT ?`).all(...params, limit).map(row => this.record(level, row));
      });
      rows.sort((a, b) => compareMemoryCursor(memoryCursor(a), memoryCursor(b)));
      return rows.slice(0, limit);
    });
  }

  private validateRecentLimits(limit: number, maxChars: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit 必须是 1–100 的整数。');
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_CONTENT_CHARS) invalid(`maxChars 必须是 1–${MAX_CONTENT_CHARS} 的整数。`);
  }

  /**
   * 计时输入：取水位之后新写入/更新的可见条目，按 updated_at 升序返回最旧的 limit 条。
   * 调用方用返回的最大 updated_at 推进水位；被截断的正文可用 dshmemory_read 取全文。
   */
  recent(watermark: number, limit: number, maxChars: number): MemoryRecord[] {
    if (typeof watermark !== 'number' || !Number.isSafeInteger(watermark) || watermark < 0) invalid('watermark 必须是正整数时间戳。');
    this.validateRecentLimits(limit, maxChars);
    return this.withDatabase(null, db => {
      const rows = [...new Set(this.cfg.levels)].flatMap(level => db.prepare(`SELECT ${this.select(level, maxChars)} FROM "${level}"
        WHERE status = 'active' AND ${this.scope(level)} AND updated_at > ?
        ORDER BY updated_at ASC, id COLLATE BINARY ASC LIMIT ?`).all(watermark, limit).map(row => this.record(level, row)));
      rows.sort((a, b) => compareMemoryCursor(memoryCursor(a), memoryCursor(b)));
      return rows.slice(0, limit);
    });
  }
}

/** 返回给工具与计时输入的条目视图。 */
export interface MemoryRecord {
  id: string;
  level: Level;
  title: string | number | bigint | Uint8Array | null;
  project: string | number | bigint | Uint8Array | null;
  importance: string | number | bigint | Uint8Array | null;
  content: string | number | bigint | Uint8Array | null;
  contentChars: string | number | bigint | Uint8Array | null;
  truncated: boolean;
  keywords: string | number | bigint | Uint8Array | null;
  createdAt: string | number | bigint | Uint8Array | null;
  updatedAt: string | number | bigint | Uint8Array | null;
  source: { system: string; memoryKind: string; sourceSession: string | number | bigint | Uint8Array | null };
}

/** 一条待写入的 DSH 记忆条目。 */
export interface MemoryDraft {
  level: Level;
  project: string;
  content: string;
  title?: string | null;
  importance?: number;
  keywords: string[];
  subcategory?: string | null;
  goal?: string | null;
  corrected?: boolean;
}

/**
 * 计时入库的写入端：惰性打开一个可写连接，只 INSERT 记忆表，不碰 windows / dream_* 表。
 * 与 DSH 侧 meow-memory 同为 WAL 模式的多写者，靠 busy_timeout 让行；不复制、不迁移数据库。
 */
export class DshMemoryWriter {
  private readonly cfg: DshMemoryAccess;
  private db?: DatabaseSync;
  constructor(cfg: DshMemoryAccess) {
    validateConfig(cfg);
    if (!Array.isArray(cfg.writeLevels) || cfg.writeLevels.length === 0 ||
      cfg.writeLevels.some(level => !SCOPED_LEVELS.includes(level) || !cfg.levels.includes(level))) {
      throw new Error('writeLevels 至少要包含一个可写的项目层，且必须在读取范围内。');
    }
    textArg(cfg.writeSourceLabel, 'writeSourceLabel', 200);
    this.cfg = structuredClone(cfg);
  }

  get writableLevels(): readonly Level[] { return this.cfg.writeLevels; }

  /** 只校验不入库：入队前就给出明确错误，而不是等到冲刷时才发现。 */
  validate(draft: MemoryDraft, id: string = newMemoryId()): void { this.prepared(draft, id); }

  /** 校验并写入一条；返回新条目的 id。只有真的要写时才打开数据库。 */
  write(draft: MemoryDraft, id: string = newMemoryId()): string {
    return this.writeOnce(draft, id).id;
  }

  /**
   * 持久队列重试的提交接口。相同 ID 与写入字段完全一致时返回已提交，
   * 不改时间戳；ID 冲突则明确失败，绝不覆盖原条目。
   */
  writeOnce(draft: MemoryDraft, id: string): { id: string; inserted: boolean } {
    const row = this.prepared(draft, id);
    const db = this.open();
    let transaction = false;
    try {
      const columns = ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'created_at', 'updated_at'];
      const values: Array<string | number | null> = [row.id, row.title, row.content, row.importance, JSON.stringify(row.keywords),
        'active', this.cfg.writeSourceLabel, row.now, row.now];
      if (row.level === 'lesson') { columns.push('corrected', 'project'); values.push(row.corrected, row.project); }
      else if (row.level === 'project') { columns.push('subcategory', 'project'); values.push(row.subcategory, row.project); }
      else if (row.level === 'topic') { columns.push('goal', 'project'); values.push(row.goal, row.project); }
      else { columns.push('project'); values.push(row.project); }
      // IMMEDIATE 把「查重 + 插入」放进同一个写事务，不能与其他写者交错。
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const existing = db.prepare(`SELECT ${columns.join(', ')} FROM "${row.level}" WHERE id = ? COLLATE BINARY`).get(row.id);
      if (existing) {
        const conflict = columns.some((column, i) => column !== 'created_at' && column !== 'updated_at' && existing[column] !== values[i]);
        const createdAt = Number(existing.created_at);
        const updatedAt = Number(existing.updated_at);
        if (conflict || !Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
          throw new MemoryError('id_conflict', '该记忆 ID 已存在，但条目字段与待提交内容不同；没有覆盖原记录。');
        }
        db.exec('COMMIT');
        transaction = false;
        return { id: row.id, inserted: false };
      }
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(`INSERT INTO "${row.level}" (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
      db.exec('COMMIT');
      transaction = false;
      return { id: row.id, inserted: true };
    } catch (error) {
      if (transaction) {
        try { db.exec('ROLLBACK'); } catch { this.close(); }
      }
      if (error instanceof MemoryError) throw error;
      throw new MemoryError('unavailable', `写入 DSH 记忆库失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private prepared(draft: MemoryDraft, id: string) {
    const level = draft.level;
    if (!this.cfg.writeLevels.includes(level)) throw new MemoryError('forbidden_level', `level ${level} 不在允许写入的范围内。`);
    const rowId = textArg(id, 'id', 200);
    const content = textArg(draft.content, 'content', MAX_CONTENT_CHARS);
    const project = this.writableProject(level, draft.project);
    const keywords = this.writableKeywords(draft.keywords);
    const importance = draft.importance ?? 1;
    if (typeof importance !== 'number' || !Number.isInteger(importance) || importance < 1 || importance > MAX_IMPORTANCE) {
      invalid(`importance 必须是 1–${MAX_IMPORTANCE} 的整数。`);
    }
    if (draft.corrected !== undefined && typeof draft.corrected !== 'boolean') invalid('corrected 必须是布尔值。');
    return {
      id: rowId, level, content, project, keywords, importance, now: Date.now(),
      corrected: draft.corrected === true ? 1 : 0,
      title: draft.title == null ? null : textArg(draft.title, 'title', 200),
      subcategory: level === 'project' ? this.subcategory(draft.subcategory) : null,
      goal: level === 'topic' && draft.goal != null ? textArg(draft.goal, 'goal', 300) : null,
    };
  }

  close(): void { this.db?.close(); this.db = undefined; }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    let db: DatabaseSync | undefined;
    try {
      if (!statSync(this.cfg.dbFile).isFile()) throw new Error('not a file');
      db = new DatabaseSync(this.cfg.dbFile, { allowExtension: false });
      db.exec('PRAGMA busy_timeout = 2000; PRAGMA trusted_schema = OFF;');
      assertSchema(db, this.cfg.writeLevels, true);
    } catch (error) {
      db?.close();
      if (error instanceof MemoryError) throw error;
      throw new MemoryError('unavailable', 'DSH 记忆库不可写、被锁定或已损坏；本次未写入任何条目。');
    }
    this.db = db;
    return db;
  }

  /** 全局层（soul/user）与全局项目都不允许外部写入；必须落在精确项目上。 */
  private writableProject(level: Level, value: unknown): string {
    if (GLOBAL_LEVELS.includes(level) || !SCOPED_LEVELS.includes(level)) {
      throw new MemoryError('forbidden_level', `外部写入只允许项目层记忆，${level} 不在其列。`);
    }
    const project = textArg(value, 'project', 200);
    if (!this.cfg.allowedProjects.includes(project)) throw new MemoryError('forbidden_project', '该项目不在配置的写入范围内。');
    return project;
  }

  private writableKeywords(value: unknown): string[] {
    const list: unknown[] = Array.isArray(value) ? value : [];
    if (list.length === 0 || list.length > MAX_KEYWORDS) {
      invalid(`keywords 必须是 1–${MAX_KEYWORDS} 个关键词的数组。`);
    }
    const keywords = list.map((k) => textArg(k, 'keywords[]', MAX_KEYWORD_CHARS));
    return [...new Set(keywords)];
  }

  private subcategory(value: unknown): string {
    const subcategory = textArg(value, 'subcategory', 40);
    if (!SUBCATEGORIES.includes(subcategory as typeof SUBCATEGORIES[number])) invalid(`subcategory 必须是 ${SUBCATEGORIES.join('/')} 之一。`);
    return subcategory;
  }
}
