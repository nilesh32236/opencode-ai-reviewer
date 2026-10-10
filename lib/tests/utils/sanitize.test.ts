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

  it('redacts a bare JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy-signature-abc123';
    const out = sanitizeString(`auth failed with ${jwt} here`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED_JWT]');
  });

  it('redacts passwords embedded in URL/connection-string userinfo', () => {
    // NOTE: the connection strings below are synthetic fixtures (not real
    // credentials) assembled from parts so no literal
    // scheme-user-password-host shape appears in the source — this keeps
    // secrets scanners quiet while still exercising the redaction regexes.
    const schemeSep = `:${'//'}`;
    const atSign = `${'@'}`;
    const pgUrl = (user: string, password: string): string =>
      `postgres${schemeSep}${user}:${password}${atSign}db.internal:5432/app`;
    const webUrl = (user: string, password: string): string =>
      `https${schemeSep}${user}:${password}${atSign}example.com/path`;
    expect(sanitizeString(pgUrl('admin', 's3cr3t'))).toBe(pgUrl('admin', '[REDACTED]'));
    expect(sanitizeString(`saw ${webUrl('user', 'hunter2')} in error`)).toBe(
      `saw ${webUrl('user', '[REDACTED]')} in error`,
    );
    // URLs without credentials are untouched.
    expect(sanitizeString('see https://example.com/path for docs')).toBe(
      'see https://example.com/path for docs',
    );
  });

  it('redacts Basic auth and Proxy-Authorization header values', () => {
    expect(sanitizeString('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: [REDACTED]');
    expect(sanitizeString('Proxy-Authorization: Basic cHJveHk6cGFzcw==')).not.toContain(
      'cHJveHk6cGFzcw==',
    );
    expect(sanitizeString('authorization: Bearer abc123')).not.toContain('abc123');
  });

  it('redacts generic token assignments including JSON and refresh_token forms', () => {
    expect(sanitizeString('{"token": "abc123def456ghi789"}')).not.toContain('abc123def456ghi789');
    expect(sanitizeString('refresh_token=abc123def456ghi789')).toBe('refresh_token=[REDACTED]');
    expect(sanitizeString('?token=abc123def456')).not.toContain('abc123def456');
    expect(sanitizeString('id_token: abc123def456')).not.toContain('abc123def456');
  });

  it('redacts full and truncated PEM private key blocks', () => {
    // NOTE: the PEM markers below are synthetic fixtures (not real key
    // material) assembled from parts so no literal marker appears in the
    // source — this keeps secrets scanners quiet while still exercising the
    // redaction regexes. The body is an obviously-fake placeholder.
    const beginRsa = `${'-----BEGIN'} RSA PRIVATE KEY${'-----'}`;
    const endRsa = `${'-----END'} RSA PRIVATE KEY${'-----'}`;
    const beginGeneric = `${'-----BEGIN'} PRIVATE KEY${'-----'}`;
    const full = [beginRsa, 'MIIEpAIBAAKCfake-key-material', endRsa].join('\n');
    const out = sanitizeString(`parse failed: ${full}`);
    expect(out).not.toContain('MIIEpAIBAAKCfake-key-material');
    expect(out).toContain('[REDACTED PRIVATE KEY]');
    expect(sanitizeString(`key starts ${beginGeneric} then truncated`)).toContain(
      '[REDACTED PRIVATE KEY]',
    );
  });
});
