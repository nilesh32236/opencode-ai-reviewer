/**
 * Sanitize a string by redacting common credential and token patterns.
 *
 * Redacts the following patterns:
 * - GitHub tokens (ghp_, github_pat, gho_, ghs_, ghu_, ghr_)
 * - GitLab tokens (glpat-, gldt-, glr_, GR1348941 runner tokens, deploy tokens)
 * - OpenAI API keys (sk-...)
 * - Anthropic API keys (sk-ant-...)
 * - Bearer tokens from Authorization headers
 * - Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-, xoxr-)
 * - x-access-token credentials in URLs
 * - Environment variable assignments for known API keys
 * - Google/Gemini API keys (AIza...)
 * - AWS access key IDs (AKIA...) and secret access keys
 * - Azure / OpenCode / generic LLM API keys and endpoints
 * - Generic `token`/`secret` assignments as a fallback
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
  return input
    .replace(/(ghp|github_pat|gho|ghs|ghu|ghr)_[a-zA-Z0-9_-]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/glpat-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GITLAB_TOKEN]')
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
    .replace(/(Bearer\s+)[a-zA-Z0-9._\-\/+=]+/g, '$1[REDACTED]')
    .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1[REDACTED]')
    .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
    .replace(
      /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|AZURE_OPENAI_KEY|AZURE_API_KEY|OPENCODE_API_KEY|LLM_API_KEY|OLLAMA_API_KEY|AWS_SECRET_ACCESS_KEY)[=":]+[^&\s'"]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED_GEMINI_KEY]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(/(azure[_-]?openai[_-]?key|azure[_-]?api[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
    .replace(/(opencode[_-]?api[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
    .replace(/(ollama[_-]?api[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
    .replace(/(aws[_-]?secret[_-]?access[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
    .replace(/(api[_-]?key)[=":\s]+[^&\s'"]+/gi, '$1=[REDACTED]')
    .replace(/(x-api-key:\s*)[^\s'"]+/gi, '$1[REDACTED]')
    .replace(/(api-key:\s*)[^\s'"]+/gi, '$1[REDACTED]')
    .replace(/((?:access|auth|client[_-]?secret)[_-]?token)[="':\s]+[^\s'"]+/gi, '$1=[REDACTED]');
}
