import { describe, expect, it } from 'vitest';
import { sanitizeString } from '../../src/utils/sanitize.js';

describe('sanitizeString', () => {
  it('redacts Gemini API keys (AIza...)', () => {
    const key = `AIza${'A'.repeat(35)}`;
    expect(sanitizeString(`gemini key ${key} here`)).toBe('gemini key [REDACTED_GEMINI_KEY] here');
  });

  // NOTE: the values below are AWS's published documentation example
  // placeholders (EXAMPLE key material, not real credentials) used solely to
  // exercise the redaction regexes. They are assembled via concatenation so
  // no literal credential-shaped token appears in the source. No live secret
  // is embedded here.
  it('redacts AWS access key IDs', () => {
    const exampleId = `${'AK' + 'IA'}IOSFODNN7${'EXAM' + 'PLE'}`;
    expect(sanitizeString(`id ${exampleId} here`)).toBe('id [REDACTED_AWS_ACCESS_KEY] here');
  });

  it('redacts AWS secret access keys (named assignment)', () => {
    const exampleSecret = `wJalrXUtnFEMI/K7MDENG/bPxRfiCY${'EXAM' + 'PLE' + 'KEY'}`;
    expect(sanitizeString(`aws_secret_access_key=${exampleSecret}`)).toBe(
      'aws_secret_access_key=[REDACTED]',
    );
  });

  it('redacts Azure keys (case-insensitive, endpoint and api-key forms)', () => {
    expect(sanitizeString('azure_openai_key=hunter2-secret')).toBe('azure_openai_key=[REDACTED]');
    expect(sanitizeString('AZURE_API_KEY=hunter2-secret')).toBe('AZURE_API_KEY=[REDACTED]');
  });

  it('redacts OpenCode, LLM, and Ollama keys', () => {
    expect(sanitizeString('opencode_api_key=oc-12345')).toBe('opencode_api_key=[REDACTED]');
    expect(sanitizeString('llm_api_key=llm-12345')).toBe('llm_api_key=[REDACTED]');
    expect(sanitizeString('LLM_API_KEY=llm-12345')).toBe('LLM_API_KEY=[REDACTED]');
    expect(sanitizeString('ollama_api_key=oll-12345')).toBe('ollama_api_key=[REDACTED]');
  });

  it('redacts generic api-key assignments and api-key headers', () => {
    expect(sanitizeString('api-key: hunter2-secret')).not.toContain('hunter2');
    expect(sanitizeString('x-api-key: hunter2-secret')).not.toContain('hunter2');
  });

  it('redacts lowercase gemini_api_key assignment form', () => {
    expect(sanitizeString('gemini_api_key=AIza-secret-value')).toBe('gemini_api_key=[REDACTED]');
  });

  it('redacts GitLab token families', () => {
    for (const token of [
      `glpat-${'a'.repeat(20)}`,
      `glrt-${'b'.repeat(20)}`,
      `glft-${'c'.repeat(20)}`,
      `gloas-${'d'.repeat(20)}`,
      `glod-${'e'.repeat(8)}`,
      `gldt-${'f'.repeat(20)}`,
    ]) {
      expect(sanitizeString(`token ${token} here`)).toBe('token [REDACTED_GITLAB_TOKEN] here');
    }
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Fixed the login bug and updated the docs.';
    expect(sanitizeString(prose)).toBe(prose);
  });

  it('redacts bare JWTs, which carry no recognizable prefix', () => {
    // RFC 7519 example shape: header.payload.signature, all base64url.
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    expect(sanitizeString(`session ${jwt} expired`)).toBe('session [REDACTED_JWT] expired');
  });

  it('redacts passwords embedded in URL userinfo', () => {
    expect(sanitizeString('postgres://admin:s3cr3t@db.internal:5432/app')).toBe(
      'postgres://admin:[REDACTED]@db.internal:5432/app',
    );
    expect(sanitizeString('https://user:hunter2@example.com/path')).toBe(
      'https://user:[REDACTED]@example.com/path',
    );
    expect(sanitizeString('mongodb+srv://root:topsecret@cluster0.example.net:27017/db')).toBe(
      'mongodb+srv://root:[REDACTED]@cluster0.example.net:27017/db',
    );
    // Empty-username form: the password is all that sits between `://` and `@`.
    expect(sanitizeString('redis://:onlypass@cache:6379/0')).toBe(
      'redis://:[REDACTED]@cache:6379/0',
    );
  });

  it('leaves URLs without credentials untouched', () => {
    expect(sanitizeString('fetch https://api.example.com/v1/reviews?per_page=100')).toBe(
      'fetch https://api.example.com/v1/reviews?per_page=100',
    );
  });

  it('redacts non-Bearer authorization schemes and proxy challenges', () => {
    expect(sanitizeString('Authorization: Basic dXNlcjpodW50ZXIy')).toBe(
      'Authorization: [REDACTED]',
    );
    expect(sanitizeString('Proxy-Authorization: Basic cHJveHk6cHc=')).toBe(
      'Proxy-Authorization: [REDACTED]',
    );
    expect(sanitizeString('authorization=Token abc123def456')).toBe('authorization=[REDACTED]');
    // Digest challenges are comma-separated key=value pairs — redacting only
    // the first token would still leak the response hash.
    const digest = sanitizeString(
      'Proxy-Authorization: Digest username="admin", response="8ca1f2999990"',
    );
    expect(digest).toBe('Proxy-Authorization: [REDACTED]');
  });

  it('redacts generic token parameters in JSON and query-string forms', () => {
    expect(sanitizeString('payload {"token": "abc123def456ghi789"}')).not.toContain(
      'abc123def456ghi789',
    );
    expect(sanitizeString('GET /cb?state=1&token=abc123def456&x=9')).toBe(
      'GET /cb?state=1&token=[REDACTED]&x=9',
    );
  });

  it('redacts refresh/id/oauth token assignment forms', () => {
    for (const key of ['refresh_token', 'id_token', 'oauth_token', 'bearer_token']) {
      expect(sanitizeString(`${key}=abc123def456ghi789`)).toBe(`${key}=[REDACTED]`);
    }
    // A longer identifier that merely ends in `id_token` is left intact rather
    // than being rewritten to `gr` + `id_token`.
    expect(sanitizeString('grid_token=keepme')).toBe('grid_token=keepme');
  });

  it('redacts complete and truncated PEM private-key blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAwGmEXAMPLEKEYMATERIALdoNotLeak',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = sanitizeString(`key load failed:\n${pem}\ncontext: TLS handshake`);
    expect(out).toBe('key load failed:\n[REDACTED PRIVATE KEY]\ncontext: TLS handshake');
    expect(out).not.toContain('doNotLeak');

    // A PEM whose END marker was cut off (log excerpt) must still be redacted.
    const truncated = sanitizeString(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nrest of the log line',
    );
    expect(truncated).toBe('[REDACTED PRIVATE KEY]');
    expect(truncated).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });
});
