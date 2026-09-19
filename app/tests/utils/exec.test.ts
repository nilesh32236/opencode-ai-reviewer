import { afterEach, describe, expect, it } from 'vitest';
import { buildRestrictedEnv, redactExecOutput } from '../../src/utils/exec.js';

const RESTORE_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENCODE_API_KEY',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG__AUTH',
  'NPM_CONFIG_HTTPS_PROXY',
  'PNPM_HOME',
] as const;

const saved: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const key of RESTORE_KEYS) saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of RESTORE_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('buildRestrictedEnv', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('never forwards provider keys or tokens to repo-controlled scripts', () => {
    saveEnv();
    process.env.OPENAI_API_KEY = 'sk-test-provider-key';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.GEMINI_API_KEY = 'AIzaTestKey';
    process.env.OPENCODE_API_KEY = 'opencode-test-key';
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    process.env.GITLAB_TOKEN = 'glpat-testtoken';

    const env = buildRestrictedEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('sk-test-provider-key');
    expect(JSON.stringify(env)).not.toContain('ghp_testtoken');
  });

  it('accepts the git-auth extra pair and drops any other override', () => {
    const env = buildRestrictedEnv({
      GIT_ASKPASS: 'echo',
      GIT_TERMINAL_PROMPT: '0',
      EVIL_SMUGGLED_SECRET: 'should-be-dropped',
    });

    expect(env.GIT_ASKPASS).toBe('echo');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.EVIL_SMUGGLED_SECRET).toBeUndefined();
  });

  it('forwards safe tool-config (PATH) from the parent env', () => {
    const env = buildRestrictedEnv();

    if (process.env.PATH !== undefined) expect(env.PATH).toBe(process.env.PATH);
  });

  it('denies secret-shaped keys inside scoped tool-config prefixes', () => {
    saveEnv();
    process.env.NPM_CONFIG_CACHE = '/tmp/npm-cache';
    process.env.PNPM_HOME = '/tmp/pnpm';
    process.env.NPM_CONFIG__AUTH = 'registry-auth-token';
    process.env.NPM_CONFIG_HTTPS_PROXY = 'http://user:pass@proxy:8080';

    const env = buildRestrictedEnv();

    expect(env.NPM_CONFIG_CACHE).toBe('/tmp/npm-cache');
    expect(env.PNPM_HOME).toBe('/tmp/pnpm');
    expect(env.NPM_CONFIG__AUTH).toBeUndefined();
    expect(env.NPM_CONFIG_HTTPS_PROXY).toBeUndefined();
  });
});

describe('redactExecOutput', () => {
  it('redacts token-bearing output before it reaches log pipelines', () => {
    expect(redactExecOutput('using GITHUB_TOKEN=supersecret')).toBe(
      'using GITHUB_TOKEN=[REDACTED]',
    );
    expect(redactExecOutput('plain build output')).toBe('plain build output');
  });
});
