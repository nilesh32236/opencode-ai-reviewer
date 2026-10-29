/**
 * Shared unified-diff hunk parser used by the GitHub and GitLab adapters.
 *
 * The function used to be duplicated almost verbatim in both adapters. The
 * duplication mattered because the fallback loop reads the hunk size from
 * PR-author-controlled header text and is bounded by a shared budget; a fix
 * applied to one copy would silently leave the other platform exposed.
 */

/**
 * Total number of positions {@link parseDiffHunkLines} may invent through the
 * declared-range fallback, across the whole diff.
 *
 * The fallback exists so a truncated or bodiless hunk still yields the
 * positions a finding needs — fail-open, because dropping a mappable finding
 * is the worse failure. But the range it recovers is read from the
 * `@@ -a,b +c,d @@` header, which is PR-author-controlled text, so it needs a
 * ceiling.
 *
 * The budget is *total*, not per hunk, because a per-hunk ceiling is not a
 * bound: a diff with a thousand hunk headers each declaring a billion lines
 * multiplies the allocation instead of capping it. Only the fallback consumes
 * budget — walked lines are already bounded by the size of the diff text, so
 * counting them again would penalise legitimate large diffs for something they
 * cannot inflate.
 *
 * 1e6 keeps the largest hunk the existing suites exercise (200k) working while
 * turning a declared 1e9 from a `RangeError: Set maximum size exceeded` into a
 * bounded ~1e6-entry set.
 */
export const MAX_FALLBACK_MAPPED_LINES = 1_000_000;

/**
 * Parse a unified diff into the set of mappable `file:line` positions on the
 * new side. Hunk bodies are walked line by line so only lines that actually
 * exist on the new side are reported.
 *
 * Fail-open fallback: when a hunk body yields fewer new-side lines than the
 * hunk header declares (truncated diff, missing body in fixtures), the
 * header-declared range is unioned in so valid positions are never dropped —
 * the safe direction is allowing an extra comment (recovered downstream)
 * rather than silently discarding a valid finding. That range is bounded by
 * the fallback budget and by the number of lines actually present,
 * because the declared count is PR-author-controlled text.
 *
 * @param diffText - Raw unified diff text.
 * @returns Set of `file:line` strings for new-side lines in the diff.
 */
export function parseDiffHunkLines(diffText: string): Set<string> {
  const lines = new Set<string>();
  // Remaining allowance for declared-range positions invented below.
  let fallbackBudget = MAX_FALLBACK_MAPPED_LINES;
  let currentFile = '';
  const linesArray = diffText.split('\n');
  const hunkRegex = /^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/;
  let hunkActive = false;
  let hunkStart = 0;
  let hunkCount = 0;
  let hunkWalked = 0;
  let newLine = 0;

  const flushHunk = (): void => {
    if (hunkActive && currentFile && hunkCount > 0 && hunkWalked < hunkCount) {
      // `hunkCount` comes from the diff header, which is PR-author-controlled
      // text. Unbounded, a single `@@ -1,1 +1,1000000000 @@` header with a
      // one-line body makes this loop allocate a billion Set entries and die
      // with `RangeError: Set maximum size exceeded`. Bound it by both an
      // explicit ceiling and the number of lines the diff actually contains
      // (the fallback exists to recover positions the body walk missed, so it
      // can never legitimately need more entries than there are lines).
      const span = Math.min(hunkCount, fallbackBudget);
      fallbackBudget -= span;
      for (let i = 0; i < span; i++) {
        lines.add(`${currentFile}:${hunkStart + i}`);
      }
    }
    hunkActive = false;
    hunkWalked = 0;
    hunkCount = 0;
  };

  for (const line of linesArray) {
    if (line.startsWith('\\')) continue;
    if (line.startsWith('Binary')) continue;

    if (line.startsWith('+++ b/')) {
      flushHunk();
      currentFile = line.substring(6).trim();
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      flushHunk();
      currentFile = '';
      continue;
    }
    if (line.startsWith('diff --git') || line.startsWith('--- ')) {
      flushHunk();
      continue;
    }
    const match = hunkRegex.exec(line);
    if (match && currentFile) {
      flushHunk();
      hunkActive = true;
      hunkStart = Number.parseInt(match[1], 10);
      hunkCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
      hunkWalked = 0;
      newLine = hunkStart;
      continue;
    }
    if (match) {
      flushHunk();
      continue;
    }
    if (!hunkActive || !currentFile) continue;
    if (line.startsWith('+')) {
      lines.add(`${currentFile}:${newLine}`);
      newLine++;
      hunkWalked++;
    } else if (line.startsWith(' ')) {
      lines.add(`${currentFile}:${newLine}`);
      newLine++;
      hunkWalked++;
    } else if (line.startsWith('-')) {
      // Deletion: consumes no new-side line.
    } else if (line === '') {
      // Blank diff line: unified diffs render an empty file line as a bare
      // empty line (context). Consume one new-side line while the hunk still
      // expects lines; the trailing split artifact past the last hunk has
      // hunkWalked >= hunkCount (or no active hunk) and is ignored.
      if (hunkWalked < hunkCount) {
        lines.add(`${currentFile}:${newLine}`);
        newLine++;
        hunkWalked++;
      }
    } else {
      // Unknown directive ends the hunk body (fail-open: header fallback applies).
      flushHunk();
    }
  }
  flushHunk();
  return lines;
}
