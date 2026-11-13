/**
 * Workspace file index used by the `@`-mention completion list.
 *
 * The finder is injected so the module stays free of `vscode` and can be unit
 * tested with a fake file system. Production callers pass a thin wrapper over
 * `vscode.workspace.findFiles` (see the chat controller).
 *
 * Results are workspace-relative posix paths, sorted, de-duplicated, capped at
 * {@link WORKSPACE_FILES_LIMIT}, and cached for {@link WORKSPACE_FILES_TTL_MS}
 * per workspace root.
 */

import { relativePath, toPosixPath } from './util';

/** Glob handed to `workspace.findFiles` as the exclude pattern. */
export const WORKSPACE_FILES_GLOB = '**/*';

/** Exclude pattern understood by VS Code's file search. */
export const WORKSPACE_FILES_EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/.cache/**}';

/** Directory names that never contribute files to the index. */
export const WORKSPACE_FILES_EXCLUDED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.cache',
];

/** Hard cap on the cached index. */
export const WORKSPACE_FILES_LIMIT = 2000;

/** How long a cached index stays valid. */
export const WORKSPACE_FILES_TTL_MS = 60_000;

/** Cap applied to `request-files` query results. */
export const WORKSPACE_FILE_QUERY_LIMIT = 50;

/**
 * Returns absolute file paths. Injected so tests can supply a fake finder and
 * the extension can supply `vscode.workspace.findFiles`.
 */
export type WorkspaceFileFinder = (exclude: string, maxResults: number) => Promise<readonly string[]>;

export interface LoadWorkspaceFilesOptions {
  /** Workspace root; also the cache key. */
  root: string;
  finder: WorkspaceFileFinder;
  /** Clock hook, injectable for tests. */
  now?: () => number;
  ttlMs?: number;
  limit?: number;
  /** Skip the cache and re-index. */
  force?: boolean;
}

interface CacheEntry {
  at: number;
  files: string[];
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();

function cacheKey(root: string): string {
  return toPosixPath(root).replace(/\/+$/, '');
}

function comparePaths(left: string, right: string): number {
  const leftKey = left.toLowerCase();
  const rightKey = right.toLowerCase();
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasExcludedSegment(relative: string): boolean {
  const segments = relative.split('/');
  return segments.some((segment) => WORKSPACE_FILES_EXCLUDED_DIRECTORIES.includes(segment));
}

/** Normalize raw finder output into sorted, relative, filtered posix paths. */
export function normalizeWorkspaceFiles(
  root: string,
  paths: Iterable<string>,
  limit = WORKSPACE_FILES_LIMIT,
): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const absolute of paths) {
    if (typeof absolute !== 'string' || absolute.length === 0) continue;
    const relative = toPosixPath(relativePath(root, absolute)).replace(/^\.\//, '');
    if (!relative || relative === '.') continue;
    if (relative.startsWith('../')) continue;
    // Files outside the workspace keep an absolute form; they are not offerable.
    if (relative.startsWith('/') || /^[a-zA-Z]:\//.test(relative)) continue;
    if (hasExcludedSegment(relative)) continue;
    const key = relative.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(relative);
  }
  files.sort(comparePaths);
  return files.slice(0, Math.max(0, limit));
}

/**
 * Read the workspace file index, reusing the cache when it is still fresh.
 * Concurrent callers share one in-flight finder run.
 */
export async function loadWorkspaceFiles(options: LoadWorkspaceFilesOptions): Promise<string[]> {
  const key = cacheKey(options.root);
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? WORKSPACE_FILES_TTL_MS;
  const limit = options.limit ?? WORKSPACE_FILES_LIMIT;

  if (!options.force) {
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttlMs) {
      return [...cached.files];
    }
  }

  const running = inFlight.get(key);
  if (running) {
    return running;
  }

  const pending = (async () => {
    try {
      const found = await options.finder(WORKSPACE_FILES_EXCLUDE, limit);
      const files = normalizeWorkspaceFiles(options.root, found, limit);
      cache.set(key, { at: now(), files });
      return [...files];
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, pending);
  return pending;
}

/** Case-insensitive substring filter over the cached index. */
export function filterWorkspaceFiles(
  files: readonly string[],
  query: string,
  limit = WORKSPACE_FILE_QUERY_LIMIT,
): string[] {
  const needle = query.trim().toLowerCase();
  const matched = needle ? files.filter((file) => file.toLowerCase().includes(needle)) : files;
  return matched.slice(0, Math.max(0, limit));
}

/** Drop the cache for one root, or every root when called without arguments. */
export function clearWorkspaceFilesCache(root?: string): void {
  if (root === undefined) {
    cache.clear();
    inFlight.clear();
    return;
  }
  const key = cacheKey(root);
  cache.delete(key);
  inFlight.delete(key);
}
