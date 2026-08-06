// SCA orchestrator: turns changed lock files into blocking review issues.
//
// Flow: filter changed files down to supported lock files → parse added/updated
// dependencies → query the OSV advisory database → project each known
// vulnerability into a `ReviewIssue`. The whole pass is best-effort: any
// failure (advisory API unreachable, parse errors) logs a warning and returns
// no findings so a network outage can never crash or block a review.

import type { ChangedFile, ReviewIssue, SCAVulnerability } from '../types/index.js';
import { DEFAULT_SCA_SCAN_DEADLINE_MS } from '../types/index.js';
import { severityRank } from '../utils/filter-findings.js';
import type { Logger } from '../utils/logger.js';
import { extractChangedDependencies } from './lockfile.js';
import { isAbortError, queryOSVWithStatus } from './osv-client.js';
import type { SCAScanOptions } from './types.js';

/**
 * Escape markdown-significant characters (mirroring the engine's helper) so
 * OSV-provided advisory summaries and dependency names cannot inject markup
 * into the rendered review comment.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]|<>]/g, (m) => `\\${m}`);
}

/**
 * Replace control characters with spaces (a summary containing raw ESC/NUL can
 * corrupt a rendered comment or log line). C0 controls and DEL are mapped.
 */
function stripControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += code !== undefined && (code < 0x20 || code === 0x7f) ? ' ' : ch;
  }
  return out;
}

/**
 * Map a single SCA vulnerability to a blocking inline review issue. The message
 * surfaces the CVE id, the affected dependency@version, the advisory summary,
 * the CVSS score, the first advisory reference URL (when known), and the fixed
 * version when known; the suggestion recommends the upgrade. OSV-supplied text
 * (summary, dependency name) is markdown-escaped before interpolation so a
 * crafted advisory cannot inject formatting into the posted review.
 *
 * @param vuln - A known vulnerability for a changed dependency.
 * @returns A review issue ready to merge into a ReviewResult.
 */
export function scaVulnerabilityToIssue(vuln: SCAVulnerability): ReviewIssue {
  const { dependency, cveIds, id, summary, cvssScore, fixedVersion } = vuln;
  const identifier = escapeMarkdown(cveIds[0] ?? id);
  const name = escapeMarkdown(dependency.name);
  const cvss = cvssScore !== undefined ? ` CVSS: ${cvssScore}.` : '';
  const fixed = fixedVersion ? ` Fixed version: ${fixedVersion}.` : '';
  const reference = vuln.references[0] ? ` Reference: ${escapeMarkdown(vuln.references[0])}.` : '';
  const summaryText = summary
    ? ` ${escapeMarkdown(stripControlChars(summary).trim()).slice(0, 512)}`
    : '';
  return {
    type: 'issue',
    severity: vuln.severity,
    file: dependency.file,
    line: dependency.line,
    message: `Known vulnerability ${identifier} affects ${name}@${dependency.version}.${summaryText}${cvss}${fixed}${reference}`,
    suggestion: fixedVersion
      ? `Upgrade ${name} to ${fixedVersion} or a patched release.`
      : `Upgrade ${name} to a patched release or remove the dependency.`,
    inline: true,
    confidence: 'high',
    category: 'security',
  };
}

/**
 * Run the deterministic Software Composition Analysis (SCA) pass over a PR's
 * changed files. Only files matching the configured lock file patterns are
 * scanned; findings at or above `minSeverity` are returned as inline security
 * review issues.
 *
 * This scan deliberately reads the **unfiltered** changed-file list: lock files
 * are excluded from LLM review by default (`review.excludePatterns`), so
 * dependency changes would otherwise never surface.
 *
 * Best-effort: any failure is logged and degrades to `[]`. Returns `[]`
 * immediately when `options.enabled` is false.
 *
 * @param changedFiles - All changed files for the PR (before review excludes).
 * @param workDir - Working directory the files are checked out under.
 * @param options - SCA scan options (patterns, severity floor, tunables).
 * @param logger - Logger for warnings.
 * @returns Review issues for known vulnerable dependencies (empty when none).
 */
export async function runSCAScan(
  changedFiles: ChangedFile[],
  workDir: string,
  options: SCAScanOptions,
  logger: Logger,
): Promise<ReviewIssue[]> {
  if (!options.enabled) return [];
  // Wall-clock scan deadline: a slow or unreachable OSV API aborts the scan
  // instead of blocking the review pipeline on the critical path. Bounded by
  // default so every caller (engine, app, library consumers) behaves
  // consistently; an explicit `deadlineMs: 0` opts out of the bound.
  const deadlineMs = options.deadlineMs ?? DEFAULT_SCA_SCAN_DEADLINE_MS;
  const controller = deadlineMs > 0 ? new AbortController() : undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (controller) {
    deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);
    deadlineTimer.unref?.();
  }
  try {
    const dependencies = await extractChangedDependencies(changedFiles, workDir, {
      lockFilePatterns: options.lockFilePatterns,
      excludePatterns: options.excludePatterns,
      includeUnchanged: options.includeUnchanged,
    });
    if (dependencies.length === 0) return [];

    const { vulnerabilities, aborted } = await queryOSVWithStatus(dependencies, {
      maxBatchQueries: options.maxBatchQueries,
      concurrency: options.concurrency,
      fetchImpl: options.fetchImpl,
      signal: controller?.signal,
      osvBaseUrl: options.osvBaseUrl,
    });

    const minRank = severityRank(options.minSeverity);
    const seen = new Set<string>();
    const issues: ReviewIssue[] = [];
    for (const vuln of vulnerabilities) {
      if (severityRank(vuln.severity) < minRank) continue;
      const { dependency } = vuln;
      const key = `${dependency.file}\u0000${dependency.name}\u0000${dependency.version}\u0000${vuln.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(scaVulnerabilityToIssue(vuln));
    }
    if (aborted) {
      // Preserve whatever was already resolved instead of discarding the whole
      // run: a deadline mid-scan degrades to partial findings, not zero.
      logger.warn(
        `SCA scan hit its ${deadlineMs}ms deadline — returning ${issues.length} partial finding(s)`,
      );
    }
    return issues;
  } catch (err) {
    if (isAbortError(err)) {
      logger.warn(`SCA scan aborted after ${deadlineMs}ms deadline — returning no findings`);
    } else {
      logger.warn(`SCA scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}
