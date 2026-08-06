import { describe, expect, it } from 'vitest';
import {
  detectSecrets,
  mergeSecretFindings,
  shannonEntropy,
} from '../../src/utils/secret-detect.js';

// Fixtures are assembled from disjoint pieces so source never contains a
// literal full-secret pattern that GitHub secret scanning would reject.
const AWS_ACCESS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const AWS_SECRET = ['wJalrXUtnFEMI/K7MD', 'ENG/bPxRfiCYEXAMPLEKEY'].join('');
const GITHUB_PAT = ['ghp_', 'aBcDeFgHiJkLmNOpQrStUvWxYz', '0123456789'].join('');
const FINE_GRAINED_PAT = ['github_pat_', 'abCdEfGhIjKlMnOpQrStUvWxYz', '0123456789'].join('');
const OPENAI_KEY = ['sk-', 'AbCdEfGhIjKlMnOpQrStUvWxYz', '0123'].join('');
const SLACK_TOKEN = ['xoxb-', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('');
const STRIPE_LIVE = ['sk_live_', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('');

describe('shannonEntropy', () => {
  it('returns 0 for a string of a single repeated character', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('a'.repeat(40))).toBe(0);
  });

  it('returns the base-2 entropy of a varied string', () => {
    const entropy = shannonEntropy(AWS_SECRET);
    expect(entropy).toBeGreaterThan(4.5);
    expect(entropy).toBeLessThanOrEqual(6);
  });
});

describe('detectSecrets', () => {
  it('returns an empty array for empty input', () => {
    expect(detectSecrets('')).toEqual([]);
  });

  it('detects an AWS access key id at the correct line and column', () => {
    const findings = detectSecrets(`const key = "${AWS_ACCESS_KEY}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('aws-access-key-id');
    expect(finding.line).toBe(1);
    expect(finding.column).toBe('const key = "'.length);
    expect(finding.redactedValue).toBe('AKIA…MPLE');
    expect(finding.severity).toBe('critical');
    expect(finding.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('detects an aws_secret_access_key assignment and redacts the captured secret', () => {
    const findings = detectSecrets(`aws_secret_access_key = "${AWS_SECRET}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('aws-secret-access-key');
    expect(finding.line).toBe(1);
    expect(finding.column).toBe(0);
    expect(finding.redactedValue).toBe('wJal…EKEY');
  });

  it('detects a GitHub personal access token', () => {
    const findings = detectSecrets(`token = "${GITHUB_PAT}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('github-pat');
    expect(finding.column).toBe('token = "'.length);
  });

  it('detects a GitHub fine-grained personal access token', () => {
    const findings = detectSecrets(`const pat = "${FINE_GRAINED_PAT}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('github-fine-grained-pat');
    expect(finding.column).toBe('const pat = "'.length);
  });

  it('detects a PEM private key block start at the correct line', () => {
    const pemBegin = ['-----', 'BEGIN ', 'RSA ', 'PRIVATE KEY', '-----'].join('');
    const pemEnd = ['-----', 'END ', 'RSA ', 'PRIVATE KEY', '-----'].join('');
    const text = `const first = 1;
${pemBegin}
MIIEowIBAAKCAQEA
${pemEnd}`;
    const findings = detectSecrets(text);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('private-key');
    expect(finding.line).toBe(2);
    expect(finding.column).toBe(0);
    expect(finding.redactedValue).not.toContain('BEGIN');
    expect(finding.redactedValue).not.toContain('RSA');
  });

  it('detects an OpenAI API key', () => {
    const findings = detectSecrets(`const openaiKey = "${OPENAI_KEY}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('openai-api-key');
    expect(finding.redactedValue).toBe('sk-A…0123');
  });

  it('detects a Slack token', () => {
    const findings = detectSecrets(`const slack = "${SLACK_TOKEN}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('slack-token');
    expect(finding.redactedValue).toBe('xoxb…wxyz');
  });

  it('detects a Stripe live secret key', () => {
    const findings = detectSecrets(`const stripeKey = "${STRIPE_LIVE}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('stripe-live-secret-key');
    expect(finding.redactedValue).toBe('sk_l…wxyz');
  });

  it('flags a high-entropy base64 string as generic-high-entropy', () => {
    const findings = detectSecrets(`token = "${AWS_SECRET}"`);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.type).toBe('generic-high-entropy');
    expect(finding.redactedValue).toBe('wJal…EKEY');
  });

  it('does not flag a low-entropy repeated-character string', () => {
    expect(detectSecrets(`token = "${'a'.repeat(40)}"`)).toEqual([]);
  });

  it('respects a custom minLength for high-entropy detection', () => {
    const findings = detectSecrets('token = "AbCdEfGhIjKlMnOpQrStUvWxYz"', { minLength: 10 });
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('generic-high-entropy');
  });

  it('filters a finding when its redacted value is in the allowlist', () => {
    const findings = detectSecrets(`token = "${GITHUB_PAT}"`, { allowlist: ['ghp_…6789'] });
    expect(findings).toEqual([]);
  });

  it('skips a high-entropy token that is in the allowlist', () => {
    const findings = detectSecrets(`token = "${AWS_SECRET}"`, { allowlist: [AWS_SECRET] });
    expect(findings).toEqual([]);
  });

  it('reports multiple secrets on a single line at distinct columns', () => {
    const findings = detectSecrets(`${AWS_ACCESS_KEY} and ${OPENAI_KEY}`);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.column)).toEqual([0, `${AWS_ACCESS_KEY} and `.length]);
    expect(findings.map((f) => f.type)).toEqual(['aws-access-key-id', 'openai-api-key']);
  });

  it('reports secrets across multiple lines with correct line numbers', () => {
    const findings = detectSecrets(
      `aws_access_key_id = "${AWS_ACCESS_KEY}"\naws_secret_access_key = "${AWS_SECRET}"`,
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
    expect(findings.map((f) => f.type)).toEqual(['aws-access-key-id', 'aws-secret-access-key']);
  });

  it('redacts a GitHub token preserving the prefix and only the last 4 chars', () => {
    const findings = detectSecrets(`const token = "${GITHUB_PAT}"`);
    const [finding] = findings;
    expect(finding.redactedValue).toBe('ghp_…6789');
    expect(finding.redactedValue).toContain('…');
    expect(finding.redactedValue.startsWith('ghp_')).toBe(true);
    expect(finding.redactedValue.endsWith('6789')).toBe(true);
  });

  it('produces a stable fingerprint per type, value, and line', () => {
    const a = detectSecrets(`a = "${GITHUB_PAT}"`);
    const b = detectSecrets(`b = "${GITHUB_PAT}"`);
    const c = detectSecrets(`${AWS_ACCESS_KEY}\n${GITHUB_PAT}`);
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
    expect(a[0].fingerprint).not.toBe(c[1].fingerprint);
  });

  it('suppresses a named-pattern finding when the RAW token is in the allowlist', () => {
    const findings = detectSecrets(`const token = "${GITHUB_PAT}"`, {
      allowlist: [GITHUB_PAT],
    });
    expect(findings).toEqual([]);
  });

  it('does not classify a Stripe publishable key (pk_live_) as a secret', () => {
    const publishable = ['pk_live_', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('');
    const findings = detectSecrets(`const pub = "${publishable}"`);
    expect(findings.map((f) => f.type)).not.toContain('stripe-live-publishable-key');
  });

  it('detects an Anthropic API key (sk-ant-) without also matching openai-api-key', () => {
    const anthropic = ['sk-ant-', 'AbCdEfGhIjKlMnOpQrStUvWxYz', '0123456789'].join('');
    const findings = detectSecrets(`const key = "${anthropic}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('anthropic-api-key');
    expect(findings.map((f) => f.type)).not.toContain('openai-api-key');
  });

  it('detects a Google API key', () => {
    const google = ['AIza', 'SyDr3mKbCdEfGhIjKlMnOpQrStUv', 'WXYZabcdefghi'].join('');
    const findings = detectSecrets(`const g = "${google}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('google-api-key');
  });

  it('detects a GitHub installation token (ghs_ prefix) as github-pat', () => {
    const ghs = ['ghs_', 'aBcDeFgHiJkLmNOpQrStUvWxYz', '0123456789'].join('');
    const findings = detectSecrets(`const t = "${ghs}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('github-pat');
  });

  it('detects a mongodb+srv connection string with embedded password and redacts only the password', () => {
    const conn = 'mongodb+srv://admin:superSecret123@cluster.example.net/';
    const findings = detectSecrets(`uri = "${conn}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('connection-string');
    // The redacted value should preserve the scheme+user and host tail, but
    // the password portion between `://`s `:` and `@` must be redacted.
    expect(findings[0].redactedValue.startsWith('mongodb+srv://admin:')).toBe(true);
    expect(findings[0].redactedValue.endsWith('@')).toBe(true);
    expect(findings[0].redactedValue).not.toContain('superSecret123');
    // Password first 4 + last 4 should appear in the redacted form.
    expect(findings[0].redactedValue).toContain('supe');
    expect(findings[0].redactedValue).toContain('t123');
  });

  it('detects a redis://:password@host (empty-username) connection string', () => {
    const conn = 'redis://:onlyPasswordHere@redis.example:6379';
    const findings = detectSecrets(`uri = "${conn}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('connection-string');
    expect(findings[0].redactedValue).not.toContain('onlyPasswordHere');
  });

  it('redacts the full password when it contains embedded colons', () => {
    const conn = 'postgres://user:part1:part2@db.example:5432/app';
    const findings = detectSecrets(`uri = "${conn}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('connection-string');
    // The whole password (including the colon-split second segment) must be
    // redacted — neither `part1` nor `part2` may survive in the output.
    expect(findings[0].redactedValue).not.toContain('part1');
    expect(findings[0].redactedValue).not.toContain('part2');
    expect(findings[0].redactedValue).toContain('part');
    expect(findings[0].redactedValue.endsWith('@')).toBe(true);
  });

  it('still detects a user-only connection string without a password', () => {
    const conn = 'mongodb://replicaset@cluster.example.net/';
    const findings = detectSecrets(`uri = "${conn}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('connection-string');
    expect(findings[0].redactedValue).toBe('mongodb://replicaset@');
  });

  it('returns findings in deterministic source order (line then column)', () => {
    // Two secrets on line 2 (openai FIRST in source, AWS SECOND) — the old
    // implementation returned [aws, openai] because of SECRET_PATTERNS array
    // order. After the fix, output is sorted by (line, column).
    const text = `line 1: clean\n${OPENAI_KEY} then later ${AWS_ACCESS_KEY}`;
    const findings = detectSecrets(text);
    expect(findings).toHaveLength(2);
    expect(findings[0].column).toBeLessThan(findings[1].column);
    expect(findings[0].line).toBe(2);
    expect(findings[1].line).toBe(2);
  });

  it('suppresses a finding when a literal substring of the token is allowlisted', () => {
    // `ghp_` prefix is a substring of the raw token, so the whole finding is
    // suppressed even though the full token is not in the allowlist.
    const findings = detectSecrets(`const key = "${GITHUB_PAT}"`, {
      allowlist: [GITHUB_PAT.slice(0, 10)],
    });
    expect(findings).toEqual([]);
  });

  it('suppresses a high-entropy finding via a substring allowlist entry', () => {
    const findings = detectSecrets(`token = "${AWS_SECRET}"`, { allowlist: ['wJal'] });
    expect(findings).toEqual([]);
  });

  it('suppresses a finding when a /regex/ allowlist entry matches the token', () => {
    const findings = detectSecrets(`token = "${GITHUB_PAT}"`, {
      allowlist: ['/ghp_[a-zA-Z0-9]{36,}/'],
    });
    expect(findings).toEqual([]);
  });

  it('suppresses a high-entropy finding via a /regex/ allowlist entry', () => {
    const findings = detectSecrets(`token = "${AWS_SECRET}"`, {
      allowlist: ['/wJal[a-zA-Z0-9/+=]+/'],
    });
    expect(findings).toEqual([]);
  });

  it('treats an invalid /regex/ allowlist entry as a literal substring', () => {
    // `[unclosed` is not a valid regex, so it falls back to substring matching
    // and does not match, leaving the finding intact.
    const findings = detectSecrets(`token = "${GITHUB_PAT}"`, {
      allowlist: ['/[unclosed'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('github-pat');
  });

  it('keeps a finding when the allowlist entry does not match anything', () => {
    const findings = detectSecrets(`token = "${GITHUB_PAT}"`, { allowlist: ['nope-'] });
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('github-pat');
  });
});

describe('mergeSecretFindings', () => {
  it('converts findings to blocking critical inline issues with redacted messages', () => {
    const findings = detectSecrets(`const key = "${GITHUB_PAT}"`);
    expect(findings).toHaveLength(1);
    const issues = mergeSecretFindings('src/config.ts', findings);
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue.type).toBe('issue');
    expect(issue.severity).toBe('critical');
    expect(issue.file).toBe('src/config.ts');
    expect(issue.line).toBe(1);
    expect(issue.inline).toBe(true);
    expect(issue.confidence).toBe('high');
    expect(issue.category).toBe('security');
    expect(issue.message).toBe('Hardcoded github-pat detected: ghp_…6789');
    // The raw secret must never leak into the issue.
    expect(issue.message).not.toContain(GITHUB_PAT);
    expect(issue.suggestion).toContain('environment variable');
  });

  it('returns an empty array for no findings', () => {
    expect(mergeSecretFindings('src/clean.ts', [])).toEqual([]);
  });
});
