/**
 * The base-pin integration test.
 *
 * Everything else in this suite runs against synthetic fixtures, and synthetic
 * fixtures are exactly what let the original defect family through: the
 * ENOENT that made run 37090355702's secret scan read nothing was produced by
 * a real workflow, against a real checkout pinned to a real base sha, with real
 * git object plumbing. A mocked `fs` cannot reproduce the interaction between
 * those three things, so a green mocked suite proved nothing.
 *
 * This test builds the actual shape:
 *
 *   repo/                  the real repository, two commits
 *   base-checkout/         worktree checked out at BASE (the PR's parent)
 *   proposed-content/      `git show HEAD:<path>` blobs for the changed files
 *
 * then points OPENCODE_PROPOSED_CONTENT_DIR at the third and scans through the
 * second. A PR-added file is genuinely absent from the base checkout, so this
 * reproduces the exact condition that produced 19 ENOENTs — and asserts the
 * two behaviours that matter:
 *
 *   1. reading the changed file's PROPOSED content works (the fix);
 *   2. reading it from the base checkout alone fails, which is the bug.
 *
 * Nothing here is stubbed except `git` itself being invoked as a subprocess,
 * which is what happens in CI anyway.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveIssueAnchors } from '../src/utils/anchor-resolve.js';
import { CoverageLedger, buildReviewTrust } from '../src/utils/coverage.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' });
}

/** Build the real two-commit repo the workflow actually has. */
function makeRepo(): { repo: string; baseSha: string; headSha: string } {
  const repo = mkdtempSync(path.join(tmpdir(), 'opencode-basepin-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');

  // A file that exists at base and is MODIFIED by the PR. A credential-looking
  // line moves to a different line number in the PR head — the anchor-drift
  // case, reproduced with real git rather than a fixture.
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'existing.ts'), 'export const a = 1;\n', 'utf-8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD').trim();

  // The PR: adds a NEW file (absent from base — the ENOENT trigger) and
  // prepends lines to an existing one (the anchor-drift trigger).
  writeFileSync(
    path.join(repo, 'src', 'added.ts'),
    `export const CREDS = "postgres://appuser:Hunter2Real@db.internal:5432/prod";\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(repo, 'src', 'existing.ts'),
    '// line 1 added by the PR\n// line 2 added by the PR\n// line 3 added by the PR\nexport const a = 1;\n',
    'utf-8',
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'pr');
  const headSha = git(repo, 'rev-parse', 'HEAD').trim();

  return { repo, baseSha, headSha };
}

/**
 * Reproduce the workflow's "Materialize proposed content" step exactly: fetch
 * the head ref and `git show` each changed path into a scan-only directory.
 */
function materializeProposed(repo: string, headSha: string, files: string[]): string {
  const scanDir = mkdtempSync(path.join(tmpdir(), 'opencode-proposed-'));
  for (const f of files) {
    const dest = path.join(scanDir, f);
    mkdirSync(path.dirname(dest), { recursive: true });
    const content = execFileSync('git', ['show', `${headSha}:${f}`], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf-8',
    });
    writeFileSync(dest, content, 'utf-8');
  }
  return scanDir;
}

/** Reproduce the workflow's base-pinned checkout. */
function checkoutBase(repo: string, baseSha: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'opencode-base-'));
  git(repo, 'worktree', 'add', '--detach', '-q', dir, baseSha);
  return dir;
}

describe('base-pinned checkout, real git (integration)', () => {
  let repo: ReturnType<typeof makeRepo>;
  let baseDir: string;
  let scanDir: string;

  beforeEach(() => {
    repo = makeRepo();
    baseDir = checkoutBase(repo.repo, repo.baseSha);
    scanDir = materializeProposed(repo.repo, repo.headSha, ['src/added.ts', 'src/existing.ts']);
  });

  afterEach(() => {
    for (const d of [baseDir, scanDir, repo.repo]) {
      try {
        git(repo.repo, 'worktree', 'remove', '--force', d);
      } catch {
        /* not a worktree; plain rm below */
      }
      // Temp fixture trees are removed unconditionally: `worktree remove`
      // above may already have unlinked some of them.
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('reproduces the ENOENT: a PR-added file does not exist in the base checkout', () => {
    // This is the condition that produced 19 unreadable files on
    // 37090355702. Asserted explicitly so the fixture cannot silently stop
    // reproducing it.
    expect(existsSync(path.join(baseDir, 'src', 'added.ts'))).toBe(false);
    expect(existsSync(path.join(baseDir, 'src', 'existing.ts'))).toBe(true);
    // The base copy of existing.ts holds PRE-change bytes — the other half of
    // the bug: not missing, just wrong.
    expect(readFileSync(path.join(baseDir, 'src', 'existing.ts'), 'utf-8')).toBe(
      'export const a = 1;\n',
    );
  });

  it('reads the proposed copy the workflow stages, which is what fixes the scan', () => {
    process.env.OPENCODE_PROPOSED_CONTENT_DIR = scanDir;
    try {
      const resolved = path.resolve(scanDir, 'src/added.ts');
      expect(existsSync(resolved)).toBe(true);
      expect(readFileSync(resolved, 'utf-8')).toContain('Hunter2Real');
    } finally {
      process.env.OPENCODE_PROPOSED_CONTENT_DIR = undefined;
    }
  });

  it('reports the base-only reader as unreadable, not clean', () => {
    // Without the proposed directory, the pass that reads only the base
    // checkout cannot see the added file. The ledger must say UNSCANNED for
    // it rather than reporting a clean scan.
    const ledger = new CoverageLedger();
    const files = ['src/added.ts', 'src/existing.ts'];
    const readable = files.filter((f) => existsSync(path.join(baseDir, f)));
    ledger.recordCounts(
      'secrets.review',
      readable.length,
      files.length - readable.length,
      0,
      'ENOENT for PR-added files',
    );

    const trust = buildReviewTrust(ledger, { headSha: repo.headSha });
    expect(trust.unreadableInputs).toBe(1);
    expect(trust.exhaustive).toBe(false);
    expect(trust.failedClosed).toBe(true);
    expect(trust.statement).toContain('UNSCANNED');
  });

  it('detects a stale anchor when the file really shifted between base and head', async () => {
    // `export const a = 1` is line 1 at base and line 4 at head. A finding
    // captured at base line 1 must be marked stale against the head commit —
    // the real-world shape of the +111/+139 anchor drift.
    process.env.OPENCODE_PROPOSED_CONTENT_DIR = scanDir;
    try {
      const readFileAt = async (file: string): Promise<string | undefined> => {
        const candidate = path.resolve(scanDir, file);
        return candidate.startsWith(scanDir + path.sep) && existsSync(candidate)
          ? readFileSync(candidate, 'utf-8')
          : undefined;
      };

      // Captured against the BASE copy: line 1 held the export.
      const issues = [
        {
          file: 'src/existing.ts',
          line: 1,
          anchorText: 'export const a = 1;',
        },
        // Correctly anchored against HEAD: the export is line 4 there.
        {
          file: 'src/existing.ts',
          line: 4,
          anchorText: 'export const a = 1;',
        },
      ];

      const counts = await resolveIssueAnchors(issues, repo.headSha, readFileAt);

      expect(issues[0].anchorStatus).toBe('stale-anchor');
      expect(issues[0].anchorNote).toContain('no longer holds');
      expect(issues[1].anchorStatus).toBe('ok');
      expect(counts.stale).toBe(1);
      expect(counts.checked).toBe(1);
    } finally {
      process.env.OPENCODE_PROPOSED_CONTENT_DIR = undefined;
    }
  });

  it('marks a finding stale when its file does not exist at the reviewed commit', async () => {
    const readFileAt = async (file: string): Promise<string | undefined> =>
      file === 'src/added.ts' ? readFileSync(path.join(scanDir, file), 'utf-8') : undefined;

    const issues = [{ file: 'src/gone.ts', line: 1, anchorText: 'anything' }];
    const counts = await resolveIssueAnchors(issues, repo.headSha, readFileAt);

    expect(issues[0].anchorStatus).toBe('stale-anchor');
    expect(counts.stale).toBe(1);
  });
});
