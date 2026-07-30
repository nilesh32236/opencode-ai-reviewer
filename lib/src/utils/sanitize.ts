export function sanitizeString(input: string): string {
  return input
    .replace(/(ghp|github_pat|gho|ghs|ghu|ghr)_[a-zA-Z0-9_-]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[a-zA-Z0-9-]{48,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/sk-ant-[a-zA-Z0-9_-]{40,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/(Bearer\s+)[a-zA-Z0-9._\-+/]+/gi, '$1[REDACTED]')
    .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1[REDACTED]')
    .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
    .replace(
      /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN)[=":]+[^&\s'"]+/gi,
      '$1=[REDACTED]',
    );
}
