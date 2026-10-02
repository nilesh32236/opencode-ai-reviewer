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

    // A PEM whose END marker was cut off (log excerpt) must still be redacted —
    // but only the header and its base64 body, never the context that follows.
    const truncated = sanitizeString(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nrest of the log line',
    );
    expect(truncated).toBe('[REDACTED PRIVATE KEY]\nrest of the log line');
    expect(truncated).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });

  it('redacts armored key labels outside the RSA/EC/DSA/PGP list', () => {
    // OpenPGP's header is `PGP PRIVATE KEY BLOCK`, not `PGP PRIVATE KEY`, and
    // SSH2/OpenSSH variants carry their own prefix — a closed allowlist of six
    // prefixes left every such key in the log intact.
    for (const header of [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      '-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY-----',
    ]) {
      const body = 'lQOYBF9PY3QIYJKoZIhvcNAQELBQBhgk1234abcdEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
      expect(sanitizeString(`${header}\n${body}\ncontext`)).not.toContain('BF9PY3QI');
    }
    const pgp = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'lQOYBF9PY3QIYJKoZIhvcNAQELBQBhgk1234abcdEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd',
      '-----END PGP PRIVATE KEY BLOCK-----',
    ].join('\n');
    expect(sanitizeString(`gpg says:\n${pgp}\ndone`)).toBe(
      'gpg says:\n[REDACTED PRIVATE KEY]\ndone',
    );
    // Truncated variant keeps its trailing context too.
    expect(
      sanitizeString('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF9PY3QIYJKoZIhvcNA\ntail'),
    ).toBe('[REDACTED PRIVATE KEY]\ntail');
    // Public certificates are not secrets and must survive.
    const cert = [
      '-----BEGIN CERTIFICATE-----',
      'MIIEpAIBAAKCAQEAwGmEXAMPLEKEYMATERIALdoNotLeak',
    ].join('\n');
    expect(sanitizeString(cert)).toBe(cert);
  });

  it('redacts non-conformant DSN passwords (whitespace, slash, raw @)', () => {
    expect(sanitizeString('postgres://admin:my pass@db.internal:5432/app')).toBe(
      'postgres://admin:[REDACTED]@db.internal:5432/app',
    );
    expect(sanitizeString('postgres://u:Px7/kQ2@db:5432')).toBe('postgres://u:[REDACTED]@db:5432');
    // A raw `@` inside the password must not be mistaken for the authority
    // separator, which would leave the remainder of the password behind.
    expect(sanitizeString('postgres://u:p@ss@host/db')).toBe('postgres://u:[REDACTED]@host/db');
    expect(sanitizeString('redis://:my pass@cache:6379/0')).toBe(
      'redis://:[REDACTED]@cache:6379/0',
    );
    // …while an unrelated later `@` on the same line is not treated as part of
    // a connection string that has no credential at all.
    expect(sanitizeString('https://example.com:8080/path')).toBe('https://example.com:8080/path');
  });

  it('redacts Authorization values of any scheme, quoted or not', () => {
    // A quoted value is the dominant shape in JSON-serialized headers and API
    // error bodies; it used to match nothing at all.
    expect(sanitizeString('{"authorization":"Basic YWxhZGRpbjpvcGVuc2VzYW1l"}')).toBe(
      '{"authorization":[REDACTED]}',
    );
    // Schemes outside a closed list leaked everything after the scheme word.
    expect(sanitizeString('Authorization: Negotiate a87421000492aa874209af8bc028')).toBe(
      'Authorization: [REDACTED]',
    );
    // AWS4-HMAC-SHA256 and Digest credentials span several whitespace-delimited
    // tokens, so the whole value has to go.
    expect(
      sanitizeString('Authorization: AWS4-HMAC-SHA256 Credential=AKIA/20240101, Signature=abc'),
    ).toBe('Authorization: [REDACTED]');
    expect(
      sanitizeString('Proxy-Authorization: Digest username="admin", response="8ca1f299"'),
    ).toBe('Proxy-Authorization: [REDACTED]');
  });

  it('redacts client secrets and header-style token names', () => {
    expect(sanitizeString('client_secret=GOCSPX-4a7b9c2f1e8d3f5a6b7c8d9e')).toBe(
      'client_secret=[REDACTED]',
    );
    expect(sanitizeString('export CLIENT_SECRET=GOCSPX-4a7b9c2f1e8d3f5a6b7c8d9e')).toBe(
      'export CLIENT_SECRET=[REDACTED]',
    );
    expect(sanitizeString('{"client_secret":"GOCSPX-4a7b9c2f1e8d3f5a6b7c8d9e","x":1}')).toBe(
      '{"client_secret=[REDACTED]","x":1}',
    );
    // Header-style names that read as harmless were left intact before.
    expect(sanitizeString('x-token=abc123def456ghi789')).toBe('x-token=[REDACTED]');
    expect(sanitizeString('csrf_token=abc123def456ghi789')).toBe('csrf_token=[REDACTED]');
    // Identifiers that merely end in `token` are still preserved.
    expect(sanitizeString('page_token=keepme')).toBe('page_token=keepme');
  });

  it('stays linear on long unbroken runs (logging chokepoint)', () => {
    // sanitizeString is synchronous and every Logger.* line passes through it,
    // so an unbounded run quantifier followed by a literal is quadratic: V8
    // restarts the scan at every position that fits. An unbounded DSN scheme
    // run measured 40s on a 200k input and never finished on 400k.
    const blob = 'a'.repeat(200_000);
    const started = process.hrtime.bigint();
    sanitizeString(blob);
    sanitizeString(`${blob}://u:${blob}@host`);
    sanitizeString(`${'-----BEGIN PRIVATE KEY-----'.repeat(1)}${'A'.repeat(200_000)}`);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(2000);
  });
});
