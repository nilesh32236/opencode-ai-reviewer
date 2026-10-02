/**
 * Sanitize a string by redacting common credential and token patterns.
 *
 * Redacts the following patterns:
 * - PEM private-key blocks (full block, and the header when truncated)
 * - GitHub tokens (ghp_, github_pat, gho_, ghs_, ghu_, ghr_)
 * - GitLab tokens (glpat-, glrt-, glft-, gloas-, glod-, gldt-, glr_, GR1348941 runner tokens, glcbt-, deploy tokens)
 * - JSON Web Tokens (bare `eyJ…` triples)
 * - OpenAI API keys (sk-...)
 * - Anthropic API keys (sk-ant-...)
 * - Authorization / Proxy-Authorization values (Bearer, Basic, Token, Digest, …)
 * - Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-, xoxr-)
 * - x-access-token credentials in URLs
 * - Passwords embedded in URL userinfo (postgres://user:pass@host, …)
 * - Environment variable assignments for known API keys
 * - Google/Gemini API keys (AIza...)
 * - AWS access key IDs (AKIA...) and secret access keys
 * - Azure / OpenCode / generic LLM API keys and endpoints
 * - Generic `*token` assignments (access/refresh/id/oauth/bearer/auth/client-secret)
 *   plus a standalone `token=` / `"token":` rule for query-param and JSON forms
 *
 * Matching is intentionally case-insensitive for the named `*_API_KEY`
 * assignment form so lowercase variants (e.g. `azure_api_key`,
 * `gemini_api_key`, `llm_api_key`) are redacted as well.
 * Use this function whenever logging or displaying untrusted input,
 * error messages, or configuration values that may contain credentials.
 *
 * @param input - The string to sanitize.
 * @returns The sanitized string with credentials replaced by `[REDACTED]` markers.
 */
export function sanitizeString(input: string): string {
  return (
    input
      // PEM private keys first: their base64 body can otherwise trip the
      // API-key / token rules and leave key material in the log. A PEM that
      // was truncated (no END marker, e.g. a sliced log excerpt) is still
      // redacted by the header-only fallback below.
      .replace(
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*/g,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(/(ghp|github_pat|gho|ghs|ghu|ghr)_[a-zA-Z0-9_-]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/glpat-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(/glrt-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(/glft-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(/gloas-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
      // `glod-` deploy tokens are genuinely shorter than the other GitLab
      // families, so the lower {8,} threshold is intentional (not a typo for
      // {20,}); short `glod-`-prefixed strings may false-positive, fail-safe.
      .replace(/glod-[A-Za-z0-9_\-]{8,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(/gldt-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(/glr_[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(/GR1348941[A-Za-z0-9_\-]{8,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(/glcbt-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(
        /(gitlab[_-]?token|deploy[_-]?token|private[_-]?token)[="':\s]+[^\s'"]+/gi,
        '$1=[REDACTED]',
      )
      // Bare JWTs carry no recognizable prefix, so the header/payload/signature
      // shape (`eyJ…`) is the only signal available on the log path.
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
      .replace(/sk-[a-zA-Z0-9-]{48,}/g, '[REDACTED_OPENAI_KEY]')
      .replace(/sk-ant-[a-zA-Z0-9_-]{40,}/g, '[REDACTED_ANTHROPIC_KEY]')
      .replace(/(Bearer\s+)[a-zA-Z0-9._\-\/+=]+/g, '$1[REDACTED]')
      // Digest challenges are a comma-separated list of `key=value` pairs, so
      // the whole header value is redacted rather than just its first token.
      .replace(/((?:proxy-)?authorization\s*[:=]\s*)digest\s+[^\r\n]+/gi, '$1[REDACTED]')
      // Authorization headers of any other scheme (Basic/Token/…) —
      // Proxy-Authorization included, since proxy 401 challenges carry the same
      // credentials. Only the value is a credential, so the header name and
      // separator are preserved.
      .replace(
        /((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|token|digest)?\s*[^\s'"]+/gi,
        '$1[REDACTED]',
      )
      .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1[REDACTED]')
      .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
      // Connection strings / URLs with `user:password@` userinfo. Any scheme is
      // covered (postgres, mongodb, redis, amqp, https, …) because the password
      // is embedded the same way. The `x-access-token:[REDACTED]@` special case
      // above is retained for readability; this rule is a superset of it.
      .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s\/@:]+):([^\s\/@]+)@/g, '$1$2:[REDACTED]@')
      // Empty-username form (`redis://:password@host`), where the password is
      // the only thing between `://` and `@`.
      .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/):([^\s\/@]+)@/g, '$1:[REDACTED]@')
      .replace(
        /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|AZURE_OPENAI_KEY|AZURE_API_KEY|OPENCODE_API_KEY|LLM_API_KEY|OLLAMA_API_KEY|AWS_SECRET_ACCESS_KEY)[=":]+[^&\s'"]+/gi,
        '$1=[REDACTED]',
      )
      .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED_GEMINI_KEY]')
      .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_ACCESS_KEY]')
      .replace(
        /(azure[_-]?openai[_-]?key|azure[_-]?api[_-]?key)[=":\s]+[^&\s'"]+/gi,
        '$1=[REDACTED]',
      )
      .replace(/(opencode[_-]?api[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
      .replace(/(ollama[_-]?api[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
      .replace(/(aws[_-]?secret[_-]?access[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
      .replace(/(api[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
      .replace(/(x-api-key:\s*)[^\s'"]+/gi, '$1[REDACTED]')
      .replace(/(api-key:\s*)[^\s'"]+/gi, '$1[REDACTED]')
      // Named `*token` assignments. The leading lookbehind keeps the match
      // word-aligned so `grid_token=…` is not split into `gr` + `id_token`.
      .replace(
        /(?<![A-Za-z0-9])((?:access|refresh|id|oauth|bearer|auth|client[_-]?secret)[_-]?token)[="':\s]+[^\s'"]+/gi,
        '$1=[REDACTED]',
      )
      // Standalone `token` in query-param and JSON forms (`?token=…`,
      // `{"token": "…"}`), which carry no distinguishing prefix at all.
      .replace(/(^|[?&,{"'\s])(token)(["']?\s*[:=]\s*)["']?[^&\s,'"}]+/gi, '$1$2$3[REDACTED]')
  );
}
