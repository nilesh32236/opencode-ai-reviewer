/**
 * Sanitize a string by redacting common credential and token patterns.
 *
 * Redacts the following patterns:
 * - GitHub tokens (ghp_, github_pat, gho_, ghs_, ghu_, ghr_)
 * - GitLab tokens (glpat-, glrt-, glft-, gloas-, glod-, gldt-, glr_, GR1348941 runner tokens, glcbt-, deploy tokens)
 * - OpenAI API keys (sk-...)
 * - Anthropic API keys (sk-ant-...)
 * - Bearer tokens from Authorization headers
 * - Basic/Digest/Token Authorization and Proxy-Authorization header values
 * - JSON Web Tokens (eyJ... base64url.header.payload.signature)
 * - PEM private key blocks (full block) and truncated PEM headers
 * - URL/connection-string userinfo passwords (scheme://user:password@host)
 * - Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-, xoxr-)
 * - x-access-token credentials in URLs
 * - Environment variable assignments for known API keys
 * - Google/Gemini API keys (AIza...)
 * - AWS access key IDs (AKIA...) and secret access keys
 * - Azure / OpenCode / generic LLM API keys and endpoints
 * - Generic `*token` assignments as a fallback (access/refresh/id/oauth/
 *   bearer/auth/client-secret token forms, plus bare `token` in query-param
 *   and JSON `{"token": "..."}` forms)
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
      .replace(/sk-[a-zA-Z0-9-]{48,}/g, '[REDACTED_OPENAI_KEY]')
      .replace(/sk-ant-[a-zA-Z0-9_-]{40,}/g, '[REDACTED_ANTHROPIC_KEY]')
      // PEM private key blocks (multi-line secrets routinely embedded in key
      // parsing, SSH and TLS error text). Full-block first so the body is
      // removed together with its markers, then a header-only fallback so a
      // truncated PEM is still redacted.
      .replace(
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
      // Bare JSON Web Tokens (eyJ<header>.<payload>.<signature>). Runs before
      // the Authorization rules so a JWT in any position is caught, not only
      // in `Authorization: Bearer <jwt>` form.
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
      .replace(/(Bearer\s+)[a-zA-Z0-9._\-/+=]+/g, '$1[REDACTED]')
      // Authorization / Proxy-Authorization headers in `Name: value` form for
      // every common scheme (bearer/basic/token/digest) or a bare value, so a
      // proxy or API 401 challenge never lands in the logs verbatim.
      .replace(
        /(authorization\s*[:=]\s*)(?:bearer|basic|token|digest)?\s*[^\s'"]+/gi,
        '$1[REDACTED]',
      )
      .replace(
        /(proxy-authorization\s*[:=]\s*)(?:bearer|basic|token|digest)?\s*[^\s'"]+/gi,
        '$1[REDACTED]',
      )
      .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1[REDACTED]')
      .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
      // URL / connection-string userinfo passwords (postgres://user:pw@host,
      // https://user:hunter2@example.com/path). The password segment between
      // the userinfo colon and `@` is scrubbed while the username is kept.
      // A username-only variant covers scheme://user@host.
      //
      // The scheme length is BOUNDED at {0,20}: with an unbounded
      // `[a-zA-Z0-9+.-]*` the engine matches the scheme greedily and then
      // backtracks looking for `://` at every start offset, which is O(n^2)
      // on a long single-token string (see the linear-redaction test in
      // egress-redaction.test.ts). Real URI schemes are a handful of
      // characters, so the bound loses no real match.
      .replace(/([a-zA-Z][a-zA-Z0-9+.-]{0,20}:\/\/)([^\s/@:]+):([^\s/@]+)@/g, '$1$2:[REDACTED]@')
      .replace(/([a-zA-Z][a-zA-Z0-9+.-]{0,20}:\/\/)([^\s/@:]+)@/g, '$1[REDACTED]@')
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
      .replace(
        /((?:access|refresh|id|oauth|bearer|auth|client[_-]?secret)[_-]?token)[="':\s]+[^\s'"]+/gi,
        '$1=[REDACTED]',
      )
      // Bare `token` in query-param (`?token=abc`), flag (`--token abc`),
      // header-ish (`token: abc`) and JSON (`{"token": "abc"}`,
      // `{'token' = abc}`) forms, including refresh/id/oauth/bearer variants
      // that the alternation above already covers in assignment form — this
      // rule is the catch-all for the remaining shapes. The trailing `["']?`
      // consumes a quoted value's opening quote (the value class excludes
      // quotes, so without it `{"token": "abc"}` would never match).
      .replace(/(^|[?&;,{\s"'])token["']?\s*[:=]\s*["']?[^&\s,'"}]+/gi, '$1token=[REDACTED]')
      .replace(
        /(^|[?&;,{\s"'])((?:refresh|id|oauth|bearer|auth)[_-]?token)["']?\s*[:=]\s*["']?[^&\s,'"}]+/gi,
        '$1$2=[REDACTED]',
      )
  );
}
