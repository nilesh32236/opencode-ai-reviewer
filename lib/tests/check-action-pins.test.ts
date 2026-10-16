import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const guard = path.join(repoRoot, 'scripts', 'check-action-pins.mjs');

const KNOWN_CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const KNOWN_SETUP_SHA = '820762786026740c76f36085b0efc47a31fe5020';

function makeActionYml(using = 'node24'): string {
  return `name: x\nruns:\n  using: '${using}'\n  main: 'action/lib/index.js'\n`;
}

function runGuard(opts: {
  workflowsDir?: string;
  actionYml?: string;
  env?: Record<string, string>;
  args?: string[];
}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [guard, ...(opts.args ?? [])], {
    env: {
      ...process.env,
      // Hermetic defaults: never inherit ambient overrides that could flake
      // the suite (e.g. an exported CHECK_ACTION_PINS=strict).
      CHECK_ACTION_PINS: '',
      CHECK_ACTION_PINS_WORKFLOWS_DIR: '',
      CHECK_ACTION_PINS_ACTION_YML: '',
      ...(opts.workflowsDir !== undefined
        ? { CHECK_ACTION_PINS_WORKFLOWS_DIR: opts.workflowsDir }
        : {}),
      ...(opts.actionYml !== undefined ? { CHECK_ACTION_PINS_ACTION_YML: opts.actionYml } : {}),
      ...(opts.env ?? {}),
    },
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  // Non-zero sentinel: a spawn-side failure (ENOENT/EACCES) must never be
  // conflated with a successful "guard passed" (exit 0).
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function fixture(opts: { workflow: string; actionYml?: string }): {
  dir: string;
  actionYml: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'action-pins-wf-'));
  writeFileSync(path.join(dir, 'ci.yml'), opts.workflow);
  const actionFile = path.join(dir, 'action.yml');
  writeFileSync(actionFile, opts.actionYml ?? makeActionYml('node24'));
  return {
    dir,
    actionYml: actionFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('check-action-pins guard', () => {
  it('passes v7 tags and known v7 SHAs with drift=0', () => {
    const f = fixture({
      workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n      - uses: actions/setup-node@v7\n      - uses: actions/checkout@${KNOWN_CHECKOUT_SHA} # v7\n      - uses: actions/setup-node@${KNOWN_SETUP_SHA}\n`,
    });
    try {
      const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('drift=0');
    } finally {
      f.cleanup();
    }
  });

  it('warns (exit 0) on v6 drift in default mode', () => {
    const f = fixture({
      workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v6\n`,
    });
    try {
      const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::');
      expect(r.stdout).toMatch(/drift=1/);
    } finally {
      f.cleanup();
    }
  });

  it('warns on main/master drift', () => {
    const f = fixture({
      workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@main\n      - uses: actions/setup-node@master\n`,
    });
    try {
      const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::');
    } finally {
      f.cleanup();
    }
  });

  it('treats unknown SHA with "# v7" comment as drift (no comment bypass)', () => {
    const unknown = 'a'.repeat(40);
    const f = fixture({
      workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${unknown} # v7\n`,
    });
    try {
      const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::');
      expect(r.stdout).not.toContain('drift=0');
    } finally {
      f.cleanup();
    }
  });

  it('fails open (exit 0) on missing workflows dir without claiming all-clean', () => {
    const actionFile = path.join(mkdtempSync(path.join(tmpdir(), 'action-pins-')), 'action.yml');
    writeFileSync(actionFile, makeActionYml('node24'));
    try {
      const r = runGuard({
        workflowsDir: path.join(tmpdir(), `does-not-exist-${Date.now()}`),
        actionYml: actionFile,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::');
      expect(r.stdout).toContain('some checks skipped');
      expect(r.stdout).not.toContain('all pins on the v7/node24 line');
    } finally {
      rmSync(path.dirname(actionFile), { recursive: true, force: true });
    }
  });

  it('reports skipped (not all-clean) on missing workflows dir in strict mode', () => {
    const actionFile = path.join(mkdtempSync(path.join(tmpdir(), 'action-pins-')), 'action.yml');
    writeFileSync(actionFile, makeActionYml('node24'));
    try {
      const r = runGuard({
        workflowsDir: path.join(tmpdir(), `does-not-exist-${Date.now()}`),
        actionYml: actionFile,
        env: { CHECK_ACTION_PINS: 'strict' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('some checks skipped');
      expect(r.stdout).not.toContain('all pins on the v7/node24 line');
    } finally {
      rmSync(path.dirname(actionFile), { recursive: true, force: true });
    }
  });

  it('exits 1 on drift in strict mode', () => {
    const f = fixture({
      workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v6\n`,
    });
    try {
      const r = runGuard({
        workflowsDir: f.dir,
        actionYml: f.actionYml,
        env: { CHECK_ACTION_PINS: 'strict' },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('::error::');
    } finally {
      f.cleanup();
    }
  });

  it('exits 0 with drift=0 in strict mode when clean', () => {
    const f = fixture({
      workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n`,
    });
    try {
      const r = runGuard({
        workflowsDir: f.dir,
        actionYml: f.actionYml,
        env: { CHECK_ACTION_PINS: 'strict' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('drift=0');
    } finally {
      f.cleanup();
    }
  });

  it('ignores using: in comments and descriptions (no false positive/negative)', () => {
    // Comment claims node20 but real runtime is node24 → must pass.
    const dir = mkdtempSync(path.join(tmpdir(), 'action-pins-runs-'));
    const wfDir = path.join(dir, 'wf');
    mkdirSync(wfDir);
    writeFileSync(
      path.join(wfDir, 'ci.yml'),
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n`,
    );
    const okYml = path.join(dir, 'ok.yml');
    writeFileSync(
      okYml,
      `name: x\ndescription: '# comment using: node20'\nruns:\n  using: 'node24'\n  main: 'action/lib/index.js'\n`,
    );
    // Comment claims node24 but real runtime is node20 → must warn.
    const badYml = path.join(dir, 'bad.yml');
    writeFileSync(
      badYml,
      `name: x\n# using: node24\nruns:\n  using: 'node20'\n  main: 'action/lib/index.js'\n`,
    );
    try {
      const ok = runGuard({ workflowsDir: wfDir, actionYml: okYml });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('drift=0');
      const bad = runGuard({ workflowsDir: wfDir, actionYml: badYml });
      expect(bad.status).toBe(0);
      expect(bad.stdout).toContain("runs.using is 'node20'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('documents fixture env overrides in --help', () => {
    const r = runGuard({ args: ['--help'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CHECK_ACTION_PINS_WORKFLOWS_DIR');
    expect(r.stdout).toContain('CHECK_ACTION_PINS_ACTION_YML');
  });

  it('flags non-node runtimes (composite/docker) as drift', () => {
    for (const using of ['composite', 'docker', 'node20']) {
      const f = fixture({
        workflow: `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n`,
        actionYml: makeActionYml(using),
      });
      try {
        const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`runs.using is '${using}'`);
        expect(r.stdout).not.toContain('drift=0');
      } finally {
        f.cleanup();
      }
    }
  });

  it('ignores commented-out pins', () => {
    const f = fixture({
      workflow: `# - uses: actions/checkout@v6\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n`,
    });
    try {
      const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('drift=0');
      expect(r.stdout).not.toContain('::warning::');
    } finally {
      f.cleanup();
    }
  });

  it('ignores pins in trailing comments and run: strings', () => {
    const f = fixture({
      workflow:
        `jobs:\n  a:\n    steps:\n` +
        `      - uses: actions/checkout@v7 # docs: actions/checkout@v6 legacy\n` +
        `      - run: echo actions/checkout@v6\n` +
        `      - name: uses: actions/setup-node@v6 in a name\n`,
    });
    try {
      const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('drift=0');
      expect(r.stdout).not.toContain('::warning::');
    } finally {
      f.cleanup();
    }
  });

  it('rejects a v7 SHA pinned to the wrong action (action-keyed allowlist)', () => {
    // The two v7 SHAs are individually trusted, but only for their own
    // action. A copy/paste swap would fetch the wrong action and fail at
    // runtime, so it must count as drift.
    const f = fixture({
      workflow:
        `jobs:\n  a:\n    steps:\n` +
        `      - uses: actions/checkout@${KNOWN_SETUP_SHA} # v7\n` +
        `      - uses: actions/setup-node@${KNOWN_CHECKOUT_SHA} # v7\n`,
    });
    try {
      const r = runGuard({ workflowsDir: f.dir, actionYml: f.actionYml });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::');
      expect(r.stdout).toMatch(/drift=2/);
      expect(r.stdout).not.toContain('drift=0');
    } finally {
      f.cleanup();
    }
  });

  it('scans the real repository and stays fail-open', () => {
    // runGuard with no overrides falls back to the repo's own
    // .github/workflows dir and root action.yml. This proves the guard
    // actually read the live tree (rather than exiting 0 on a broken path):
    // the repo pins checkout/setup-node on the v7 line and action.yml declares
    // node24, so the scan must report recognized pins and the runtime.
    const r = runGuard({});
    // Fail-open contract: the guard is warn-only by default, so real drift
    // must surface as an annotation, never a failure. We deliberately do NOT
    // assert the absence of warnings, so a future drift still exits 0.
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('workflows dir missing');
    expect(r.stdout).not.toContain('action.yml missing');
    expect(r.stdout).toContain('runtime ok: action.yml runs.using is node24');
    expect(r.stdout).toMatch(/pinned ok: actions\/checkout@/);
    expect(r.stdout).toMatch(/pinned ok: actions\/setup-node@/);
    expect(r.stdout).toContain('check-action-pins: done');
  });
});
