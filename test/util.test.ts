import { describe, expect, it } from 'vitest';
import { delay, errorMessage, relativePath, toPosixPath, truncate, uid } from '../src/util';

describe('uid', () => {
  it('is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uid('nonce')));
    expect(ids.size).toBe(500);
  });

  it('honours the prefix', () => {
    expect(uid('tool')).toMatch(/^tool-/);
  });
});

describe('truncate', () => {
  it('returns short text untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('keeps the requested length and counts omitted characters', () => {
    const text = 'a'.repeat(100);
    const out = truncate(text, 10);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out).toContain('90 chars omitted');
  });

  it('does not truncate at the boundary', () => {
    const text = 'b'.repeat(10);
    expect(truncate(text, 10)).toBe(text);
  });
});

describe('errorMessage', () => {
  it('reads Error messages', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('passes strings through', () => {
    expect(errorMessage('plain')).toBe('plain');
  });

  it('serializes objects', () => {
    expect(errorMessage({ code: 'x' })).toBe('{"code":"x"}');
  });

  it('survives circular objects', () => {
    const value: Record<string, unknown> = {};
    value['self'] = value;
    expect(typeof errorMessage(value)).toBe('string');
  });
});

describe('paths', () => {
  it('converts backslashes to posix separators', () => {
    expect(toPosixPath('D:\\WK_file\\dsh-vscode-ok\\src\\util.ts')).toBe(
      'D:/WK_file/dsh-vscode-ok/src/util.ts',
    );
  });

  it('relativizes files inside the workspace root', () => {
    expect(relativePath('D:\\WK_file\\repo', 'D:\\WK_file\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  it('tolerates a trailing separator on the root', () => {
    expect(relativePath('D:\\WK_file\\repo\\', 'D:\\WK_file\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  it('keeps files outside the root absolute', () => {
    expect(relativePath('D:\\WK_file\\repo', 'C:\\other\\b.ts')).toBe('C:/other/b.ts');
  });

  it('does not treat a sibling prefix as inside the root', () => {
    expect(relativePath('D:\\WK_file\\repo', 'D:\\WK_file\\repo-other\\c.ts')).toBe(
      'D:/WK_file/repo-other/c.ts',
    );
  });
});

describe('delay', () => {
  it('resolves after the requested time', async () => {
    const start = Date.now();
    await delay(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
