import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `sanitizeErrorMessage` is the single funnel for every catch-block log in
 * `action/` and `app/`. Nothing enforced that — the convention lived only in
 * reviewer memory, so it drifted. This test turns it into a build-time check.
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = resolve(PKG_ROOT, '..');

/** Directories whose catch blocks must route errors through the funnel. */
const SWEPT_DIRS = ['action/src', 'app/src'] as const;

/** Guards that legitimately inspect an error's shape instead of logging it. */
const ALLOWED_TYPE_GUARDS = [
  // Abort/timeout classification reads `.name`, never `.message`.
  /instanceof Error && \w+\.name ===/,
  // `describeUnhandledFailure` needs the raw stack to sanitize it separately.
  /instanceof Error && typeof \w+\.stack === 'string'/,
];

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('error-logging sanitization convention', () => {
  const files = SWEPT_DIRS.flatMap((dir) => collectSourceFiles(join(REPO_ROOT, dir)));

  it('finds source files to scan', () => {
    expect(existsSync(join(REPO_ROOT, 'action/src'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'app/src'))).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });

  it('routes every logged error through sanitizeErrorMessage', () => {
    const offenders: string[] = [];
    // `${x instanceof Error ? x.message : ...}` inside a template literal is
    // the pre-sweep anti-pattern: it inlines raw error text with no redaction.
    const rawInterpolation = /\$\{(\w+) instanceof Error \? \1\.message : (?:String\(\1\)|\1)\}/;

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!rawInterpolation.test(line)) return;
        if (ALLOWED_TYPE_GUARDS.some((re) => re.test(line))) return;
        offenders.push(`${file.replace(`${REPO_ROOT}/`, '')}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
