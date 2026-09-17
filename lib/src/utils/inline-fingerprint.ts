import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as core from '@actions/core';
import { Logger } from './logger.js';

/** HTML marker embedding a finding fingerprint in a posted comment body. */
export const INLINE_FINGERPRINT_MARKER_PREFIX = '<!-- inline-fp:';

/** Regex matching the embedded fingerprint marker (16-char legacy or 64-char full). */
export const INLINE_FINGERPRINT_PATTERN = /<!-- inline-fp:([0-9a-f]{16}(?:[0-9a-f]{48})?) -->/;

/** Valid fingerprint shape: 16-char short marker or 64-char full sha256 key. */
const FINGERPRINT_SHAPE = /^[0-9a-f]{16}([0-9a-f]{48})?$/;

/**
 * Normalize a file path for fingerprinting: strip leading slashes and
 * lowercase so `SRC/Foo.ts` and `src/foo.ts` share one fingerprint.
 * @param path - Raw file path from a finding.
 * @returns Normalized path.
 * @since NEXT
 */
export function normalizeFingerprintPath(path: string): string {
  return String(path ?? '')
    .replace(/^\/+/, '')
    .trim()
    .toLowerCase();
}

/**
 * Normalize free text for fingerprinting: lowercase, collapse whitespace,
 * trim. Mirrors the `streamedFindingKey` normalization in action/src/review.ts
 * so in-run and cross-run keys agree.
 * @param text - Raw message/suggestion text.
 * @returns Normalized text.
 * @since NEXT
 */
export function normalizeFingerprintText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the canonical fingerprint key: `normalizedPath|line|normalizedRule|
 * normalizedSnippet`. Shared by both the short marker and the full-range key
 * so identical findings hash identically and any change to path-adjacent
 * fields, line, rule, or snippet produces a new key.
 * @param path - Finding file path.
 * @param line - 1-based finding line.
 * @param rule - Rule id, category, or severity fallback.
 * @param snippet - Normalized message/suggestion text.
 * @returns Canonical key string.
 * @since NEXT
 */
export function buildFingerprintKey(
  path: string,
  line: number,
  rule: string,
  snippet: string,
): string {
  const safeLine = Number.isInteger(line) && line > 0 ? line : 0;
  return [
    normalizeFingerprintPath(path),
    String(safeLine),
    normalizeFingerprintText(rule),
    normalizeFingerprintText(snippet),
  ].join('|');
}

/**
 * Compute the full-range collision-resistant fingerprint for an inline
 * finding: full 64-char sha256 of the canonical key (<10ms per finding).
 * @param path - Finding file path.
 * @param line - 1-based finding line.
 * @param rule - Rule id, category, or severity fallback.
 * @param snippet - Normalized message/suggestion text.
 * @returns 64-char lowercase hex sha256 digest.
 * @since NEXT
 */
export function fingerprintFindingFull(
  path: string,
  line: number,
  rule: string,
  snippet: string,
): string {
  return createHash('sha256')
    .update(buildFingerprintKey(path, line, rule, snippet))
    .digest('hex');
}

/**
 * Compute a stable 16-char fingerprint for an inline finding. The fingerprint
 * covers path + line + rule/category + normalized snippet (message +
 * suggestion), so an identical finding on re-push hashes identically while a
 * changed line or snippet produces a new fingerprint. Implemented as the
 * 16-char prefix of the full sha256 key so short markers stay consistent
 * with full-range server-side comparison.
 * @param path - Finding file path.
 * @param line - 1-based finding line.
 * @param rule - Rule id, category, or severity fallback.
 * @param snippet - Normalized message/suggestion text.
 * @returns First 16 hex chars of the sha256 digest (<10ms per finding).
 * @since NEXT
 */
export function fingerprintFinding(
  path: string,
  line: number,
  rule: string,
  snippet: string,
): string {
  return fingerprintFindingFull(path, line, rule, snippet).slice(0, 16);
}

/** Minimal finding shape needed for fingerprinting (subset of ReviewIssue). */
export interface FingerprintableIssue {
  file: string;
  line: number;
  category?: string;
  severity?: string;
  message: string;
  suggestion?: string;
  suggestionCode?: string;
}

/**
 * Compute the full-range fingerprint for a review issue. Same rule/snippet
 * assembly as `fingerprintForIssue` but returns the 64-char sha256 key for
 * collision-resistant server-side comparison. New posts should stamp this
 * full key; short markers keep verifying via prefix fallback.
 * @param issue - Review finding.
 * @returns 64-char fingerprint.
 * @since NEXT
 */
export function fingerprintForIssueFull(issue: FingerprintableIssue): string {
  const rule = issue.category?.trim() || issue.severity?.trim() || 'finding';
  const snippet = [issue.message ?? '', issue.suggestion ?? '', issue.suggestionCode ?? '']
    .filter((s) => s.trim().length > 0)
    .join('\n');
  return fingerprintFindingFull(issue.file ?? '', issue.line ?? 0, rule, snippet);
}

/**
 * Compute the fingerprint for a review issue. The snippet joins message +
 * suggestion + suggestionCode (normalized), and the rule prefers `category`
 * with a severity fallback so findings without a structured category still
 * hash stably.
 * @param issue - Review finding.
 * @returns 16-char fingerprint (prefix of the full sha256 key).
 * @since NEXT
 */
export function fingerprintForIssue(issue: FingerprintableIssue): string {
  const rule = issue.category?.trim() || issue.severity?.trim() || 'finding';
  const snippet = [issue.message ?? '', issue.suggestion ?? '', issue.suggestionCode ?? '']
    .filter((s) => s.trim().length > 0)
    .join('\n');
  return fingerprintFinding(issue.file ?? '', issue.line ?? 0, rule, snippet);
}

/**
 * Extract an embedded fingerprint from a posted comment body.
 * @param body - Comment body text.
 * @returns The 16-char short or 64-char full fingerprint, or undefined when absent.
 * @since NEXT
 */
export function extractFingerprintFromBody(body: string): string | undefined {
  if (!body || typeof body !== 'string') return undefined;
  const match = INLINE_FINGERPRINT_PATTERN.exec(body);
  return match?.[1];
}

/**
 * Collect known fingerprints from previously posted bot comment bodies.
 * Fail-open: non-string/empty bodies are skipped, never throw.
 * @param bodies - Previously posted comment bodies.
 * @returns Set of known fingerprints.
 * @since NEXT
 */
export function collectFingerprintsFromBodies(bodies: Iterable<string>): Set<string> {
  const known = new Set<string>();
  try {
    for (const body of bodies) {
      const fp = extractFingerprintFromBody(body);
      if (fp) known.add(fp);
    }
  } catch {
    // Fail-open: return whatever was collected so far.
  }
  return known;
}

/**
 * Coarse legacy key for threads posted before the fingerprint marker existed:
 * `path:line:normalized-message-prefix`. Used only as a best-effort fallback
 * so old duplicates are still skipped when no marker is present.
 * @param file - Thread file path.
 * @param line - Thread line number (may be null).
 * @param body - Thread body text.
 * @returns Legacy key string.
 * @since NEXT
 */
export function legacyInlineKey(file: string, line: number | null, body: string): string {
  const snippet = normalizeFingerprintText(body).slice(0, 120);
  return `${normalizeFingerprintPath(file)}:${line ?? 0}:${snippet}`;
}

/**
 * Decide whether a fingerprint should be posted given the known set.
 * Missing/empty/malformed fingerprints always post (never drop new findings).
 * Full 64-char keys compare server-side; 16-char short markers match either
 * directly or as the prefix of a known full key (and vice versa) so mixed
 * old/new threads dedup with zero migration.
 * @param fingerprint - Finding fingerprint (16- or 64-char, may be undefined).
 * @param known - Previously posted fingerprints (mixed lengths).
 * @returns True when the finding should be posted.
 * @since NEXT
 */
export function shouldPostFingerprint(
  fingerprint: string | undefined,
  known: Set<string> | undefined,
): boolean {
  if (!fingerprint || !known || known.size === 0) return true;
  if (typeof fingerprint !== 'string' || !FINGERPRINT_SHAPE.test(fingerprint)) return true;
  if (known.has(fingerprint)) return false;
  try {
    if (fingerprint.length === 64) {
      // Full key: also honor a short marker posted for the same finding.
      if (known.has(fingerprint.slice(0, 16))) return false;
      return true;
    }
    // Short marker: also honor a full key whose prefix matches.
    for (const entry of known) {
      if (typeof entry === 'string' && entry.length === 64 && entry.startsWith(fingerprint)) {
        return false;
      }
    }
  } catch {
    // Fail-open: iteration errors never drop a finding.
    return true;
  }
  return true;
}

/**
 * Filter issues against previously posted fingerprints (fail-open).
 * Issues with identical fingerprints are skipped with a debug log; changed
 * line/snippet yields a new fingerprint and is kept. When `enabled` is false
 * or the known set is absent/empty, all issues are kept unchanged.
 * @param issues - Candidate inline issues.
 * @param known - Previously posted fingerprints.
 * @param options - Optional `{ enabled }` gate (default true, absent = true).
 * @param options.enabled - Master switch; false keeps everything (default true).
 * @param options.legacyKeys - Pre-fingerprint marker texts treated as already posted.
 * @returns `{ kept, skipped }` partition (new arrays, input untouched).
 * @since NEXT
 */
export function filterIssuesByFingerprints<T extends FingerprintableIssue>(
  issues: T[],
  known: Set<string> | undefined,
  options?: { enabled?: boolean; legacyKeys?: Set<string> },
): { kept: T[]; skipped: T[] } {
  const enabled = options?.enabled ?? true;
  if (!enabled || !known || known.size === 0) {
    // Legacy fallback: when no markers exist yet, there is nothing to skip.
    if (!enabled) return { kept: [...issues], skipped: [] };
    if (!known || known.size === 0) {
      if (!options?.legacyKeys || options.legacyKeys.size === 0) {
        return { kept: [...issues], skipped: [] };
      }
    }
  }
  const kept: T[] = [];
  const skipped: T[] = [];
  const logger = new Logger('inline-fingerprint');
  for (const issue of issues) {
    let full: string | undefined;
    let short: string | undefined;
    try {
      full = fingerprintForIssueFull(issue);
      short = full.slice(0, 16);
    } catch {
      kept.push(issue);
      continue;
    }
    // Compare full keys server-side; fall back to the 16-char short marker
    // so threads posted before the full key existed still dedup.
    const alreadyPosted =
      !shouldPostFingerprint(full, known) || !shouldPostFingerprint(short, known);
    if (alreadyPosted) {
      const fp = short ?? full;
      logger.debug(`Skipping duplicate inline finding (fp ${fp}) at ${issue.file}:${issue.line}`);
      try {
        core.debug(`Skipping duplicate inline finding (fp ${fp}) at ${issue.file}:${issue.line}`);
      } catch {
        // core.debug never throws in practice; guard for exotic runners.
      }
      skipped.push(issue);
      continue;
    }
    if (options?.legacyKeys && options.legacyKeys.size > 0) {
      const legacy = legacyInlineKey(
        issue.file,
        issue.line ?? null,
        `${issue.message ?? ''} ${issue.suggestion ?? ''}`,
      );
      // Legacy keys are coarse: only skip on an exact coarse match, which
      // implies the same file+line and a near-identical message prefix.
      let legacyHit = false;
      try {
        for (const knownLegacy of options.legacyKeys) {
          if (knownLegacy === legacy) {
            legacyHit = true;
            break;
          }
        }
      } catch {
        legacyHit = false;
      }
      if (legacyHit) {
        logger.debug(`Skipping legacy duplicate inline finding at ${issue.file}:${issue.line}`);
        skipped.push(issue);
        continue;
      }
    }
    kept.push(issue);
  }
  return { kept, skipped };
}

/**
 * Append the fingerprint marker to a comment body (idempotent — bodies that
 * already carry a marker are returned unchanged). Accepts 16-char short
 * markers (legacy threads) or 64-char full keys (new posts should pass the
 * full key); malformed fingerprints leave the body unchanged (fail-open).
 * @param body - Rendered comment body.
 * @param fingerprint - 16- or 64-char fingerprint.
 * @returns Body with an embedded `<!-- inline-fp:xxx -->` trailer.
 * @since NEXT
 */
export function withFingerprintMarker(body: string, fingerprint: string): string {
  if (!fingerprint || typeof fingerprint !== 'string' || !FINGERPRINT_SHAPE.test(fingerprint)) {
    return body;
  }
  if (extractFingerprintFromBody(body)) return body;
  return `${body}\n\n${INLINE_FINGERPRINT_MARKER_PREFIX}${fingerprint} -->`;
}

/**
 * Minimal previously-posted thread shape needed for update-in-place matching
 * (subset of the bot-thread projections built in action/src/review.ts and
 * app/src/handlers/pr-review.ts).
 * @since NEXT
 */
export interface FingerprintedThread {
  body: string;
  /** REST review-comment id (or GraphQL databaseId) of the thread root. */
  commentId: number;
}

/**
 * Coerce a fingerprint-to-commentId map option to a Map (fail-open: invalid
 * input yields an empty map so update-in-place becomes a no-op that posts as
 * today).
 * @param value - Map or record of fingerprint to comment id.
 * @returns A Map of fingerprint to positive comment id (possibly empty).
 * @since NEXT
 */
export function toFingerprintIdMap(
  value: Map<string, number> | Record<string, number> | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  try {
    if (value instanceof Map) {
      for (const [fp, id] of value) {
        if (typeof fp === 'string' && /^[0-9a-f]{16}$/.test(fp) && Number.isInteger(id) && id > 0) {
          out.set(fp, id);
        }
      }
      return out;
    }
    if (value && typeof value === 'object') {
      for (const [fp, id] of Object.entries(value)) {
        if (/^[0-9a-f]{16}$/.test(fp) && Number.isInteger(id) && (id as number) > 0) {
          out.set(fp, id as number);
        }
      }
    }
  } catch {
    // Fail-open: return whatever was collected so far.
  }
  return out;
}

/**
 * Build a fingerprint-to-commentId map from previously posted bot threads for
 * update-in-place matching. Threads without an embedded marker or with an
 * invalid id are skipped (fail-open, never throw).
 * @param threads - Previously posted bot threads.
 * @returns Map of fingerprint to thread-root comment id.
 * @since NEXT
 */
export function mapFingerprintsToCommentIds(
  threads: Iterable<FingerprintedThread>,
): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const thread of threads) {
      const id = (thread as FingerprintedThread)?.commentId;
      if (!Number.isInteger(id) || (id as number) <= 0) continue;
      const fp = extractFingerprintFromBody((thread as FingerprintedThread)?.body ?? '');
      if (fp && !out.has(fp)) out.set(fp, id as number);
    }
  } catch {
    // Fail-open: return whatever was collected so far.
  }
  return out;
}

/**
 * Persistent JSON fingerprint store for cross-run dedup (CLI/local use).
 * GitHub-thread markers are the primary cross-push store on hosted runners;
 * this file store covers local/CLI flows where thread history is unavailable.
 * Every method is fail-open: unreadable/corrupt stores warn and allow posting.
 * @since NEXT
 */
export class FingerprintStore {
  private readonly filePath: string;
  private readonly logger = new Logger('inline-fingerprint');
  private known: Set<string> | undefined;
  private corrupt = false;

  /**
   * @param filePath - JSON file path holding the fingerprint array.
   */
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load known fingerprints (lazy, cached). Unreadable/corrupt files warn and
   * resolve to an empty set so all findings post as today.
   * @returns Known fingerprints (empty on any failure).
   */
  load(): Set<string> {
    if (this.known !== undefined) return this.known;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { fingerprints?: unknown })?.fingerprints;
      if (!Array.isArray(list)) throw new Error('unexpected fingerprint store shape');
      const fps = new Set<string>();
      for (const entry of list) {
        if (typeof entry === 'string' && FINGERPRINT_SHAPE.test(entry)) fps.add(entry);
      }
      this.known = fps;
      return fps;
    } catch (err) {
      this.corrupt = true;
      this.known = new Set<string>();
      const message = `Fingerprint store unreadable (${this.filePath}) — posting all findings: ${err instanceof Error ? err.message : String(err)}`;
      try {
        core.warning(message);
      } catch {
        // Never let logging break the review.
      }
      this.logger.warn(message);
      return this.known;
    }
  }

  /**
   * Whether the store failed to load (corrupt/unreadable).
   * @returns True when the last load failed.
   */
  isCorrupt(): boolean {
    return this.corrupt;
  }

  /**
   * Check whether a fingerprint was already posted.
   * @param fingerprint - Finding fingerprint.
   * @returns True when the finding should be posted.
   */
  shouldPost(fingerprint: string | undefined): boolean {
    return shouldPostFingerprint(fingerprint, this.load());
  }

  /**
   * Record fingerprints as posted (best-effort persist, fail-open).
   * @param fingerprints - Fingerprints to record.
   */
  markPosted(fingerprints: Iterable<string>): void {
    const known = this.load();
    try {
      for (const fp of fingerprints) {
        if (typeof fp === 'string' && FINGERPRINT_SHAPE.test(fp)) known.add(fp);
      }
      fs.mkdirSync(this.filePath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify([...known].sort()), 'utf-8');
    } catch (err) {
      const message = `Failed to persist fingerprint store — continuing: ${err instanceof Error ? err.message : String(err)}`;
      try {
        core.warning(message);
      } catch {
        // ignore
      }
      this.logger.warn(message);
    }
  }
}
