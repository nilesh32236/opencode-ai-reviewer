import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/utils/redact.js';
import { sanitizeString } from '../src/utils/sanitize.js';
import { detectSecrets } from '../src/utils/secret-detect.js';
import { TOKEN_PATTERNS } from '../src/utils/token-patterns.js';

/**
 * Each sample is the shortest valid token for its registry pattern. Feeding it
 * through every entry point pins the original defect: the three redaction
 * catalogs used different minimum lengths, so a short-but-valid token was
 * scrubbed on one path and survived on another.
 */
const SHORTEST_VALID: Record<string, string> = {
  'github_pat_[A-Za-z0-9_]{22,}': `github_pat_${'a'.repeat(22)}`,
  'gh[psuor]_[A-Za-z0-9_-]{22,}': `ghp_${'a'.repeat(22)}`,
  'glpat-[A-Za-z0-9_-]{20,}': `glpat-${'a'.repeat(20)}`,
  'glrt-[A-Za-z0-9_-]{20,}': `glrt-${'a'.repeat(20)}`,
  'glft-[A-Za-z0-9_-]{20,}': `glft-${'a'.repeat(20)}`,
  'gloas-[A-Za-z0-9_-]{20,}': `gloas-${'a'.repeat(20)}`,
  'glod-[A-Za-z0-9_-]{8,}': `glod-${'a'.repeat(8)}`,
  'gldt-[A-Za-z0-9_-]{20,}': `gldt-${'a'.repeat(20)}`,
  'glr_[A-Za-z0-9_-]{20,}': `glr_${'a'.repeat(20)}`,
  'GR1348941[A-Za-z0-9_-]{8,}': `GR1348941${'a'.repeat(8)}`,
  'glcbt-[A-Za-z0-9_-]{20,}': `glcbt-${'a'.repeat(20)}`,
  'sk-ant-[A-Za-z0-9_-]{20,}': `sk-ant-${'a'.repeat(20)}`,
  'sk-(?!ant-)[A-Za-z0-9_-]{20,}': `sk-${'a'.repeat(20)}`,
  'xox[bpars]-[A-Za-z0-9-]{10,}': `xoxb-${'a'.repeat(10)}`,
  'AIza[0-9A-Za-z_-]{35}': `AIza${'A'.repeat(35)}`,
  'AKIA[0-9A-Z]{16}': `AKIA${'A'.repeat(16)}`,
  'sk_live_[A-Za-z0-9]{24,}': `sk_live_${'a'.repeat(24)}`,
};

describe('shared token-pattern registry', () => {
  it.each(TOKEN_PATTERNS.map((entry) => ({ entry, source: entry.pattern.source })))(
    'redacts and detects $entry.provider/$entry.type at its shortest valid length',
    ({ entry, source }) => {
      const token = SHORTEST_VALID[source];
      expect(token, `missing shortest-valid sample for ${source}`).toBeDefined();
      expect(token.length).toBeGreaterThanOrEqual(entry.minLength);
      const text = `value ${token} end`;

      expect(sanitizeString(text)).not.toContain(token);
      expect(redactSecrets(text)).not.toContain(token);

      const findings = detectSecrets(text);
      const match = findings.find((finding) => finding.type === entry.type);
      expect(match, `detectSecrets missed ${entry.type} (${source})`).toBeDefined();
      expect(match?.redactedValue).not.toContain(token);
    },
  );
});
