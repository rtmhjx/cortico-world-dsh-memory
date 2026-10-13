import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export interface WorkspaceBinding { configured: string; real: string; dev: number; ino: number; birthtimeMs: number }
export interface WorkspaceScopeOptions {
  allowedWorkspaces?: readonly string[];
  deniedWorkspaces?: readonly string[];
  workspaceBindings?: readonly WorkspaceBinding[];
}
function protectedWorkspace(path: string): boolean {
  const value = path.replaceAll('/', '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase();
  return ['f:\\ai\\对话备份', 'f:\\ai\\对话记录'].some(root => value === root || value.startsWith(root + '\\'));
}
export function containsWorkspace(root: string, target: string): boolean {
  const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const delta = relative(fold(root), fold(target));
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + sep));
}
export function canonicalWorkspace(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('工作区路径必须是合法绝对路径。');
  let current = resolve(path); const suffix: string[] = [];
  while (!existsSync(current)) { const parent = dirname(current); if (parent === current) throw new Error('工作区路径没有有效父目录。'); suffix.unshift(basename(current)); current = parent; }
  return join(realpathSync.native(current), ...suffix);
}
export function bindWorkspaces(roots: readonly string[]): WorkspaceBinding[] {
  return roots.map(configured => {
    if (protectedWorkspace(configured)) throw new Error('受保护的对话记录或备份目录不能作为授权工作区。');
    if (!existsSync(configured) || !statSync(configured).isDirectory()) throw new Error('授权工作区根目录不存在或不是目录。');
    const info = statSync(configured);
    const real = canonicalWorkspace(configured);
    if (protectedWorkspace(real)) throw new Error('授权工作区的真实目标属于受保护目录。');
    return { configured: resolve(configured), real, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
  });
}
export function checkWorkspaceBindings(bindings: readonly WorkspaceBinding[]): void {
  for (const item of bindings) {
    if (!existsSync(item.configured)) throw new Error('授权工作区根目录已消失；保留状态并拒绝读取。');
    const info = statSync(item.configured);
    if (!info.isDirectory() || canonicalWorkspace(item.configured) !== item.real || info.dev !== item.dev || info.ino !== item.ino || info.birthtimeMs !== item.birthtimeMs) throw new Error('授权工作区根目录已替换或重定向；保留状态并拒绝读取，请重新核对配置。');
  }
}
/** Return canonical cwd only after both the lexical and real paths are authorized. */
export function authorizedWorkspace(cwd: unknown, opts: WorkspaceScopeOptions): string | null {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) return null;
  const bindings = opts.workspaceBindings ?? bindWorkspaces(opts.allowedWorkspaces ?? []);
  checkWorkspaceBindings(bindings);
  const lexical = resolve(cwd), real = canonicalWorkspace(cwd);
  for (const path of ['F:/AI/对话备份', 'F:/AI/对话记录']) if (isAbsolute(path)) {
    const protectedDir = canonicalWorkspace(path);
    if (containsWorkspace(resolve(path), lexical) || containsWorkspace(protectedDir, real)) return null;
  }
  if (!bindings.some(root => containsWorkspace(root.configured, lexical) && containsWorkspace(root.real, real))) return null;
  for (const path of opts.deniedWorkspaces ?? []) {
    if (containsWorkspace(resolve(path), lexical) || containsWorkspace(canonicalWorkspace(path), real)) return null;
  }
  return real;
}
export function workspaceScopeHash(opts: WorkspaceScopeOptions): string {
  return createHash('sha256').update(JSON.stringify({ roots: opts.workspaceBindings ?? bindWorkspaces(opts.allowedWorkspaces ?? []), denied: (opts.deniedWorkspaces ?? []).map(path => ({ configured: resolve(path), real: canonicalWorkspace(path) })) })).digest('hex');
}
