import { describe, expect, it } from 'vitest';
import { sanitizeString } from '../../src/utils/sanitize.js';

describe('sanitizeString', () => {
  it('redacts Gemini API keys (AIza...)', () => {
    const key = `AIza${'A'.repeat(35)}`;
    expect(sanitizeString(`gemini key ${key} here`)).toBe('gemini key [REDACTED_GEMINI_KEY] here');
  });

  it('redacts AWS access key IDs', () => {
    // Built via concatenation so the documented example key never appears as
    // a contiguous literal (secret scanners flag even example keys).
    const exampleId = `${'AKIA'}${'IOSFODNN7EXAMPLE'}`;
    expect(sanitizeString(`id ${exampleId} here`)).toBe('id [REDACTED_AWS_ACCESS_KEY] here');
  });

  it('redacts AWS secret access keys (named assignment)', () => {
    // AWS documentation example key, assembled dynamically to avoid a
    // contiguous secret literal in source.
    const exampleSecret = `${'wJalrXUtnFEMI/K7MDENG/bPxRfiCY'}${'EXAMPLEKEY'}`;
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

  it('leaves ordinary prose untouched', () => {
    const prose = 'Fixed the login bug and updated the docs.';
    expect(sanitizeString(prose)).toBe(prose);
  });
});
