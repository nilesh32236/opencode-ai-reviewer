import { type Severity, type SeverityStats, shouldFailOnSeverity } from '@opencode-pr-agent/lib';

/** Canonical `--gate` severity tiers, ordered from lowest to highest. */
export const GATE_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

/** Backward-compatible aliases for the native review severities. */
const GATE_ALIASES = ['minor', 'important'] as const;

/** A value accepted by `--gate` (canonical tier or native severity alias). */
export type GateSeverity = (typeof GATE_SEVERITIES)[number] | (typeof GATE_ALIASES)[number];

/** Map a gate tier to the existing three-level review severity. */
const GATE_TO_SEVERITY: Record<GateSeverity, Severity> = {
  info: 'minor',
  low: 'minor',
  minor: 'minor',
  medium: 'important',
  important: 'important',
  high: 'critical',
  critical: 'critical',
};

/** Map an existing review severity back to its user-facing gate label. */
const SEVERITY_TO_GATE_LABEL: Record<Severity, string> = {
  minor: 'low',
  important: 'medium',
  critical: 'high',
};

/** Minimal result shape needed to evaluate a gate (accepts malformed runtime data). */
export interface GateResultInput {
  stats?: {
    critical?: unknown;
    important?: unknown;
    minor?: unknown;
  } | null;
  issues?: ReadonlyArray<{ severity?: unknown }> | null;
}

/** Outcome of evaluating a review result against a gate threshold. */
export interface GateEvaluation {
  /** True when no finding meets or exceeds the threshold. */
  passed: boolean;
  /** Highest severity present, or undefined when there are no findings. */
  maxSeverity?: Severity;
  /** True when severity data is missing or malformed. */
  inconclusive: boolean;
}

/**
 * Normalize and validate a `--gate` value.
 * @param value - Raw argument value (case-insensitive, surrounding whitespace ignored).
 * @returns The recognized gate severity, or undefined when invalid.
 */
export function parseGateSeverity(value: string): GateSeverity | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    (GATE_SEVERITIES as readonly string[]).includes(normalized) ||
    (GATE_ALIASES as readonly string[]).includes(normalized)
  ) {
    return normalized as GateSeverity;
  }
  return undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readStats(stats: GateResultInput['stats']): SeverityStats | undefined {
  if (!stats || typeof stats !== 'object') return undefined;
  const { critical, important, minor } = stats;
  if (!isCount(critical) || !isCount(important) || !isCount(minor)) return undefined;
  return { critical, important, minor };
}

function statsFromIssues(issues: GateResultInput['issues']): SeverityStats | undefined {
  if (!Array.isArray(issues)) return undefined;
  const stats: SeverityStats = { critical: 0, important: 0, minor: 0 };
  for (const issue of issues as ReadonlyArray<{ severity?: unknown }>) {
    const severity: unknown = issue?.severity;
    if (severity === 'critical') stats.critical += 1;
    else if (severity === 'important') stats.important += 1;
    else if (severity === 'minor') stats.minor += 1;
    else return undefined;
  }
  return stats;
}

function resolveStats(result: GateResultInput): SeverityStats | undefined {
  return readStats(result.stats) ?? statsFromIssues(result.issues);
}

function maxFromStats(stats: SeverityStats): Severity | undefined {
  if (stats.critical > 0) return 'critical';
  if (stats.important > 0) return 'important';
  if (stats.minor > 0) return 'minor';
  return undefined;
}

/**
 * Compute the highest severity across a review result.
 *
 * Prefers the precomputed `stats` counts and falls back to deriving them from
 * `issues` when the stats are missing or non-numeric.
 * @param result - Review result (or a structurally compatible slice).
 * @returns The highest severity, or undefined when there are no findings or the data is malformed.
 */
export function computeMaxSeverity(result: GateResultInput): Severity | undefined {
  const stats = resolveStats(result);
  return stats ? maxFromStats(stats) : undefined;
}

/**
 * Evaluate a review result against a `--gate` threshold.
 * @param result - Review result (or a structurally compatible slice).
 * @param gate - Validated gate severity.
 * @returns Whether the gate passed, the highest severity, and whether data was inconclusive.
 */
export function evaluateGate(result: GateResultInput, gate: GateSeverity): GateEvaluation {
  const stats = resolveStats(result);
  if (!stats) {
    return { passed: false, inconclusive: true };
  }
  const maxSeverity = maxFromStats(stats);
  return {
    passed: !shouldFailOnSeverity(stats, GATE_TO_SEVERITY[gate]),
    maxSeverity,
    inconclusive: false,
  };
}

/**
 * Format the one-line gate summary written to stderr.
 * @param gate - Validated gate severity.
 * @param maxSeverity - Highest severity found, if any.
 * @param passed - Whether the gate passed.
 * @returns A line such as `gate=high max=medium result=pass`.
 */
export function formatGateSummary(
  gate: GateSeverity,
  maxSeverity: Severity | undefined,
  passed: boolean,
): string {
  const max = maxSeverity ? SEVERITY_TO_GATE_LABEL[maxSeverity] : 'none';
  return `gate=${gate} max=${max} result=${passed ? 'pass' : 'fail'}`;
}
