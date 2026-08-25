/**
 * Sanitize a string by redacting common credential and token patterns.
 *
 * Redacts the following patterns:
 * - GitHub tokens (ghp_, github_pat, gho_, ghs_, ghu_, ghr_)
 * - OpenAI API keys (sk-...)
 * - Anthropic API keys (sk-ant-...)
 * - Bearer tokens from Authorization headers
 * - Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-, xoxr-)
 * - x-access-token credentials in URLs
 * - Environment variable assignments for known API keys
 *
 * Use this function whenever logging or displaying untrusted input,
 * error messages, or configuration values that may contain credentials.
 *
 * @param input - The string to sanitize.
 * @returns The sanitized string with credentials replaced by `[REDACTED]` markers.
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/(ghp|github_pat|gho|ghs|ghu|ghr)_[a-zA-Z0-9_-]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[a-zA-Z0-9-]{48,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/sk-ant-[a-zA-Z0-9_-]{40,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/(Bearer\s+)[a-zA-Z0-9._\-\/+=]+/g, '$1[REDACTED]')
    .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1[REDACTED]')
    .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
    .replace(
      /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN|GH_TOKEN|OPENCODE_API_KEY|LLM_API_KEY|AZURE_OPENAI_API_KEY|[A-Z0-9_]*API_KEY)\s*[=:"]+\s*[^&\s'"]+/gi,
      '$1=[REDACTED]',
    );
}
