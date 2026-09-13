import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as core from '@actions/core';
import type { ReviewIssue } from '../types/index.js';

/**
 * Minimal shape of a previously posted bot inline thread used for
 * cross-run fingerprint deduplication. Compatible with both
 * `action/src/review.ts` previousComments and `ReviewThreadInfo`.
 */
export interface KnownInlineThread {
  file: string;
  line: number | null;
  body: string;
}

/** Minimal shape of an inline comment candidate. */
export interface InlineCommentCandidate {
  path: string;
  line: number;
  body: string;
}

/**
 * Normalize a file path for fingerprinting (strip leading slash, lowercase).
 * @param path - Raw file path.
 * @returns Normalized path.
 * @since NEXT
 */
export function normalizeFingerprintPath(path: string): string {
  return path.replace(/^\//, '').toLowerCase();
}

/**
 * Normalize free-form text for fingerprinting (lowercase, collapse whitespace).
 * @param value - Raw text.
 * @returns Normalized text.
 * @since NEXT
 */
export function normalizeFingerprintText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Hash the snippet portion (message + suggestion + code + category) of a finding.
 * @param message - Finding message.
 * @param suggestion - Optional suggestion text.
 * @param suggestionCode - Optional raw suggestion code.
 * @param category - Optional finding category/rule.
 * @returns 16-char hex hash.
 * @since NEXT
 */
export function snippetHashFor(
  message: string,
  suggestion?: string,
  suggestionCode?: string,
  category?: string,
): string {
  const normalized = [
    normalizeFingerprintText(message ?? ''),
    normalizeFingerprintText(suggestion ?? ''),
    normalizeFingerprintText(suggestionCode ?? ''),
    normalizeFingerprintText(category ?? ''),
  ].join('|');
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Compute a stable 16-char fingerprint for a finding.
 * @param path - File path.
 * @param line - 1-based line number.
 * @param rule - Rule/category string (may be empty).
 * @param snippetHash - Hash from {@link snippetHashFor} (may be empty).
 * @returns 16-char hex fingerprint.
 * @since NEXT
 */
export function fingerprintFinding(
  path: string,
  line: number,
  rule: string,
  snippetHash: string,
): string {
  const safeLine = Number.isInteger(line) ? line : 0;
  const key = [
    normalizeFingerprintPath(path ?? ''),
    String(safeLine),
    normalizeFingerprintText(rule ?? ''),
    normalizeFingerprintText(snippetHash ?? ''),
  ].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * Compute the fingerprint for a review issue.
 * @param issue - Review issue.
 * @returns 16-char hex fingerprint.
 * @since NEXT
 */
export function fingerprintForIssue(issue: ReviewIssue): string {
  return fingerprintFinding(
    issue.file,
    issue.line,
    issue.category ?? '',
    snippetHashFor(issue.message, issue.suggestion, issue.suggestionCode, issue.category),
  );
}

/**
 * Compute the fingerprint for a rendered inline comment candidate.
 * Identical findings render identical bodies, so body equality is the
 * strongest duplicate signal at post time.
 * @param comment - Inline comment candidate.
 * @returns 16-char hex fingerprint.
 * @since NEXT
 */
export function fingerprintForInlineComment(comment: InlineCommentCandidate): string {
  const key = [
    normalizeFingerprintPath(comment.path),
    String(Number.isInteger(comment.line) ? comment.line : 0),
    normalizeFingerprintText(comment.body),
  ].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * Check whether an issue duplicates a previously posted bot thread.
 * Duplicate = same normalized path + same line AND the normalized thread
 * body contains the normalized issue message (or vice versa for
 * cross-template streaming bodies). Fail-open: missing data returns false.
 * @param issue - Candidate issue.
 * @param threads - Previously posted bot threads.
 * @returns True when the issue was already posted.
 * @since NEXT
 */
export function isDuplicateOfThreads(
  issue: Pick<ReviewIssue, 'file' | 'line' | 'message'>,
  threads: KnownInlineThread[] | undefined,
): boolean {
  try {
    if (!threads || threads.length === 0) return false;
    if (!issue.file || !Number.isInteger(issue.line) || issue.line < 1) return false;
    const path = normalizeFingerprintPath(issue.file);
    const message = normalizeFingerprintText(issue.message ?? '');
    if (!message) return false;
    for (const t of threads) {
      try {
        if (t.line === null || t.line === undefined) continue;
        if (normalizeFingerprintPath(t.file ?? '') !== path) continue;
        if (t.line !== issue.line) continue;
        const body = normalizeFingerprintText(t.body ?? '');
        if (!body) continue;
        if (body.includes(message) || message.includes(body)) return true;
        // Short-message guard: when the message is long enough, a strong
        // substring overlap (first 120 chars) still counts as a duplicate so
        // template differences (streaming vs batched bodies) do not re-post.
        if (message.length >= 120 && body.includes(message.slice(0, 120))) return true;
      } catch {
        // fail-open: ignore malformed thread entries
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Filter rendered inline comments against previously posted bot threads.
 * Duplicate = identical fingerprint (same anchor + same normalized body).
 * Fail-open: unreadable inputs return all comments unfiltered.
 * @param comments - Candidate inline comments.
 * @param threads - Previously posted bot threads.
 * @returns Kept comments and skipped count.
 * @since NEXT
 */
export function filterDuplicateInlineComments<T extends InlineCommentCandidate>(
  comments: T[],
  threads: KnownInlineThread[] | undefined,
): { kept: T[]; skipped: number } {
  try {
    if (!threads || threads.length === 0) return { kept: comments, skipped: 0 };
    const known = new Set<string>();
    for (const t of threads) {
      try {
        if (t.line === null || t.line === undefined) continue;
        known.add(
          fingerprintForInlineComment({ path: t.file ?? '', line: t.line, body: t.body ?? '' }),
        );
      } catch {
        // fail-open: ignore malformed thread entries
      }
    }
    const kept: T[] = [];
    let skipped = 0;
    for (const c of comments) {
      try {
        if (known.has(fingerprintForInlineComment(c))) {
          skipped++;
          try {
            core.debug(`Skipping duplicate inline finding ${c.path}:${c.line} (fingerprint match)`);
          } catch {
            // logging must never break posting
          }
          continue;
        }
      } catch {
        // fail-open: keep the comment
      }
      kept.push(c);
    }
    return { kept, skipped };
  } catch {
    return { kept: comments, skipped: 0 };
  }
}

/**
 * Decide whether a fingerprint should be posted.
 * @param fingerprint - 16-char fingerprint.
 * @param known - Set of already-posted fingerprints.
 * @param enabled - When false, always post (gate disabled).
 * @returns True when the finding should be posted.
 * @since NEXT
 */
export function shouldPostFingerprint(
  fingerprint: string,
  known: Set<string> | undefined,
  enabled = true,
): boolean {
  if (!enabled) return true;
  try {
    if (!known || known.size === 0) return true;
    if (!fingerprint) return true;
    return !known.has(fingerprint);
  } catch {
    return true;
  }
}

/**
 * Persistent JSON fingerprint store. Fail-open by design: an unreadable or
 * corrupt file behaves as an empty store (post as today) and warns once.
 * @since NEXT
 */
export class InlineFingerprintStore {
  private fingerprints = new Set<string>();
  private warned = false;

  /**
   * @param filePath - Optional JSON file path. When omitted the store is
   * memory-only (still useful for in-run dedup).
   */
  constructor(private readonly filePath?: string) {}

  /** Load fingerprints from disk (fail-open on missing/corrupt files). */
  load(): Set<string> {
    if (!this.filePath) return this.fingerprints;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { fingerprints?: unknown }).fingerprints)
          ? ((parsed as { fingerprints: unknown }).fingerprints as unknown[])
          : null;
      if (!list) throw new Error('unexpected fingerprint store shape');
      for (const fp of list) {
        if (typeof fp === 'string' && fp) this.fingerprints.add(fp);
      }
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        try {
          core.warning(
            `Inline fingerprint store unreadable (${this.filePath}) — posting all findings: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch {
          // ignore logging failures
        }
      }
    }
    return this.fingerprints;
  }

  /** Check whether a fingerprint was already posted. */
  has(fingerprint: string): boolean {
    try {
      return this.fingerprints.has(fingerprint);
    } catch {
      return false;
    }
  }

  /** Record a fingerprint as posted. */
  add(fingerprint: string): void {
    try {
      if (fingerprint) this.fingerprints.add(fingerprint);
    } catch {
      // ignore
    }
  }

  /** Persist fingerprints to disk (fail-open, warns once). */
  save(): void {
    if (!this.filePath) return;
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify({ fingerprints: [...this.fingerprints] }),
        'utf8',
      );
    } catch (err) {
      try {
        core.warning(
          `Inline fingerprint store unwritable (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // ignore
      }
    }
  }

  /** Current size (mainly for tests/observability). */
  get size(): number {
    return this.fingerprints.size;
  }
}
