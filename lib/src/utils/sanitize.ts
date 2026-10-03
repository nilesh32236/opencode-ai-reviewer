/**
 * Sanitize a string by redacting common credential and token patterns.
 *
 * Redacts the following patterns:
 * - Armored private-key blocks (any `-----BEGIN … PRIVATE KEY-----` label, which
 *   covers `RSA`/`EC`/`DSA`/`OPENSSH`/`ENCRYPTED` and OpenPGP's `PGP PRIVATE KEY
 *   BLOCK`, plus the header and base64 body of a key whose END marker was cut off)
 * - GitHub tokens (ghp_, github_pat, gho_, ghs_, ghu_, ghr_)
 * - GitLab tokens (glpat-, glrt-, glft-, gloas-, glod-, gldt-, glcbt-, glr_, GR1348941 runner tokens)
 * - JSON Web Tokens (bare `eyJ…` triples)
 * - OpenAI API keys (sk-...)
 * - Anthropic API keys (sk-ant-...)
 * - Authorization / Proxy-Authorization values (any scheme, quoted or not)
 * - Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-, xoxr-)
 * - x-access-token credentials in URLs
 * - Passwords embedded in URL userinfo (any scheme, e.g. `postgres://<user>:<password>@<host>`)
 * - Environment variable assignments for known API keys
 * - Google/Gemini API keys (AIza...)
 * - AWS access key IDs (AKIA...) and secret access keys
 * - Azure / OpenCode / generic LLM API keys and endpoints
 * - Generic `*token` assignments (access/refresh/id/oauth/bearer/auth), plus
 *   `client`/`app`/`api_secret` and standalone `token` / `x-token` / `csrf_token`
 *   forms for query-param and JSON shapes
 *
 * Matching is intentionally case-insensitive for the named `*_API_KEY`
 * assignment form so lowercase variants (e.g. `azure_api_key`,
 * `gemini_api_key`, `llm_api_key`) are redacted as well.
 *
 * PERFORMANCE: this function is synchronous and is the chokepoint every
 * `Logger.*` line passes through, so no rule may be superlinear. V8 starts a
 * match attempt at every position whose leading character fits, which makes an
 * unbounded run quantifier followed by a literal quadratic (each start position
 * consumes the whole run, then gives it back one character at a time). Every
 * such run is therefore bounded here: the DSN scheme run to `{0,15}` (RFC 3986
 * schemes are short — `mongodb+srv` is the longest seen), the armored-key label
 * to `{0,32}`, and the DSN password to `{0,512}`. Do not relax them back to
 * `*` without re-measuring a base64 blob or a minified bundle through this file.
 *
 * Use this function whenever logging or displaying untrusted input,
 * error messages, or configuration values that may contain credentials.
 *
 * @param input - The string to sanitize.
 * @returns The sanitized string with credentials replaced by `[REDACTED]` markers.
 */
export function sanitizeString(input: string): string {
  return (
    input
      // Armored private keys first: their base64 body can otherwise trip the
      // API-key / token rules and leave key material in the log. The label is
      // matched generically (bounded run of uppercase words) so vendor variants
      // outside the RSA/EC/DSA/OPENSSH/PGP list — OpenPGP's
      // `PGP PRIVATE KEY BLOCK`, `SSH2 ENCRYPTED PRIVATE KEY`, … — are covered
      // too, while public certificates stay untouched because the run is still
      // anchored on `PRIVATE KEY`.
      .replace(
        /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----/g,
        '[REDACTED PRIVATE KEY]',
      )
      // Truncated PEM (no END marker — e.g. a sliced log excerpt, or an armored
      // key whose tail was never written): drop the header plus the base64 body
      // lines that follow it, and nothing more. The body is matched explicitly
      // rather than with `[\s\S]*` so the trailing context of the log line (or
      // of a user-facing error message) survives a stray header.
      .replace(
        /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----[ \t]*(?:\r?\n[A-Za-z0-9+/=]{16,})*/g,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(/(ghp|github_pat|gho|ghs|ghu|ghr)_[a-zA-Z0-9_-]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
      // All GitLab families in one pass: they differ only in prefix and in the
      // lower quantifier bound, so a single alternation replaces nine scans.
      // `glod-` deploy tokens are genuinely shorter than the rest, so their
      // lower {8,} threshold is intentional (not a typo for {20,}); short
      // `glod-`-prefixed strings may false-positive, fail-safe.
      .replace(
        /gl(?:pat|rt|ft|oas|dt|cbt)-[A-Za-z0-9_-]{20,}|glod-[A-Za-z0-9_-]{8,}|glr_[A-Za-z0-9_-]{20,}|GR1348941[A-Za-z0-9_-]{8,}/g,
        '[REDACTED_GITLAB_TOKEN]',
      )
      .replace(
        /(gitlab[_-]?token|deploy[_-]?token|private[_-]?token)[="':\s]+[^\s'"]+/gi,
        '$1=[REDACTED]',
      )
      // Bare JWTs carry no recognizable prefix, so the header/payload/signature
      // shape (`eyJ…`) is the only signal available on the log path. The
      // lookbehind keeps the match at the start of a base64url run, so a long
      // run is scanned once rather than once per `eyJ` inside it.
      .replace(
        /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
        '[REDACTED_JWT]',
      )
      .replace(/sk-[a-zA-Z0-9-]{48,}/g, '[REDACTED_OPENAI_KEY]')
      .replace(/sk-ant-[a-zA-Z0-9_-]{40,}/g, '[REDACTED_ANTHROPIC_KEY]')
      .replace(/(Bearer\s+)[a-zA-Z0-9._\-\/+=]+/g, '$1[REDACTED]')
      // Authorization headers of *any* scheme (Basic, Token, Digest,
      // Negotiate, AWS4-HMAC-SHA256, SharedKey, HMAC, Signature, OAuth, an
      // unrecognised vendor scheme, …), Proxy-Authorization included since
      // proxy 401 challenges carry the same credentials. Only the value is a
      // credential, so the header name and separator are preserved.
      //
      // The whole value is consumed rather than one whitespace-delimited token:
      // a Digest challenge is a comma-separated `key=value` list and an
      // AWS4-HMAC-SHA256 credential spans several tokens, so redacting only up
      // to the first space would still leak. A quoted value — the dominant
      // shape in JSON-serialized headers and API error bodies — is consumed as
      // a unit so the rest of that JSON object survives.
      .replace(
        /((?:proxy-)?authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1[REDACTED]')
      .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
      // Connection strings / URLs with `user:password@` userinfo. Any scheme is
      // covered (postgres, mongodb, redis, amqp, https, …) because the password
      // is embedded the same way. The `x-access-token:[REDACTED]@` special case
      // above is retained for readability; this rule is a superset of it.
      //
      // The scheme run is bounded to `{0,15}`: unbounded, the pattern is
      // quadratic in the longest scheme-legal run, and sanitizeString runs
      // synchronously over agent-captured CLI output (base64 blobs, minified
      // bundles) on the logging chokepoint. The password is matched lazily up
      // to the authority's `@host[:port]`, so it may contain whitespace, `/`
      // and raw `@` characters — real .env files, CI error messages and
      // driver-level connection strings routinely contain these non-RFC-3986
      // forms. Requiring the host to end at an authority boundary (the lookahead
      // rejects another host character or `@`) is what keeps a raw `@` inside
      // the password from being mistaken for the authority separator.
      .replace(
        /([a-zA-Z][a-zA-Z0-9+.-]{0,15}:\/\/)([^\s\/?#:@]+):([^\r\n]{0,512}?)(@[A-Za-z0-9._~-]+(?::\d+)?)(?![\w.~@-])/g,
        '$1$2:[REDACTED]$4',
      )
      // Empty-username form (`redis://:<password>@host`), where the password is
      // the only thing between `://` and `@`.
      .replace(
        /([a-zA-Z][a-zA-Z0-9+.-]{0,15}:\/\/):([^\r\n]{0,512}?)(@[A-Za-z0-9._~-]+(?::\d+)?)(?![\w.~@-])/g,
        '$1:[REDACTED]$3',
      )
      .replace(
        /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|AZURE_OPENAI_KEY|AZURE_API_KEY|OPENCODE_API_KEY|LLM_API_KEY|OLLAMA_API_KEY|AWS_SECRET_ACCESS_KEY)[=":]+[^&\s'"]+/gi,
        '$1=[REDACTED]',
      )
      .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED_GEMINI_KEY]')
      .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_ACCESS_KEY]')
      // Named `*_api_key` assignments (Azure, OpenCode, Ollama, LLM, Gemini and
      // the generic `api_key`) in one pass. `x-api-key:` / `api-key:` header
      // forms need no rule of their own: the `api[_-]?key` branch of the same
      // alternation already matches the `api-key` tail of both. No word-boundary
      // lookbehind here on purpose — matching the tail of a longer identifier
      // (`myapi_key=…`) still redacts the value, which is the fail-safe side.
      .replace(
        /((?:azure[_-]?openai|azure|opencode|ollama|llm|gemini|api)[_-]?key|aws[_-]?secret[_-]?access[_-]?key)[=":\s]+[^&\s'"]+/gi,
        '$1=[REDACTED]',
      )
      // Named `*token` assignments. The leading lookbehind keeps the match
      // word-aligned so `grid_token=…` is not split into `gr` + `id_token`.
      .replace(
        /(?<![A-Za-z0-9])((?:access|refresh|id|oauth|bearer|auth)[_-]?token)[="':\s]+[^\s'"]+/gi,
        '$1=[REDACTED]',
      )
      // `*_secret` assignments. Kept separate from the rule above because that
      // one's `token` suffix is mandatory, which would make a `client_secret`
      // branch inside its alternation unmatchable (`client_secrettoken` does
      // not exist) — the branch would document coverage it never provided.
      .replace(
        /(?<![A-Za-z0-9])((?:client|app|api|consumer|account)[_-]?secret)[="':\s]+[^\s'"]+/gi,
        '$1=[REDACTED]',
      )
      // Standalone `token` in query-param and JSON forms (`?token=…`,
      // `{"token": "…"}`), which carry no distinguishing prefix at all, plus the
      // header-style spellings that read as harmless (`x-token`, `x-api-token`,
      // `xsrf-token`, `csrf_token`). The lookbehind applies the same
      // word-boundary discipline as the named rules above, so identifiers that
      // merely end in `token` (`grid_token`, `page_token`, `valid_id_token`) are
      // still preserved.
      .replace(
        /(?<![A-Za-z0-9_])((?:x[-_]?(?:api[-_]?)?|csrf[-_]?|xs[-_]?)?token)(["']?\s*[:=]\s*["']?)[^&\s,'"}]+/gi,
        '$1$2[REDACTED]',
      )
  );
}
