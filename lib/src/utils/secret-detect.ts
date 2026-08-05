import { createHash } from 'node:crypto';

/**
 * A single detected secret or credential in reviewed input text.
 * Values are always redacted so consumers never surface the raw secret.
 */
export interface SecretFinding {
  /** Machine-readable category of the detected secret (e.g. `github-pat`). */
  type: string;
  /** 1-based line number where the match starts. */
  line: number;
  /** 0-based column offset within the line where the match starts. */
  column: number;
  /** Redacted representation of the secret, safe to display in comments. */
  redactedValue: string;
  /** Severity of the finding; secrets are always critical. */
  severity: 'critical';
  /** Stable SHA-256 derived identifier for grouping and deduplication. */
  fingerprint: string;
}

/**
 * Configuration for secret detection.
 */
export interface SecretDetectOptions {
  /**
   * Values (raw tokens or redacted forms) that should never be flagged.
   * Suppresses false positives for deliberate, known-safe strings.
   */
  allowlist?: string[];
  /**
   * Minimum base-2 Shannon entropy required before a high-entropy token
   * is flagged. Defaults to `4.5`.
   */
  minEntropy?: number;
  /**
   * Minimum length of a token considered for high-entropy detection.
   * Defaults to `32`.
   */
  minLength?: number;
}

const SECRET_PATTERNS: { name: string; pattern: RegExp; type: string }[] = [
  {
    name: 'AWS access key ID',
    pattern: /AKIA[0-9A-Z]{16}/,
    type: 'aws-access-key-id',
  },
  {
    name: 'AWS secret access key',
    pattern: /aws_secret_access_key\s*[:=]\s*["']([A-Za-z0-9/+=]{40})["']/,
    type: 'aws-secret-access-key',
  },
  {
    name: 'GitHub personal access token',
    pattern: /gh[psuor]_[A-Za-z0-9]{36,}/,
    type: 'github-pat',
  },
  {
    name: 'GitHub fine-grained personal access token',
    pattern: /github_pat_[A-Za-z0-9_]{22,}/,
    type: 'github-fine-grained-pat',
  },
  {
    name: 'OpenAI API key',
    pattern: /sk-[A-Za-z0-9]{20,}/,
    type: 'openai-api-key',
  },
  {
    name: 'Anthropic API key',
    pattern: /sk-ant-[A-Za-z0-9]{20,}/,
    type: 'anthropic-api-key',
  },
  {
    name: 'Slack token',
    pattern: /xox[bpars]-[A-Za-z0-9-]{10,}/,
    type: 'slack-token',
  },
  {
    name: 'Google API key',
    pattern: /AIza[0-9A-Za-z_\-]{35}/,
    type: 'google-api-key',
  },
  {
    name: 'Stripe live secret key',
    pattern: /sk_live_[A-Za-z0-9]{24,}/,
    type: 'stripe-live-secret-key',
  },
  {
    name: 'Stripe live publishable key',
    pattern: /pk_live_[A-Za-z0-9]{24,}/,
    type: 'stripe-live-publishable-key',
  },
  {
    name: 'Private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
    type: 'private-key',
  },
  {
    name: 'Connection string with password',
    pattern: /(?:postgres|mysql|mongodb|redis|amqp)s?:\/\/\S+:\S+@/,
    type: 'connection-string',
  },
];

const ELLIPSIS = '…';
const PRIVATE_KEY_REDACTION = '[REDACTED PRIVATE KEY]';
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/=]+/g;

/**
 * Compute the base-2 Shannon entropy of a string's characters.
 * Returns `0` for empty or single-character-distribution inputs.
 *
 * @param s - The string to measure.
 * @returns A value in the range `[0, log2(alphabetSize)]`.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const char of s) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / s.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function redactValue(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}${ELLIPSIS}${value.slice(-4)}`;
}

function computeFingerprint(type: string, redactedValue: string, line: number): string {
  return createHash('sha256').update(`${type}:${redactedValue}:${line}`).digest('hex').slice(0, 16);
}

/**
 * Scan text for hardcoded secrets, tokens, and credentials.
 *
 * Detects well-known key/token formats via regex patterns, plus generic
 * high-entropy strings that look like secrets. All returned values are
 * redacted and never expose the raw secret.
 *
 * @param text - The input text (e.g. a code file) to scan line by line.
 * @param options - Optional tuning (allowlist, entropy/length thresholds).
 * @returns An array of {@link SecretFinding} objects, empty when nothing matches.
 */
export function detectSecrets(text: string, options: SecretDetectOptions = {}): SecretFinding[] {
  const minLength = options.minLength ?? 32;
  const minEntropy = options.minEntropy ?? 4.5;
  const allowlist = options.allowlist ?? [];

  const findings: SecretFinding[] = [];
  const namedSpans: { line: number; start: number; end: number }[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    for (const pattern of SECRET_PATTERNS) {
      const regex = new RegExp(pattern.pattern.source, 'g');
      for (const match of line.matchAll(regex)) {
        const fullMatch = match[0];
        const rawValue = match[1] ?? fullMatch;
        const index = match.index ?? 0;
        const redactedValue =
          pattern.type === 'private-key' ? PRIVATE_KEY_REDACTION : redactValue(rawValue);
        findings.push({
          type: pattern.type,
          line: lineNumber,
          column: index,
          redactedValue,
          severity: 'critical',
          fingerprint: computeFingerprint(pattern.type, redactedValue, lineNumber),
        });
        namedSpans.push({ line: lineNumber, start: index, end: index + fullMatch.length });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    for (const match of line.matchAll(HIGH_ENTROPY_TOKEN)) {
      const token = match[0];
      if (token.length < minLength) continue;
      if (allowlist.includes(token)) continue;
      const index = match.index ?? 0;
      const overlapsNamed = namedSpans.some(
        (span) => span.line === lineNumber && index >= span.start && index < span.end,
      );
      if (overlapsNamed) continue;
      if (shannonEntropy(token) <= minEntropy) continue;
      const redactedValue = redactValue(token);
      findings.push({
        type: 'generic-high-entropy',
        line: lineNumber,
        column: index,
        redactedValue,
        severity: 'critical',
        fingerprint: computeFingerprint('generic-high-entropy', redactedValue, lineNumber),
      });
    }
  }

  return findings.filter((finding) => !allowlist.includes(finding.redactedValue));
}
