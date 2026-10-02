/**
 * Defect: a PR author could make the reviewer allocate a billion `Set`
 * entries with a single line of diff.
 *
 * `parseDiffHunkLines` reads the hunk count straight out of the diff header
 * (`@@ -1,1 +1,1000000000 @@`). `flushHunk` then runs
 * `for (let i = 0; i < hunkCount; i++) lines.add(...)` whenever the body walk
 * ended before the declared count. Nothing bounded the declared count, so the
 * loop is driven entirely by attacker-controlled text.
 *
 * This is reachable from the GitHub adapter with a crafted header. On GitLab
 * it is reachable with no craft at all: MAX_DIFF_FILES / MAX_DIFF_BYTES_PER_FILE
 * truncate a legitimately enormous hunk while preserving its header, so
 * `hunkCount` keeps its true declared size while the body walk stops early.
 *
 * The fallback exists so a parsing surprise yields an extra comment position
 * rather than dropping a valid finding. That fail-open intent is right; it
 * just needs a bound that is not the attacker's number.
 *
 * Each test below is written as an attack: a diff a hostile PR author could
 * actually submit.
 */
import { describe, expect, it } from 'vitest';
import { MAX_FALLBACK_MAPPED_LINES, parseDiffHunkLines } from '../src/utils/github.js';

/**
 * A diff whose header declares a hunk span far larger than its body.
 *
 * The count is written as plain digits on purpose. An earlier version of this
 * helper formatted it with `toLocaleString`, which emits thousands separators
 * ("1,000,000,000"); the hunk regex is `\+([0-9]+)` and does not accept
 * commas, so the hunk header never matched, `hunkCount` stayed 0, and the two
 * tests passed against code the attack had not reached. Git writes hunk
 * counts without separators, so digits are both the realistic payload and the
 * one that actually exercises the loop.
 */
function craftedDiff(declaredSpan: number): string {
  return [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    `@@ -1,1 +1,${declaredSpan} @@`,
    '+export const value = 1;',
    ' context line',
  ].join('\n');
}

describe('parseDiffHunkLines bounds the header-declared hunk span', () => {
  it('does not allocate a billion entries for a declared billion-line hunk', () => {
    // The attack. Before the bound this loop calls `lines.add` 1e9 times and
    // the process dies on memory pressure.
    const started = Date.now();
    const lines = parseDiffHunkLines(craftedDiff(1_000_000_000));
    const elapsed = Date.now() - started;

    expect(elapsed, 'parsing a crafted hunk header took pathologically long').toBeLessThan(2000);
    // The property is "bounded by an explicit constant", not a particular
    // number: MAX_FALLBACK_MAPPED_LINES is generous enough for any real hunk
    // (minified bundles) while keeping a declared 1e9 span from allocating.
    expect(lines.size).toBeLessThanOrEqual(MAX_FALLBACK_MAPPED_LINES);
    expect(lines.size).toBeLessThan(1_000_000_000);
  });

  it('bounds the allocation to what the diff body could actually contain', () => {
    const lines = parseDiffHunkLines(craftedDiff(500_000_000));
    expect(lines.size).toBeLessThanOrEqual(MAX_FALLBACK_MAPPED_LINES);
  });

  it('does not multiply the allocation across many crafted hunks', () => {
    // A per-hunk ceiling would not be a bound: a diff with many hunk headers
    // each declaring a huge span multiplies the allocation.
    const many = ['diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ b/b.ts'];
    for (let i = 0; i < 200; i++) {
      many.push(`@@ -1,1 +1,1000000000 @@`, '+x');
    }
    const started = Date.now();
    const lines = parseDiffHunkLines(many.join('\n'));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines.size).toBeLessThanOrEqual(MAX_FALLBACK_MAPPED_LINES);
  });

  it('still maps the real lines of a normal hunk', () => {
    // Anti-vacuity: a bound that silently disabled the fallback would also
    // pass the two tests above. A legitimate hunk must still produce every
    // position it declares.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,5 @@',
      '+one',
      '+two',
      '+three',
      '+four',
      '+five',
    ].join('\n');
    const lines = parseDiffHunkLines(diff);
    expect(lines.has('src/a.ts:1')).toBe(true);
    expect(lines.has('src/a.ts:5')).toBe(true);
    expect(lines.size).toBeGreaterThanOrEqual(5);
  });

  it('survives a header declaring a span larger than the body without a craft', () => {
    // The GitLab truncation shape: the header is preserved, the body is cut.
    // No attacker input beyond a large-but-valid file.
    const diff = [
      'diff --git a/dist/bundle.js b/dist/bundle.js',
      '--- a/dist/bundle.js',
      '+++ b/dist/bundle.js',
      '@@ -1,1 +1,900000000 @@',
      '+var a=1;',
    ].join('\n');
    const started = Date.now();
    const lines = parseDiffHunkLines(diff);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines.size).toBeLessThanOrEqual(MAX_FALLBACK_MAPPED_LINES);
  });
});
