/**
 * Single registry for credential token formats.
 *
 * Redaction used to maintain three independent pattern catalogs
 * (`sanitizeString`, `redactSecrets`, and `detectSecrets`), and their
 * thresholds had already drifted — a fine-grained GitHub PAT or a short
 * `sk-` key was scrubbed on one egress path but survived on another. Any new
 * provider token had to be added in three places or it silently leaked.
 *
 * Every raw token family now lives here with its provider, detection type,
 * shortest valid body length, and redaction label. `sanitizeString`,
 * `redactSecrets`, and `detectSecrets` all consume this table, so adding a
 * provider is a one-line change.
 *
 * Assignment forms (`GITHUB_TOKEN=…`), URL userinfo, PEM blocks, JWTs, and
 * `Authorization` headers are not token *shapes* and stay in their respective
 * sanitizers/detectors.
 */

/** A single credential token family shared by all redaction/detection paths. */
export interface TokenPattern {
  /** Human-readable provider name (e.g. `github`). */
  readonly provider: string;
  /** Machine-readable detection type emitted by `detectSecrets`. */
  readonly type: string;
  /** Shortest valid token body length for this family (sans any prefix). */
  readonly minLength: number;
  /** Replacement label used when redacting a match. */
  readonly label: string;
  /** Non-global pattern; callers derive a global copy for replacement/scanning. */
  readonly pattern: RegExp;
}

/**
 * Canonical token formats. Order matters where one family's prefix is a
 * prefix of another's (`sk-ant-` before `sk-`) and where a shorter-prefixed
 * pattern could otherwise consume part of a longer token.
 */
export const TOKEN_PATTERNS: readonly TokenPattern[] = [
  {
    provider: 'github',
    type: 'github-fine-grained-pat',
    minLength: 22,
    label: '[REDACTED_GITHUB_TOKEN]',
    pattern: /github_pat_[A-Za-z0-9_]{22,}/,
  },
  {
    provider: 'github',
    type: 'github-pat',
    minLength: 22,
    label: '[REDACTED_GITHUB_TOKEN]',
    pattern: /gh[psuor]_[A-Za-z0-9_-]{22,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 20,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /glpat-[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 20,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /glrt-[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 20,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /glft-[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 20,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /gloas-[A-Za-z0-9_-]{20,}/,
  },
  {
    // `glod-` deploy tokens are genuinely shorter than the other GitLab
    // families; the lower threshold is intentional, not a typo for {20,}.
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 8,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /glod-[A-Za-z0-9_-]{8,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 20,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /gldt-[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 20,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /glr_[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 8,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /GR1348941[A-Za-z0-9_-]{8,}/,
  },
  {
    provider: 'gitlab',
    type: 'gitlab-token',
    minLength: 20,
    label: '[REDACTED_GITLAB_TOKEN]',
    pattern: /glcbt-[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'anthropic',
    type: 'anthropic-api-key',
    minLength: 20,
    label: '[REDACTED_ANTHROPIC_KEY]',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'openai',
    type: 'openai-api-key',
    minLength: 20,
    label: '[REDACTED_OPENAI_KEY]',
    // Negative lookahead keeps Anthropic keys from also matching the OpenAI
    // family (and being mislabeled).
    pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/,
  },
  {
    provider: 'slack',
    type: 'slack-token',
    minLength: 10,
    label: '[REDACTED_SLACK_TOKEN]',
    pattern: /xox[bpars]-[A-Za-z0-9-]{10,}/,
  },
  {
    provider: 'google',
    type: 'google-api-key',
    minLength: 35,
    label: '[REDACTED_GEMINI_KEY]',
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    provider: 'aws',
    type: 'aws-access-key-id',
    minLength: 16,
    label: '[REDACTED_AWS_ACCESS_KEY]',
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    provider: 'stripe',
    type: 'stripe-live-secret-key',
    minLength: 24,
    label: '[REDACTED_STRIPE_KEY]',
    pattern: /sk_live_[A-Za-z0-9]{24,}/,
  },
] as const;

/** Registry entries compiled once with the global flag for replace/scan loops. */
export const GLOBAL_TOKEN_PATTERNS: readonly (TokenPattern & { readonly regex: RegExp })[] =
  TOKEN_PATTERNS.map((entry) => ({
    ...entry,
    regex: new RegExp(entry.pattern.source, 'g'),
  }));

/**
 * Redact every token family in the registry from a string.
 *
 * Used directly by {@link sanitizeString}; `redactSecrets` builds on that, and
 * `detectSecrets` compiles its named-pattern table from the same registry, so
 * all three entry points agree on thresholds and provider coverage.
 *
 * @param input - Text that may contain raw credentials.
 * @returns Text with every registry match replaced by its redaction label.
 */
export function redactTokenPatterns(input: string): string {
  let output = input;
  for (const entry of GLOBAL_TOKEN_PATTERNS) {
    entry.regex.lastIndex = 0;
    output = output.replace(entry.regex, entry.label);
  }
  return output;
}
