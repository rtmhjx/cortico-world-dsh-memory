import type { ConfigGroup } from 'cortico/core/types.ts';
import { isAbsolute } from 'node:path';

export const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'] as const;
export type Level = typeof LEVELS[number];

/** meow-memory 里不带 project 列的全局层；外部写入不允许触碰。 */
export const GLOBAL_LEVELS: readonly Level[] = ['soul', 'user'];
/** 需要精确项目归属的层。 */
export const SCOPED_LEVELS: readonly Level[] = ['project', 'fact', 'lesson', 'topic', 'rules'];
/** project 层的子分类，与 meow-memory 的约定一致。 */
export const SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'] as const;
/** record 只保存来源元数据；其余值使用 Core 的投递触发方式。 */
export const WATCH_TRIGGERS = ['record', 'flush', 'debounce', 'piggyback'] as const;
export type WatchTrigger = typeof WATCH_TRIGGERS[number];

export interface DshMemoryConfigSection {
  enabled: boolean;
  sourceMode: 'memory' | 'workspace';
  workspaceRoots: string;
  workspaceDenied: string;
  workspaceFilesEnabled: boolean;
  workspaceMaxFileBytes: number;
  dbFile: string;
  allowedProjects: string;
  includeGlobal: boolean;
  levels: string;
  /** 计时输入：轮询 DSH 新条目的间隔秒数；0 关闭定时推送。 */
  watchIntervalSeconds: number;
  /** 计时输入：记录或事件投递方式。 */
  watchTrigger: string;
  /** 计时输入：每次轮询最多推送的条目数，其余留到下一次。 */
  watchMaxPerTick: number;
  /** 计时输入：推送正文里每条记忆正文的最大字符数。 */
  watchContentChars: number;
  /** 计时入库：是否提供写入工具。 */
  writeEnabled: boolean;
  /** 计时入库：写入队列的冲刷间隔秒数；0 表示调用即写。 */
  writeFlushSeconds: number;
  /** 计时入库：允许写入的记忆层，必须是 levels 的子集。 */
  writeLevels: string;
  /** 计时入库：写入条目的来源标签，写进 source_session 列。 */
  writeSourceLabel: string;
  /** 原文镜像：是否提供「直接读 DSH 会话原文」的工具。 */
  rawEnabled: boolean;
  /** 原文镜像：DSH 会话日志根目录；空 = `~/.dsh/sessions`。 */
  sessionsDir: string;
  /** 原文镜像：镜像区目录；空 = 记忆库同级的 `raw/`。 */
  rawDir: string;
  /** 原文镜像：只收哪些工作区（逗号分隔的桶名）；空 = 全部。 */
  rawBuckets: string;
  /** 原文镜像：一次同步最多收录多少轮，其余留到下次（防首次同步刷爆）。 */
  rawMaxTurns: number;
  rawSyncIntervalSeconds: number;
  rawMaxSourceBytes: number;
  healthCheckIntervalSeconds: number;
  writeMaxPerTick: number;
  queueMaxPending: number;
  stateDir: string;
}

export interface DshMemoryAccess
  extends Omit<DshMemoryConfigSection, 'allowedProjects' | 'levels' | 'watchTrigger' | 'writeLevels' | 'rawBuckets' | 'workspaceRoots' | 'workspaceDenied'> {
  workspaceRoots: string[];
  workspaceDenied: string[];
  allowedProjects: string[];
  levels: Level[];
  watchTrigger: WatchTrigger;
  writeLevels: Level[];
  rawBuckets: string[];
}

function splitList(value: unknown, field: string): string[] {
  if (typeof value !== 'string') throw new Error(`${field} 必须使用半角逗号分隔的文本。`);
  return [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
}

function wholeNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} 必须是 ${min}–${max} 的整数。`);
  }
  return value;
}

function pathList(value: unknown, field: string): string[] {
  if (typeof value !== 'string') throw new Error(`${field} 必须是绝对路径 JSON 数组。`);
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error(`${field} 必须是合法 JSON 数组。`); }
  if (!Array.isArray(parsed) || parsed.some(path => typeof path !== 'string' || !path.trim() || !isAbsolute(path) || /[\x00-\x1f]/.test(path))) throw new Error(`${field} 必须是绝对路径 JSON 数组。`);
  return [...new Set(parsed)] as string[];
}

export function resolveAccessConfig(cfg: DshMemoryConfigSection): DshMemoryAccess {
  // 升级前写入的部署配置不会带新字段：缺的按出厂默认补齐，显式给的非法值照样报错。
  const filled: DshMemoryConfigSection = { ...dshMemoryDefaults(), ...cfg };
  for (const key of ['enabled','includeGlobal','writeEnabled','rawEnabled','workspaceFilesEnabled'] as const) {
    if (typeof filled[key] !== 'boolean') throw new Error(`${key} 必须是布尔值。`);
  }
  if (!['memory', 'workspace'].includes(filled.sourceMode)) throw new Error('sourceMode 必须是 memory/workspace。');
  const workspaceRoots = pathList(filled.workspaceRoots, 'workspaceRoots'), workspaceDenied = pathList(filled.workspaceDenied, 'workspaceDenied');
  if ((filled.sourceMode === 'workspace' || filled.workspaceFilesEnabled) && !workspaceRoots.length) throw new Error('工作区模式和文件工具要求至少一个 workspaceRoots。');
  for (const key of ['dbFile','sessionsDir','rawDir','rawBuckets','stateDir'] as const) {
    if (typeof filled[key] !== 'string') throw new Error(`${key} 必须是文本。`);
  }
  const levels = splitList(filled.levels, 'levels') as Level[];
  for (const level of levels) if (!LEVELS.includes(level)) throw new Error(`levels 含未知记忆层：${level}`);
  if (!WATCH_TRIGGERS.includes(filled.watchTrigger as WatchTrigger)) {
    throw new Error(`watchTrigger 必须是 ${WATCH_TRIGGERS.join('/')} 之一。`);
  }
  const writeLevels = splitList(filled.writeLevels, 'writeLevels') as Level[];
  for (const level of writeLevels) {
    if (GLOBAL_LEVELS.includes(level)) throw new Error(`writeLevels 不允许包含全局层 ${level}（soul/user 由 DSH 侧自己维护）。`);
    if (!LEVELS.includes(level)) throw new Error(`writeLevels 含未知记忆层：${level}`);
    if (!levels.includes(level)) throw new Error(`writeLevels 的 ${level} 不在 levels 读取范围内：写完自己也读不到。`);
  }
  if (typeof filled.writeSourceLabel !== 'string' || !filled.writeSourceLabel.trim() || filled.writeSourceLabel.length > 200) {
    throw new Error('writeSourceLabel 必须是 1–200 字符的非空字符串。');
  }
  return {
    ...filled,
    workspaceRoots, workspaceDenied,
    workspaceMaxFileBytes: wholeNumber(filled.workspaceMaxFileBytes, 'workspaceMaxFileBytes', 1024, 8 * 1024 * 1024),
    writeEnabled: filled.sourceMode === 'memory' && filled.writeEnabled,
    allowedProjects: splitList(filled.allowedProjects, 'allowedProjects'),
    levels,
    writeLevels,
    rawBuckets: filled.rawBuckets.trim() ? splitList(filled.rawBuckets, 'rawBuckets') : [],
    watchTrigger: filled.watchTrigger as WatchTrigger,
    watchIntervalSeconds: wholeNumber(filled.watchIntervalSeconds, 'watchIntervalSeconds', 0, 86_400),
    watchMaxPerTick: wholeNumber(filled.watchMaxPerTick, 'watchMaxPerTick', 1, 100),
    watchContentChars: wholeNumber(filled.watchContentChars, 'watchContentChars', 1, 32_000),
    writeFlushSeconds: wholeNumber(filled.writeFlushSeconds, 'writeFlushSeconds', 0, 86_400),
    rawMaxTurns: wholeNumber(filled.rawMaxTurns, 'rawMaxTurns', 1, 100_000),
    rawSyncIntervalSeconds: wholeNumber(filled.rawSyncIntervalSeconds, 'rawSyncIntervalSeconds', 0, 86_400),
    rawMaxSourceBytes: wholeNumber(filled.rawMaxSourceBytes, 'rawMaxSourceBytes', 1024, 1024 * 1024 * 1024),
    healthCheckIntervalSeconds: wholeNumber(filled.healthCheckIntervalSeconds, 'healthCheckIntervalSeconds', 5, 3600),
    writeMaxPerTick: wholeNumber(filled.writeMaxPerTick, 'writeMaxPerTick', 1, 100),
    queueMaxPending: wholeNumber(filled.queueMaxPending, 'queueMaxPending', 1, 10_000),
  };
}

export function dshMemoryDefaults(): DshMemoryConfigSection {
  return {
    enabled: false, sourceMode: 'memory', workspaceRoots: '[]', workspaceDenied: '[]', workspaceFilesEnabled: false, workspaceMaxFileBytes: 1024 * 1024,
    dbFile: '', allowedProjects: '', includeGlobal: false,
    levels: 'project,fact,lesson,topic,rules',
    watchIntervalSeconds: 60, watchTrigger: 'record', watchMaxPerTick: 5, watchContentChars: 400,
    writeEnabled: true, writeFlushSeconds: 15, writeLevels: 'fact,topic', writeSourceLabel: 'cortico-world-dsh-memory',
    rawEnabled: true, sessionsDir: '', rawDir: '', rawBuckets: '', rawMaxTurns: 2000,
    rawSyncIntervalSeconds: 60, rawMaxSourceBytes: 64 * 1024 * 1024,
    healthCheckIntervalSeconds: 15, writeMaxPerTick: 20, queueMaxPending: 1000, stateDir: '',
  };
}

export const DSHMEMORY_CONFIG_GROUP: ConfigGroup = {
  id: 'world:dshmemory', owner: 'world:dshmemory',
  schema: {
    type: 'object', title: 'DSH 外部记忆（计时输入 / 计时入库）',
    properties: {
      'worlds.dshmemory.sourceMode': { type: 'string', enum: ['memory', 'workspace'], title: 'DSH 来源模式', 'x-hot': false, description: 'memory 使用 SQLite 外部记忆；workspace 按授权工作区读取 DSH 会话，无需记忆库且只读。切换后重启 World。' },
      'worlds.dshmemory.workspaceRoots': { type: 'string', title: '允许的工作区根目录（JSON）', 'x-hot': false, description: '绝对路径 JSON 数组，例如 ["/projects/demo"]。会话按实际 session.cwd 校验；文件工具只允许这些根。' },
      'worlds.dshmemory.workspaceDenied': { type: 'string', title: '禁止的工作区路径（JSON）', 'x-hot': false, description: '绝对路径 JSON 数组，禁止优先于允许，含符号链接真实目标。' },
      'worlds.dshmemory.workspaceFilesEnabled': { type: 'boolean', title: '启用按需项目文件读取', 'x-hot': false, description: '默认关闭。开启提供 list/read/search，只读，不自动扫描推送；凭据、隐藏目录和二进制默认跳过。' },
      'worlds.dshmemory.workspaceMaxFileBytes': { type: 'integer', title: '项目单文件读取预算（字节）', 'x-hot': false, minimum: 1024, maximum: 8388608, description: '默认 1 MiB；超过预算拒绝读取，不截断后冒充全文。' },
      'worlds.dshmemory.stateDir': { type: 'string', title: '运行状态与审计目录', 'x-hot': false, 'x-path': { kind: 'directory' }, description: '留空使用部署 data/dshmemory。保存投递游标、待写队列与每日元数据日志；不可放进源会话或受保护目录。' },
      'worlds.dshmemory.healthCheckIntervalSeconds': { type: 'integer', title: '读库健康检查间隔（秒）', 'x-hot': false, minimum: 5, maximum: 3600, description: '没有新数据时仍定期检查读库并记录心跳。' },
      'worlds.dshmemory.writeMaxPerTick': { type: 'integer', title: '单次写回上限', 'x-hot': false, minimum: 1, maximum: 100 },
      'worlds.dshmemory.queueMaxPending': { type: 'integer', title: '持久写回队列上限', 'x-hot': false, minimum: 1, maximum: 10000 },
      'worlds.dshmemory.rawSyncIntervalSeconds': { type: 'integer', title: '原文自动同步间隔（秒）', 'x-hot': false, minimum: 0, maximum: 86400, description: '在独立 Worker 中自动同步；0 = 手动。无新会话仍显示在线并记录检查时间。' },
      'worlds.dshmemory.rawMaxSourceBytes': { type: 'integer', title: '单次原文源读取预算（字节）', 'x-hot': false, minimum: 1024, maximum: 1073741824, description: '限制每轮源读取；未完成的游标留待下一轮。' },
      'worlds.dshmemory.dbFile': {
        type: 'string', title: 'DSH 记忆库文件',
        'x-hot': false, 'x-path': { kind: 'file', extensions: ['db'] },
        description: '浏览器 DSH 工作区的 .dsh-meow/memory.db 绝对路径。修改后重启 World。',
      },
      'worlds.dshmemory.allowedProjects': {
        type: 'string', title: '允许读写的项目', 'x-hot': false,
        description: '项目名用半角逗号分隔，例如 dsh,meow-memory；精确匹配，至少一个。修改后重启 World。',
      },
      'worlds.dshmemory.includeGlobal': {
        type: 'boolean', title: '包含全局记忆', 'x-hot': false,
        description: '允许读取空项目、global、全局条目；soul/user 层也要求启用此项。修改后重启 World。',
      },
      'worlds.dshmemory.levels': {
        type: 'string', title: '允许读取的记忆层', 'x-hot': false,
        description: '半角逗号分隔：soul,user,project,fact,lesson,topic,rules。每条保留 DSH 来源。修改后重启 World。',
      },
      'worlds.dshmemory.watchIntervalSeconds': {
        type: 'number', title: '计时输入间隔（秒）', 'x-hot': false,
        description: '每隔这么多秒检查 DSH 库里有没有新写入/更新的条目，有就合成一条事件推给自己，不必自己轮询工具。0 = 关闭。',
      },
      'worlds.dshmemory.watchTrigger': {
        type: 'string', enum: [...WATCH_TRIGGERS], title: '记忆变更处理方式', 'x-hot': false,
        description: '默认 record：只记录来源和计数，不唤醒模型。flush/debounce/piggyback 会投递记忆正文。',
      },
      'worlds.dshmemory.watchMaxPerTick': {
        type: 'number', title: '每次推送条目上限', 'x-hot': false,
        description: '超出的条目留到下一次轮询，避免一次刷屏。',
      },
      'worlds.dshmemory.watchContentChars': {
        type: 'number', title: '推送正文截断字数', 'x-hot': false,
        description: '推送事件里每条记忆正文最多保留多少字符；完整正文仍可用 dshmemory_read 读取。',
      },
      'worlds.dshmemory.writeEnabled': {
        type: 'boolean', title: '允许计时入库（写回 DSH 库）', 'x-hot': false,
        description: '开启后提供 dshmemory_remember：内容先入队列，按下面的间隔写进 DSH 记忆库。修改后重启 World。',
      },
      'worlds.dshmemory.writeFlushSeconds': {
        type: 'number', title: '计时入库间隔（秒）', 'x-hot': false,
        description: '写入队列每隔这么多秒冲刷一次；0 = 调用即写。',
      },
      'worlds.dshmemory.writeLevels': {
        type: 'string', title: '允许写入的记忆层', 'x-hot': false,
        description: '半角逗号分隔，且必须是读取层的子集。默认 fact,topic；soul/user 不允许外部写入。',
      },
      'worlds.dshmemory.writeSourceLabel': {
        type: 'string', title: '写入来源标签', 'x-hot': false,
        description: '写进 source_session 列，供 DSH 侧辨认条目来源。',
      },
      'worlds.dshmemory.rawEnabled': {
        type: 'boolean', title: '原文镜像（直接读 DSH 会话原文）', 'x-hot': false,
        description: '开启后提供 dshmemory_raw_sync / dshmemory_raw_search / dshmemory_raw_read：'
          + '把 DSH 各个窗口的**未蒸馏对话原文**增量抽到镜像区，可直接检索阅读。修改后重启 World。',
      },
      'worlds.dshmemory.sessionsDir': {
        type: 'string', title: 'DSH 会话日志根目录', 'x-hot': false,
        'x-path': { kind: 'directory' },
        description: '留空 = `~/.dsh/sessions`。它的每个子目录是一个工作区桶，里面是追加式多帧 zstd 的会话文件。',
      },
      'worlds.dshmemory.rawDir': {
        type: 'string', title: '原文镜像区目录', 'x-hot': false,
        'x-path': { kind: 'directory' },
        description: '留空 = 记忆库同级的 `raw/`。镜像按「工作区/日期.jsonl」组织，只追加不覆盖。',
      },
      'worlds.dshmemory.rawBuckets': {
        type: 'string', title: '只收这些工作区', 'x-hot': false,
        description: '半角逗号分隔的桶名（如 `--F-AI-~5411~91CF~8BB0~5FC6~5E93--`）；留空 = 全部工作区。',
      },
      'worlds.dshmemory.rawMaxTurns': {
        type: 'integer', title: '一次同步的轮次上限', 'x-hot': false,
        description: '一次 dshmemory_raw_sync 最多收录多少轮对话，其余留到下次；防止首次同步刷爆镜像区。',
      },
    },
  },
};
