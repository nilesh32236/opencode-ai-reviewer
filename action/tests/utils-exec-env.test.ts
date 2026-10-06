import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@actions/core')>();
  return {
    ...mod,
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
  };
});

vi.mock('@actions/github', () => ({
  context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
}));

import { execWithTimeout } from '../src/utils.js';

/** Minimal fake child so the injected runner never spawns a real process. */
function fakeChild() {
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 1234,
  };
  return child;
}

/** Capture the options the injected runner was called with. */
function captureRunner() {
  const calls: { args: string[]; options: Record<string, unknown> }[] = [];
  const runner = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ args: [command, ...args], options });
    // Resolve asynchronously so the spawn wiring settles before assertions.
    queueMicrotask(() => {
      for (const call of (child.on as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
        if (call[0] === 'close') (call[1] as (code: number) => void)(0);
      }
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { runner, calls };
}

let child: ReturnType<typeof fakeChild>;

beforeEach(() => {
  vi.clearAllMocks();
  child = fakeChild();
});

describe('execWithTimeout child environment isolation', () => {
  // Verification commands run repo-controlled code (arbitrary
  // `run_checks_after_fix` steps, postinstall hooks). This helper spawned with
  // no `env` option, so every child inherited the full `process.env` —
  // GITHUB_TOKEN and every provider API key — while the app wrapper already
  // isolated the same class of subprocess.
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'ghp_super_secret';
    process.env.OPENCODE_API_KEY = 'opencode-secret';
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
  });

  afterEach(() => {
    for (const key of ['GITHUB_TOKEN', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY']) {
      if (savedEnv[key] === undefined) process.env[key] = undefined;
      else process.env[key] = savedEnv[key];
    }
  });

  it('passes an explicit restricted env, never the inherited process.env', async () => {
    const { runner, calls } = captureRunner();

    await execWithTimeout('pnpm', ['test'], { runner, silent: true });

    expect(calls).toHaveLength(1);
    const env = calls[0].options.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('ghp_super_secret');
    expect(JSON.stringify(env)).not.toContain('opencode-secret');
  });

  it('still forwards PATH so the bare executable can resolve', async () => {
    const { runner, calls } = captureRunner();

    await execWithTimeout('pnpm', ['test'], { runner, silent: true });

    const env = calls[0].options.env as Record<string, string>;
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('honours an explicit env override for callers that need one', async () => {
    const { runner, calls } = captureRunner();

    await execWithTimeout('pnpm', ['test'], {
      runner,
      silent: true,
      env: { PATH: '/custom/bin', GIT_ASKPASS: 'echo' },
    });

    expect(calls[0].options.env).toEqual({ PATH: '/custom/bin', GIT_ASKPASS: 'echo' });
  });

  it('reports the command failure without ever echoing the child env', async () => {
    const { runner } = captureRunner();
    const warn = vi.mocked(core.warning);

    const result = await execWithTimeout('pnpm', ['test'], { runner, silent: true });

    expect(result.exitCode).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('ghp_super_secret');
  });
});
