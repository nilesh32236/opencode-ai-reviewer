import { describe, expect, it } from 'vitest';
import {
  assertNoWorkflowSecrets,
  buildTrustedGitEnv,
  buildWorkflowModelEnv,
  buildWorkflowVerifyEnv,
  getWorkflowForbiddenEnvKeys,
  hasTrustedGitHookSuppression,
  resolveWorkflowProviderKeyName,
} from '../../src/utils/workflow-isolation.js';

describe('getWorkflowForbiddenEnvKeys', () => {
  it('flags GitHub, provider, and runner-poisoning keys', () => {
    expect(
      getWorkflowForbiddenEnvKeys({
        GITHUB_TOKEN: 'x',
        GH_TOKEN: 'x',
        OPENCODE_API_KEY: 'x',
        OPENAI_API_KEY: 'x',
        ANTHROPIC_API_KEY: 'x',
        GEMINI_API_KEY: 'x',
        GITHUB_ENV: '/tmp/x',
        GITHUB_PATH: '/tmp/y',
        BASH_ENV: '/tmp/z',
        GIT_ASKPASS: '/tmp/ask',
        PATH: '/usr/bin',
      }),
    ).toEqual([
      'ANTHROPIC_API_KEY',
      'BASH_ENV',
      'GEMINI_API_KEY',
      'GH_TOKEN',
      'GITHUB_ENV',
      'GITHUB_PATH',
      'GITHUB_TOKEN',
      'GIT_ASKPASS',
      'OPENAI_API_KEY',
      'OPENCODE_API_KEY',
    ]);
  });

  it('returns empty for a clean verify env', () => {
    expect(getWorkflowForbiddenEnvKeys({ PATH: '/usr/bin', CI: 'true' })).toEqual([]);
  });
});

describe('assertNoWorkflowSecrets', () => {
  it('denies secret-bearing env (fail closed)', () => {
    expect(() => assertNoWorkflowSecrets({ GITHUB_TOKEN: 'x' })).toThrow(/secret-bearing env/);
    expect(() => assertNoWorkflowSecrets({ OPENAI_API_KEY: 'x' })).toThrow();
  });

  it('denies secret-shaped scoped config keys', () => {
    expect(() =>
      assertNoWorkflowSecrets({ NPM_CONFIG_AUTH_TOKEN: 'x' } as Record<string, string>),
    ).toThrow(/secret-shaped/);
  });

  it('allows safe tool config', () => {
    expect(() =>
      assertNoWorkflowSecrets({ PATH: '/usr/bin', NPM_CONFIG_CACHE: '/tmp/npm' }),
    ).not.toThrow();
  });
});

describe('buildWorkflowVerifyEnv', () => {
  it('builds an allowlist child env with a fresh HOME and no secrets', () => {
    const child = buildWorkflowVerifyEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/cred-bearing',
        GITHUB_TOKEN: 'smuggled',
        OPENAI_API_KEY: 'smuggled',
        GH_TOKEN: 'smuggled',
        NPM_CONFIG_CACHE: '/tmp/npm',
        NPM_CONFIG_AUTH_TOKEN: 'smuggled',
        GITHUB_ENV: '/tmp/github_env',
        BASH_ENV: '/tmp/bash',
      },
      { isolatedHome: '/tmp/isolated-home' },
    );
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/tmp/isolated-home');
    expect(child.XDG_CONFIG_HOME).toBe('/tmp/isolated-home/.config');
    expect(child.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(child.GITHUB_TOKEN).toBeUndefined();
    expect(child.GH_TOKEN).toBeUndefined();
    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(child.NPM_CONFIG_AUTH_TOKEN).toBeUndefined();
    expect(child.GITHUB_ENV).toBeUndefined();
    expect(child.BASH_ENV).toBeUndefined();
    expect(child.NPM_CONFIG_CACHE).toBe('/tmp/npm');
  });

  it('fails closed without an isolated HOME', () => {
    expect(() => buildWorkflowVerifyEnv({ PATH: '/usr/bin' }, { isolatedHome: '' })).toThrow(
      /isolatedHome/,
    );
  });
});

describe('resolveWorkflowProviderKeyName', () => {
  it('maps known providers deterministically and preserves the default', () => {
    expect(resolveWorkflowProviderKeyName('opencode/muse-spark-1.3-contributor-free')).toBe(
      'OPENCODE_API_KEY',
    );
    expect(resolveWorkflowProviderKeyName('openai/gpt-4o')).toBe('OPENAI_API_KEY');
    expect(resolveWorkflowProviderKeyName('anthropic/claude-sonnet-4-20250514')).toBe(
      'ANTHROPIC_API_KEY',
    );
    expect(resolveWorkflowProviderKeyName('google/gemini-2.0-flash')).toBe('GEMINI_API_KEY');
    expect(resolveWorkflowProviderKeyName('gemini/gemini-2.0-flash')).toBe('GEMINI_API_KEY');
  });

  it('fails closed on unknown providers (no guessing, no substitution)', () => {
    expect(resolveWorkflowProviderKeyName('unknownprovider/some-model')).toBeNull();
    expect(resolveWorkflowProviderKeyName('openrouter/anthropic/claude-3.5')).toBeNull();
    expect(resolveWorkflowProviderKeyName('')).toBeNull();
    expect(resolveWorkflowProviderKeyName('not-a-model')).toBeNull();
  });
});

describe('buildWorkflowModelEnv', () => {
  it('forwards exactly one provider key and no GitHub tokens', () => {
    const env = buildWorkflowModelEnv('opencode/muse-spark-1.3-contributor-free', {
      OPENCODE_API_KEY: 'k1',
      GITHUB_TOKEN: 'must-not-forward',
      OPENAI_API_KEY: 'must-not-forward',
    });
    expect(env).toEqual({ OPENCODE_API_KEY: 'k1' });
  });

  it('fails closed on unknown provider or missing key (no paid fallback)', () => {
    expect(() => buildWorkflowModelEnv('unknownprovider/m', { OPENCODE_API_KEY: 'k' })).toThrow(
      /Unknown provider/,
    );
    expect(() => buildWorkflowModelEnv('openai/gpt-4o', {})).toThrow(/Missing required provider/);
    expect(() => buildWorkflowModelEnv('openai/gpt-4o', { OPENAI_API_KEY: '' })).toThrow(
      /Missing required provider/,
    );
  });
});

describe('trusted git path', () => {
  it('builds a replace-proof, hook-suppressed env with ephemeral askpass only', () => {
    const env = buildTrustedGitEnv({
      isolatedHome: '/tmp/trusted-home',
      askPassPath: '/tmp/askpass.sh',
    });
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.HOME).toBe('/tmp/trusted-home');
    expect(env.GIT_ASKPASS).toBe('/tmp/askpass.sh');
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('fails closed without an isolated HOME (credential setup failure denies)', () => {
    expect(() => buildTrustedGitEnv({ isolatedHome: '' })).toThrow(/isolatedHome/);
  });

  it('requires explicit hook suppression in trusted git argv', () => {
    expect(
      hasTrustedGitHookSuppression([
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        'push',
        'origin',
        'x',
      ]),
    ).toBe(true);
    expect(hasTrustedGitHookSuppression(['git', 'push', 'origin', 'x'])).toBe(false);
    expect(hasTrustedGitHookSuppression(['git', '-c', 'core.hooksPath=/tmp/evil', 'push'])).toBe(
      false,
    );
  });
});
