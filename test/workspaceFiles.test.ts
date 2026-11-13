import { beforeEach, describe, expect, it } from 'vitest';
import {
  WORKSPACE_FILES_EXCLUDE,
  WORKSPACE_FILES_LIMIT,
  WORKSPACE_FILES_TTL_MS,
  clearWorkspaceFilesCache,
  filterWorkspaceFiles,
  loadWorkspaceFiles,
  normalizeWorkspaceFiles,
} from '../src/workspaceFiles';

const ROOT = 'D:\\WK_file\\repo';

interface FinderCall {
  exclude: string;
  maxResults: number;
}

function fakeFinder(files: readonly string[]) {
  const calls: FinderCall[] = [];
  const finder = async (exclude: string, maxResults: number): Promise<readonly string[]> => {
    calls.push({ exclude, maxResults });
    return files;
  };
  return { finder, calls };
}

beforeEach(() => {
  clearWorkspaceFilesCache();
});

describe('normalizeWorkspaceFiles', () => {
  it('relativizes to posix paths and sorts them', () => {
    const files = normalizeWorkspaceFiles(ROOT, [
      'D:\\WK_file\\repo\\src\\util.ts',
      'D:\\WK_file\\repo\\README.md',
      'D:\\WK_file\\repo\\src\\App.ts',
    ]);
    expect(files).toEqual(['README.md', 'src/App.ts', 'src/util.ts']);
  });

  it('drops excluded directories at any depth', () => {
    const files = normalizeWorkspaceFiles(ROOT, [
      'D:\\WK_file\\repo\\node_modules\\left-pad\\index.js',
      'D:\\WK_file\\repo\\packages\\a\\node_modules\\b\\index.js',
      'D:\\WK_file\\repo\\.git\\config',
      'D:\\WK_file\\repo\\dist\\extension.js',
      'D:\\WK_file\\repo\\out\\build.js',
      'D:\\WK_file\\repo\\web\\.next\\cache.js',
      'D:\\WK_file\\repo\\web\\.cache\\state.json',
      'D:\\WK_file\\repo\\src\\main.ts',
    ]);
    expect(files).toEqual(['src/main.ts']);
  });

  it('drops files outside the workspace root', () => {
    const files = normalizeWorkspaceFiles(ROOT, [
      'D:\\WK_file\\repo\\src\\a.ts',
      'C:\\other\\b.ts',
      '/elsewhere/c.ts',
    ]);
    expect(files).toEqual(['src/a.ts']);
  });

  it('de-duplicates case-insensitively', () => {
    const files = normalizeWorkspaceFiles(ROOT, [
      'D:\\WK_file\\repo\\src\\a.ts',
      'D:\\WK_file\\repo\\src\\a.ts',
      'D:\\WK_file\\repo\\SRC\\a.ts',
    ]);
    expect(files).toEqual(['src/a.ts']);
  });

  it('caps the result at the configured limit', () => {
    const all = Array.from({ length: 2500 }, (_, index) => `${ROOT}\\f${String(index).padStart(4, '0')}.ts`);
    const files = normalizeWorkspaceFiles(ROOT, all);
    expect(files).toHaveLength(WORKSPACE_FILES_LIMIT);
    expect(files[0]).toBe('f0000.ts');
    expect(files[files.length - 1]).toBe('f1999.ts');
  });
});

describe('loadWorkspaceFiles', () => {
  it('hands the exclude glob and the cap to the finder', async () => {
    const { finder, calls } = fakeFinder([`${ROOT}\\README.md`]);
    await loadWorkspaceFiles({ root: ROOT, finder });
    expect(calls).toEqual([{ exclude: WORKSPACE_FILES_EXCLUDE, maxResults: WORKSPACE_FILES_LIMIT }]);
    expect(WORKSPACE_FILES_EXCLUDE).toContain('**/node_modules/**');
    expect(WORKSPACE_FILES_EXCLUDE).toContain('**/.cache/**');
  });

  it('caches results for 60 s and refreshes after the TTL', async () => {
    let clock = 1_000;
    const { finder, calls } = fakeFinder([`${ROOT}\\src\\a.ts`]);
    const now = () => clock;

    expect(await loadWorkspaceFiles({ root: ROOT, finder, now })).toEqual(['src/a.ts']);
    clock += WORKSPACE_FILES_TTL_MS - 1_000;
    expect(await loadWorkspaceFiles({ root: ROOT, finder, now })).toEqual(['src/a.ts']);
    expect(calls).toHaveLength(1);

    clock += 2_000;
    expect(await loadWorkspaceFiles({ root: ROOT, finder, now })).toEqual(['src/a.ts']);
    expect(calls).toHaveLength(2);
  });

  it('keys the cache by workspace root', async () => {
    const { finder, calls } = fakeFinder([`${ROOT}\\src\\a.ts`]);
    await loadWorkspaceFiles({ root: ROOT, finder });
    await loadWorkspaceFiles({ root: 'D:\\WK_file\\other', finder });
    expect(calls).toHaveLength(2);
  });

  it('re-indexes when forced', async () => {
    const { finder, calls } = fakeFinder([`${ROOT}\\src\\a.ts`]);
    await loadWorkspaceFiles({ root: ROOT, finder });
    await loadWorkspaceFiles({ root: ROOT, finder, force: true });
    expect(calls).toHaveLength(2);
  });

  it('clears one root or the whole cache', async () => {
    const { finder, calls } = fakeFinder([`${ROOT}\\src\\a.ts`]);
    await loadWorkspaceFiles({ root: ROOT, finder });
    clearWorkspaceFilesCache(ROOT);
    await loadWorkspaceFiles({ root: ROOT, finder });
    expect(calls).toHaveLength(2);
    clearWorkspaceFilesCache();
    await loadWorkspaceFiles({ root: ROOT, finder });
    expect(calls).toHaveLength(3);
  });

  it('shares one finder run between concurrent callers', async () => {
    const { finder, calls } = fakeFinder([`${ROOT}\\src\\a.ts`]);
    const [first, second] = await Promise.all([
      loadWorkspaceFiles({ root: ROOT, finder }),
      loadWorkspaceFiles({ root: ROOT, finder }),
    ]);
    expect(calls).toHaveLength(1);
    expect(first).toEqual(['src/a.ts']);
    expect(second).toEqual(['src/a.ts']);
  });

  it('does not expose the cached array for mutation', async () => {
    const { finder } = fakeFinder([`${ROOT}\\src\\a.ts`]);
    const first = await loadWorkspaceFiles({ root: ROOT, finder });
    first.push('mutated.ts');
    const second = await loadWorkspaceFiles({ root: ROOT, finder });
    expect(second).toEqual(['src/a.ts']);
  });
});

describe('filterWorkspaceFiles', () => {
  const files = ['README.md', 'src/App.ts', 'src/util.ts', 'docs/readme-old.md'];

  it('matches a case-insensitive substring', () => {
    expect(filterWorkspaceFiles(files, 'README')).toEqual(['README.md', 'docs/readme-old.md']);
    expect(filterWorkspaceFiles(files, 'SRC/')).toEqual(['src/App.ts', 'src/util.ts']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterWorkspaceFiles(files, 'nope')).toEqual([]);
  });

  it('returns the first 50 entries for an empty query', () => {
    const many = Array.from({ length: 120 }, (_, index) => `f${index}.ts`);
    expect(filterWorkspaceFiles(many, '')).toHaveLength(50);
    expect(filterWorkspaceFiles(many, '   ')).toHaveLength(50);
    expect(filterWorkspaceFiles(many, '')[0]).toBe('f0.ts');
  });

  it('caps matches at the query limit', () => {
    const many = Array.from({ length: 120 }, (_, index) => `src/f${index}.ts`);
    expect(filterWorkspaceFiles(many, 'src/')).toHaveLength(50);
  });
});
