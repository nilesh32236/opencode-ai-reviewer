import { createHash } from 'node:crypto';
import type { ReviewIssue } from '../types/index.js';

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
    name: 'Private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
    type: 'private-key',
  },
];

// Connection strings with embedded passwords. Captures the password portion
// between `://[user:]` and `@host` so the redactor can target just the
// secret instead of leaking up to 3 password characters from the tail of
// the surrounding match. Supports `+srv` schemes (e.g. mongodb+srv://) and
// empty-username forms (e.g. redis://:password-at-host; the separator must be
// written as `-at-` here so this doc comment never self-triggers the detector
// — a real empty-username URI uses `:password@host`). The password character
// class deliberately allows embedded colons so `user:part1:part2@` redacts the
// full password; capture group 1 is the password for `user:password@`, group 2
// for the empty-username `:password@` form, and a password-less `user@` match
// carries neither group.
const CONNECTION_STRING_PATTERN =
  /(?:postgres|mysql|mongodb|redis|amqp)(?:\+srv)?:\/\/(?:[^\s:@/]+:([^\s@/]+)@|:([^\s@/]+)@|[^\s:@/]+@)/;

// Pre-compiled global regexes used in the per-line scan, built once from
// SECRET_PATTERNS instead of constructing a new RegExp for each input line.
const GLOBAL_SECRET_PATTERNS: { type: string; regex: RegExp }[] = SECRET_PATTERNS.map((p) => ({
  type: p.type,
  regex: new RegExp(p.pattern.source, 'g'),
}));
const GLOBAL_CONNECTION_STRING_REGEX = new RegExp(CONNECTION_STRING_PATTERN.source, 'g');

const ELLIPSIS = '…';
const PRIVATE_KEY_REDACTION = '[REDACTED PRIVATE KEY]';
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/=]+/g;
const GLOBAL_HIGH_ENTROPY_REGEX = new RegExp(HIGH_ENTROPY_TOKEN.source, 'g');

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
 * A single allowlist entry compiled for matching. Regex entries (prefixed with
 * `/`) are matched against the token; everything else is a literal substring.
 */
type CompiledAllowlistEntry =
  | { kind: 'regex'; regex: RegExp }
  | { kind: 'substring'; value: string };

/**
 * Compile allowlist entries into matchers. Entries shaped `/pattern/flags` are
 * compiled as regular expressions; invalid regexes and every other entry are
 * treated as literal substrings so a typo can never throw or reject the config.
 *
 * @param allowlist - Raw allowlist entries from config or options.
 * @returns Compiled matcher entries.
 */
function compileAllowlist(allowlist: string[]): CompiledAllowlistEntry[] {
  return allowlist.map((entry) => {
    if (entry.length > 2 && entry.startsWith('/')) {
      const lastSlash = entry.lastIndexOf('/');
      if (lastSlash > 0) {
        const source = entry.slice(1, lastSlash);
        const flags = entry.slice(lastSlash + 1);
        try {
          return { kind: 'regex' as const, regex: new RegExp(source, flags) };
        } catch {
          // Invalid regex — fall back to a literal substring match.
        }
      }
    }
    return { kind: 'substring' as const, value: entry };
  });
}

/**
 * Decide whether a candidate token is suppressed by the allowlist. Matching is
 * exact-equality-and-substring (a raw token or its redacted form is suppressed
 * when it contains the entry), plus regex support via `/pattern/flags` entries.
 *
 * @param rawValue - The full raw token (never returned to callers).
 * @param redactedValue - The redacted representation used in public output.
 * @param allowlist - Raw allowlist entries.
 * @returns True when the token should be suppressed.
 */
function isAllowlisted(rawValue: string, redactedValue: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  return compileAllowlist(allowlist).some((entry) => {
    if (entry.kind === 'regex') {
      return entry.regex.test(rawValue) || entry.regex.test(redactedValue);
    }
    return rawValue.includes(entry.value) || redactedValue.includes(entry.value);
  });
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

  // Each candidate finding carries both the redacted and the raw value; the
  // raw value is discarded only at the final filter step so allowlist entries
  // supplied as either form (raw token or redacted) suppress any finding.
  const candidates: Array<SecretFinding & { rawValue: string }> = [];
  const namedSpans: { line: number; start: number; end: number }[] = [];
  const lines = text.split('\n');

  // Named-pattern scan (uses pre-compiled global regexes; lastIndex reset).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    for (const entry of GLOBAL_SECRET_PATTERNS) {
      entry.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = entry.regex.exec(line)) !== null) {
        const fullMatch = match[0];
        const rawValue = match[1] ?? fullMatch;
        const index = match.index ?? 0;
        const redactedValue =
          entry.type === 'private-key' ? PRIVATE_KEY_REDACTION : redactValue(rawValue);
        candidates.push({
          type: entry.type,
          line: lineNumber,
          column: index,
          redactedValue,
          severity: 'critical',
          fingerprint: computeFingerprint(entry.type, redactedValue, lineNumber),
          rawValue,
        });
        namedSpans.push({ line: lineNumber, start: index, end: index + fullMatch.length });
        if (fullMatch.length === 0) entry.regex.lastIndex++; // avoid infinite loop
      }
    }
  }

  // Connection-string scan with password-only redaction. The regex matches
  // the full scheme+user+password+`@`; we redact ONLY the password portion
  // so the surrounding match tail does not leak up to 3 secret characters as
  // it did when redacting the whole match. The password position is derived
  // from the captured password group (whose character class allows embedded
  // colons), never from searching for the final colon before `@`.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    GLOBAL_CONNECTION_STRING_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GLOBAL_CONNECTION_STRING_REGEX.exec(line)) !== null) {
      const fullMatch = match[0];
      const index = match.index ?? 0;
      const atIdx = fullMatch.lastIndexOf('@');
      const password = match[1] ?? match[2];
      let redactedValue: string;
      if (password !== undefined) {
        // password occupies the span ending at `@`; its length gives the
        // start offset so a password containing `:` is fully covered.
        const passwordStart = atIdx - password.length;
        const redactedPassword = redactValue(password);
        redactedValue = `${fullMatch.slice(0, passwordStart)}${redactedPassword}@`;
      } else {
        redactedValue = fullMatch;
      }
      candidates.push({
        type: 'connection-string',
        line: lineNumber,
        column: index,
        redactedValue,
        severity: 'critical',
        fingerprint: computeFingerprint('connection-string', redactedValue, lineNumber),
        rawValue: fullMatch,
      });
      namedSpans.push({ line: lineNumber, start: index, end: index + fullMatch.length });
      if (fullMatch.length === 0) GLOBAL_CONNECTION_STRING_REGEX.lastIndex++;
    }
  }

  // Generic high-entropy scan. Excludes spans already covered by named matches.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    GLOBAL_HIGH_ENTROPY_REGEX.lastIndex = 0;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = GLOBAL_HIGH_ENTROPY_REGEX.exec(line)) !== null) {
      const token = tokenMatch[0];
      if (token.length < minLength) continue;
      const index = tokenMatch.index ?? 0;
      const overlapsNamed = namedSpans.some(
        (span) => span.line === lineNumber && index >= span.start && index < span.end,
      );
      if (overlapsNamed) continue;
      if (shannonEntropy(token) <= minEntropy) continue;
      const redactedValue = redactValue(token);
      candidates.push({
        type: 'generic-high-entropy',
        line: lineNumber,
        column: index,
        redactedValue,
        severity: 'critical',
        fingerprint: computeFingerprint('generic-high-entropy', redactedValue, lineNumber),
        rawValue: token,
      });
    }
  }

  // Final allowlist filter: a finding is suppressed when either its raw token
  // or its redacted representation matches an allowlist entry (literal
  // substring or `/regex/`). This is the single suppression point for named
  // patterns, connection strings, and high-entropy candidates alike.
  const findings = candidates.filter((c) => !isAllowlisted(c.rawValue, c.redactedValue, allowlist));

  // Deterministic source-order output: by line, then column. Strip the raw
  // value before returning so caller never sees the plaintext secret.
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings.map(({ rawValue: _raw, ...finding }) => finding);
}

/**
 * Convert raw {@link SecretFinding}s into blocking {@link ReviewIssue}s for a
 * specific file so they flow through the existing review/audit pipeline
 * (review bodies, inline comments, notifications, and severity-based CI gates).
 *
 * Every finding is reported as `critical`, `inline: true` (so it surfaces as a
 * blocking inline comment when the line is present in the diff), categorized as
 * `security`, and carries a redacted message that never exposes the raw secret.
 *
 * @param file - Repo-relative path of the scanned file.
 * @param secrets - Findings returned by {@link detectSecrets} for that file.
 * @returns Review issues ready to merge into a ReviewResult.
 */
export function mergeSecretFindings(file: string, secrets: SecretFinding[]): ReviewIssue[] {
  return secrets.map((finding) => ({
    type: 'issue' as const,
    severity: 'critical' as const,
    file,
    line: finding.line,
    message: `Hardcoded ${finding.type} detected: ${finding.redactedValue}`,
    suggestion:
      'Move the secret to an environment variable or a secret manager (e.g. GitHub ' +
      'Secrets, Vault, AWS Secrets Manager) and rotate the leaked credential.',
    inline: true,
    confidence: 'high' as const,
    category: 'security',
  }));
}
