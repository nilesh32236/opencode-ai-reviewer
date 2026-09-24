import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actionManifest = readFileSync(new URL('../../action.yml', import.meta.url), 'utf8');

function getInputBlock(name: string): string {
  const match = actionManifest.match(
    new RegExp(
      `^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:[ \\t]*$|^outputs:[ \\t]*$|^runs:[ \\t]*$)`,
      'm',
    ),
  );
  expect(match, `Missing action input: ${name}`).not.toBeNull();
  return match?.[0] ?? '';
}

describe('action manifest model inputs', () => {
  it.each(['review_model', 'fix_model', 'timeout_minutes'])(
    '%s has no manifest default',
    (name) => {
      expect(getInputBlock(name)).not.toMatch(/^\s+default:/m);
    },
  );

  it('documents timeout_minutes as an explicit optional bounded limit', () => {
    const block = getInputBlock('timeout_minutes');
    expect(block).toContain('Optional hard execution timeout');
    expect(block).toContain('OpenCode model and verification work');
    expect(block).toContain('starts after input/config resolution');
    expect(block).toContain('excludes setup API/download/health');
    expect(block).toContain('MCP/convention enrichment');
    expect(block).toContain('and post-run cleanup');
  });
});
