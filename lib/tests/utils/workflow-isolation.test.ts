import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_DEFAULT_MODEL,
  WORKFLOW_FORBIDDEN_SECRET_NAMES,
  WORKFLOW_TRUSTED_GIT_CONFIG_ARGS,
  assertWorkflowSafeEnv,
  buildTrustedGitEnv,
  buildWorkflowAgentEnv,
  buildWorkflowVerifyEnv,
  isForbiddenWorkflowEnvKey,
  resolveWorkflowProviderKey,
} from '../../src/utils/workflow-isolation.js';

const SECRET_SOURCE: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  NODE_ENV: 'test',
  CI: 'true',
  HOME: '/home/runner',
  GITHUB_TOKEN: 'ghs_secret',
  GH_TOKEN: 'ghs_secret',
  OPENCODE_API_KEY: 'opencode-secret',
  OPENAI_API_KEY: 'openai-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  GEMINI_API_KEY: 'gemini-secret',
  GIT_ASKPASS: '/tmp/evil-askpass',
  NPM_CONFIG_CACHE: '/tmp/npm-cache',
  NPM_CONFIG_AUTH_TOKEN: 'npm-secret',
};

describe('resolveWorkflowProviderKey', () => {
  it('preserves the current default model mapping', () => {
    expect(resolveWorkflowProviderKey(WORKFLOW_DEFAULT_MODEL)).toEqual({
      provider: 'opencode',
      keyName: 'OPENCODE_API_KEY',
    });
  });

  it('maps known providers deterministically', () => {
    expect(resolveWorkflowProviderKey('anthropic/claude-x').keyName).toBe('ANTHROPIC_API_KEY');
    expect(resolveWorkflowProviderKey('openai/gpt-4o').keyName).toBe('OPENAI_API_KEY');
    expect(resolveWorkflowProviderKey('gemini/gemini-2.0').keyName).toBe('GEMINI_API_KEY');
    expect(resolveWorkflowProviderKey('openrouter/x/y').keyName).toBe('OPENROUTER_API_KEY');
  });

  it('fails closed on empty, malformed, and unknown providers (no substitution)', () => {
    expect(() => resolveWorkflowProviderKey('')).toThrow(/empty model/);
    expect(() => resolveWorkflowProviderKey('not-a-model')).toThrow(/malformed/);
    expect(() => resolveWorkflowProviderKey('unknownprovider/some-model')).toThrow(
      /unknown provider/,
    );
  });
});

describe('buildWorkflowVerifyEnv', () => {
  it('drops all GitHub/provider secrets and credential helpers', () => {
    const env = buildWorkflowVerifyEnv(SECRET_SOURCE);
    for (const forbidden of WORKFLOW_FORBIDDEN_SECRET_NAMES) {
      expect(env[forbidden]).toBeUndefined();
    }
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    // Safe tool config survives.
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.NPM_CONFIG_CACHE).toBe('/tmp/npm-cache');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('does not carry the runner HOME auth directory by default', () => {
    const env = buildWorkflowVerifyEnv(SECRET_SOURCE);
    expect(env.HOME).toBeUndefined();
  });

  it('accepts an explicit isolated HOME override but rejects secret overrides', () => {
    const env = buildWorkflowVerifyEnv(SECRET_SOURCE, {
      HOME: '/tmp/isolated-home',
      OPENCODE_API_KEY: 'smuggled',
      GITHUB_TOKEN: 'smuggled',
    });
    expect(env.HOME).toBe('/tmp/isolated-home');
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('drops scoped npm auth material', () => {
    const env = buildWorkflowVerifyEnv(SECRET_SOURCE);
    expect(env.NPM_CONFIG_AUTH_TOKEN).toBeUndefined();
  });
});

describe('buildWorkflowAgentEnv', () => {
  it('forwards exactly one provider key for the selected model', () => {
    const env = buildWorkflowAgentEnv(WORKFLOW_DEFAULT_MODEL, SECRET_SOURCE);
    expect(env.OPENCODE_API_KEY).toBe('opencode-secret');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it('fails closed when the required key is missing (no fallback)', () => {
    const { OPENCODE_API_KEY: _dropped, ...withoutKey } = SECRET_SOURCE;
    expect(() => buildWorkflowAgentEnv(WORKFLOW_DEFAULT_MODEL, withoutKey)).toThrow(
      /missing required credential/,
    );
  });

  it('fails closed on unknown provider', () => {
    expect(() => buildWorkflowAgentEnv('unknown/model', SECRET_SOURCE)).toThrow(/unknown provider/);
  });
});

describe('assertWorkflowSafeEnv / isForbiddenWorkflowEnvKey', () => {
  it('denies secret-bearing env for repo-controlled commands', () => {
    expect(isForbiddenWorkflowEnvKey('GITHUB_TOKEN')).toBe(true);
    expect(isForbiddenWorkflowEnvKey('GH_TOKEN')).toBe(true);
    expect(isForbiddenWorkflowEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isForbiddenWorkflowEnvKey('MY_SECRET')).toBe(true);
    expect(isForbiddenWorkflowEnvKey('PATH')).toBe(false);
    expect(() => assertWorkflowSafeEnv({ PATH: 'x', GITHUB_TOKEN: 'y' })).toThrow(/secret-bearing/);
    expect(() => assertWorkflowSafeEnv({ PATH: 'x', NPM_CONFIG_AUTH_TOKEN: 'y' })).toThrow();
  });
});

describe('buildTrustedGitEnv', () => {
  it('builds an auditable trusted push env with hooks disabled', () => {
    const env = buildTrustedGitEnv('ghs_trusted', '/tmp/askpass.sh', SECRET_SOURCE);
    expect(env.GH_TOKEN).toBe('ghs_trusted');
    expect(env.GIT_ASKPASS).toBe('/tmp/askpass.sh');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(WORKFLOW_TRUSTED_GIT_CONFIG_ARGS).toContain('core.hooksPath=/dev/null');
  });

  it('denies push on missing token or ask-pass setup (fail-closed)', () => {
    expect(() => buildTrustedGitEnv('', '/tmp/askpass.sh', SECRET_SOURCE)).toThrow(
      /missing GitHub token/,
    );
    expect(() => buildTrustedGitEnv('tok', '', SECRET_SOURCE)).toThrow(/missing GIT_ASKPASS/);
  });
});
