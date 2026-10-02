/**
 * Secret redaction shared by every egress boundary.
 *
 * This module exists because redaction used to be an *opt-in step at each call
 * site*. `action/src/review.ts` remembered to redact before `postReview` and
 * forgot to redact before `sendNotification`, which shipped the raw engine
 * result to an external Slack/Teams webhook; the Probot handler under `app/`
 * never redacted at all. Four sinks, two disciplined — a defect that recurs
 * every time a fifth sink is added.
 *
 * The fix is to make redaction non-optional where payloads cross the boundary,
 * which is why this lives in `lib/` (shared by `action/` and `app/`) and is
 * applied *inside* the egress functions themselves rather than by their callers.
 */
import type { ReviewIssue, ReviewResult } from '../types/index.js';
import { sanitizeString } from './sanitize.js';

/**
 * Redact secret-bearing fragments (CLI flags, assignments, URLs, tokens,
 * keys, certificates, connection strings) before they reach an outbound
 * payload, a log, or LLM context. Builds on {@link sanitizeString} — which
 * already covers GitHub/GitLab tokens, Bearer values, OpenAI/Anthropic keys,
 * AWS access-key IDs, and `*_API_KEY` assignments — with additional patterns
 * for the forms it misses: short `github_pat_` / `gh*_` variants, generic
 * `sk-` keys, `Authorization` headers, PEM blocks, `x-access-token` values,
 * AWS secret values, database connection-string userinfo, and generic
 * `--flag=value` / `key=value` masking.
 * @param text - Raw text (comment body, review body, webhook field, log line).
 * @returns Redacted text.
 */
export function redactSecrets(text: string): string {
  return (
    sanitizeString(String(text ?? ''))
      // PEM blocks (multi-line secrets sanitizeString does not cover).
      .replace(
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
      // Authorization headers (Bearer/Basic/Token) sanitizeString misses in
      // `Header: value` form.
      .replace(/(authorization\s*:\s*(?:bearer|basic|token)\s+)([^\s'"]+)/gi, '$1[REDACTED]')
      // Short GitHub token variants below sanitizeString's {36,} threshold
      // (fine-grained PATs are ~22+ chars).
      .replace(/github_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/gh[psuor]_[A-Za-z0-9]{22,}/g, '[REDACTED_GITHUB_TOKEN]')
      // Generic OpenAI/Anthropic-style keys below sanitizeString's longer
      // thresholds ({48,}/{40,}).
      .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC_KEY]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_KEY]')
      // AWS secret access key values (40-char base64).
      .replace(
        /(aws_secret_access_key\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(["']?)/gi,
        '$1[REDACTED]$3',
      )
      // x-access-token credential values sanitizeString only covers in URL form.
      .replace(/(x-access-token\s*[:=]\s*)([^\s'"]+)/gi, '$1[REDACTED]')
      // Connection-string userinfo: `postgres://user:pw@host:5432/db`. The
      // password is not preceded by the literal `password=` that the assignment
      // rules below look for, so a DATABASE_URL finding would otherwise
      // republish the credential in full. The userinfo group is required to
      // contain a colon, so a bare `https://host` (no credentials) is untouched.
      .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g, '$1[REDACTED]$3')
      .replace(
        /(--?(?:token|password|passwd|pwd|secret|api[_-]?key|auth|access[_-]?key)[=:\s]+)([^\s'"]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/((?:password|passwd|secret)\s*[:=]\s*)([^\s'"]+)/gi, '$1[REDACTED]')
      .replace(/([?&](?:token|key|secret|password)=[^&\s'"]+)/gi, '[REDACTED_PARAM]')
  );
}

/**
 * Redact a single finding's model-derived text. `file` and `line` are left
 * alone: they are paths and integers that identify the finding, and rewriting
 * them would break the fingerprint/dedup anchors the callers key on.
 * @param issue - Finding to scrub.
 * @returns A copy with every free-text field redacted.
 */
function redactIssue(issue: ReviewIssue): ReviewIssue {
  return {
    ...issue,
    message: redactSecrets(issue.message),
    ...(issue.suggestion !== undefined ? { suggestion: redactSecrets(issue.suggestion) } : {}),
    ...(issue.suggestionCode !== undefined
      ? { suggestionCode: redactSecrets(issue.suggestionCode) }
      : {}),
  };
}

/**
 * Redact every model-derived string in a completed review result.
 *
 * Applied at egress boundaries so that *any* caller — the action runner, the
 * Probot handler, or a future one — gets redacted output without having to
 * remember to redact. Review findings routinely quote the offending diff line
 * verbatim, so an unredacted result republishes a hardcoded credential to a
 * PR comment, an inline thread, a check run, or an external webhook.
 * @param result - Raw engine result.
 * @returns A structurally identical result with all model text redacted.
 */
export function redactReviewResult<T extends ReviewResult>(result: T): T {
  return {
    ...result,
    summary: redactSecrets(result.summary),
    verdict: {
      ...result.verdict,
      reasoning: redactSecrets(result.verdict.reasoning),
    },
    strengths: result.strengths.map((s) => ({ ...s, message: redactSecrets(s.message) })),
    issues: result.issues.map(redactIssue),
  };
}
