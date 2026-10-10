/**
 * Local gate / CI parity.
 *
 * `pnpm gate` exists so a developer running the repo's conventional commands hits
 * the SAME checks CI runs, in one shot. The gap it closes was real and cost several
 * CI round-trips this campaign: `pnpm test`, `pnpm lint` and `pnpm typecheck` all
 * pass against `src/` while two of CI's gates are invisible to them —
 *
 *   - `doc:check` (eslint jsdoc rules) is not part of `test` or `lint`
 *   - "committed action bundles are fresh" diffs `action/lib/`, which `src/`-level
 *     tooling never reads
 *
 * Both produced red CI on changes whose local test run was green, four times in this
 * campaign (see DECISIONS.md). These tests pin that `gate` covers them, so the
 * parity cannot silently regress.
 */

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('local gate covers every gate CI enforces', () => {
  it('exposes a `gate` script', () => {
    expect(typeof pkg.scripts.gate).toBe('string');
  });

  it('runs typecheck, lint, doc:check, build, bundles:check and test', () => {
    const gate = pkg.scripts.gate;
    for (const step of ['typecheck', 'lint', 'doc:check', 'build', 'bundles:check', 'test']) {
      expect(gate, `gate must include \`${step}\``).toContain(step);
    }
  });

  it('checks JS docs — the gate that is invisible to test and lint', () => {
    // This is the whole point of the exercise. A change can be perfectly green on
    // `pnpm test` + `pnpm lint` and still fail CI's doc:check.
    expect(pkg.scripts['doc:check']).toBeTruthy();
    expect(pkg.scripts.gate).toContain('doc:check');
    expect(pkg.scripts.test).not.toContain('doc:check');
    expect(pkg.scripts.lint).not.toContain('doc:check');
  });

  it('checks the committed bundles — the other gate invisible to src-level tooling', () => {
    // The action executes action/lib/*.js, not src/. A stale bundle ships
    // unreviewed code while every src-level check is green.
    expect(pkg.scripts['bundles:check']).toBe('bash scripts/check-committed-bundles.sh');
    expect(pkg.scripts.gate).toContain('bundles:check');
  });

  it('CI still enforces the same bundle-freshness rule the local check implements', () => {
    // Parity is only useful if CI keeps its side. If someone deletes the CI step
    // while keeping the local script, this fails.
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).toContain('committed action bundles are stale');
    expect(ci).toContain('git diff --exit-code -- action/lib/');
  });

  it('CI still enforces the same JSDoc rule the local check implements', () => {
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).toContain('pnpm doc:check');
  });
});
