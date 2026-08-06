// SCA orchestrator: turns changed lock files into blocking review issues.
//
// Flow: filter changed files down to supported lock files → parse added/updated
// dependencies → query the OSV advisory database → project each known
// vulnerability into a `ReviewIssue`. The whole pass is best-effort: any
// failure (advisory API unreachable, parse errors) logs a warning and returns
// no findings so a network outage can never crash or block a review.

import type { ChangedFile, ReviewIssue, SCAVulnerability } from '../types/index.js';
import { severityRank } from '../utils/filter-findings.js';
import type { Logger } from '../utils/logger.js';
import { extractChangedDependencies } from './lockfile.js';
import { queryOSV } from './osv-client.js';
import type { SCAScanOptions } from './types.js';

/**
 * Map a single SCA vulnerability to a blocking inline review issue. The message
 * surfaces the CVE id, the affected dependency@version, the advisory summary,
 * and the fixed version when known; the suggestion recommends the upgrade.
 *
 * @param vuln - A known vulnerability for a changed dependency.
 * @returns A review issue ready to merge into a ReviewResult.
 */
export function scaVulnerabilityToIssue(vuln: SCAVulnerability): ReviewIssue {
  const { dependency, cveIds, id, summary, cvssScore, fixedVersion } = vuln;
  const identifier = cveIds[0] ?? id;
  const cvss = cvssScore !== undefined ? ` CVSS: ${cvssScore}.` : '';
  const fixed = fixedVersion ? ` Fixed version: ${fixedVersion}.` : '';
  const summaryText = summary ? ` ${summary}` : '';
  return {
    type: 'issue',
    severity: vuln.severity,
    file: dependency.file,
    line: dependency.line,
    message: `Known vulnerability ${identifier} affects ${dependency.name}@${dependency.version}.${summaryText}${cvss}${fixed}`,
    suggestion: fixedVersion
      ? `Upgrade ${dependency.name} to ${fixedVersion} or a patched release.`
      : `Upgrade ${dependency.name} to a patched release or remove the dependency.`,
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
  try {
    const dependencies = await extractChangedDependencies(changedFiles, workDir, {
      lockFilePatterns: options.lockFilePatterns,
      excludePatterns: options.excludePatterns,
    });
    if (dependencies.length === 0) return [];

    const vulnerabilities = await queryOSV(dependencies, {
      maxBatchQueries: options.maxBatchQueries,
      concurrency: options.concurrency,
      fetchImpl: options.fetchImpl,
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
    return issues;
  } catch (err) {
    logger.warn(`SCA scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
