/**
 * Single owner for "linked PR" marker scans.
 *
 * `app/` previously triplicated this scan (`findExistingAutofixPR`,
 * `findExistingDocsPR`, `findExistingChangelogPR`) with two different regex
 * shapes (`/pull/(\d+)` vs full `github.com/.../pull/(\d+)` vs `PR #(\d+)`).
 * A marker-format change needed 3 edits and one stale copy would reuse the
 * wrong PR. These pure helpers parameterise the scan by marker so one edit
 * covers every call site.
 */

/** Minimal comment shape needed for marker scans. */
export interface LinkedPRComment {
  body?: string | null;
}

/** Minimal issue shape needed for marker scans. */
export interface LinkedPRIssue {
  body?: string | null;
  comments: LinkedPRComment[];
}

/**
 * Extract a PR number from free text. Accepts (in order):
 * `https://github.com/<owner>/<repo>/pull/<n>`, `/pull/<n>`, `PR #<n>`.
 *
 * @param text - Text to scan.
 * @returns The PR number, or null when no pattern matches.
 */
export function extractPRNumberFromText(text: string): number | null {
  if (!text) return null;
  // NOTE: path segments exclude `/` (owner/repo names never contain one) so
  // the pattern is linear-time: a greedy segment can never swallow `/pull/`
  // and backtrack (js/polynomial-redos).
  const urlMatch = text.match(/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/(\d+)/);
  if (urlMatch?.[1]) return Number.parseInt(urlMatch[1], 10);
  const pullMatch = text.match(/\/pull\/(\d+)/);
  if (pullMatch?.[1]) return Number.parseInt(pullMatch[1], 10);
  const prMatch = text.match(/PR #(\d+)/);
  if (prMatch?.[1]) return Number.parseInt(prMatch[1], 10);
  return null;
}

/**
 * Scan an issue body + comments for an HTML marker comment and return the
 * linked PR number.
 *
 * @param issue - Issue with body and comments to scan.
 * @param marker - HTML marker prefix (e.g. `<!-- autofix-pr-link -->`).
 * @returns The linked PR number, or null when absent/unparseable.
 */
export function findLinkedPRNumberByMarker(issue: LinkedPRIssue, marker: string): number | null {
  const fromBody = issue.body ? extractPRNumberFromText(issue.body) : null;
  // Only honour a bare `PR #n` in the issue body when the marker is present;
  // comment scans below always require the marker prefix.
  if (fromBody !== null && issue.body?.includes(marker)) return fromBody;
  for (const comment of issue.comments ?? []) {
    if (!comment.body?.startsWith(marker)) continue;
    const n = extractPRNumberFromText(comment.body);
    if (n !== null) return n;
  }
  // Fall back to a body-level scan for callers (autofix) that historically
  // accepted `PR #n` in the issue body without a marker prefix.
  if (fromBody !== null) return fromBody;
  return null;
}

/**
 * Scan comments for a marker and return the linked PR number + URL.
 *
 * @param comments - Comment list to scan.
 * @param marker - HTML marker prefix (e.g. `<!-- docs-pr-link -->`).
 * @returns The linked PR number/URL, or null.
 */
export function findLinkedPRByMarker(
  comments: LinkedPRComment[],
  marker: string,
): { number: number; url: string } | null {
  for (const comment of comments ?? []) {
    if (!comment.body?.startsWith(marker)) continue;
    const urlMatch =
      comment.body.match(/(https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/(\d+))/) ??
      comment.body.match(/(\/pull\/(\d+))/);
    if (urlMatch) {
      return {
        number: Number.parseInt(urlMatch[urlMatch.length - 1] as string, 10),
        url: urlMatch[1] as string,
      };
    }
    const n = extractPRNumberFromText(comment.body);
    if (n !== null) return { number: n, url: '' };
  }
  return null;
}
