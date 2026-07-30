import type { AgentConfig, PRContext } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import type { ActionInputs } from '../../src/inputs.js';

export function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Test PR',
    body: 'Test body',
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    author: 'test-user',
    labels: [],
    changedFiles: [
      {
        path: 'src/test.ts',
        status: 'modified',
        additions: 10,
        deletions: 2,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ],
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    timeoutMinutes: 10,
    ...overrides,
  };
}

export function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    mode: 'review',
    githubToken: 'test-token',
    reviewModel: DEFAULT_CONFIG.reviewModel,
    fixModel: DEFAULT_CONFIG.fixModel,
    auditModel: DEFAULT_CONFIG.auditModel,
    enableFix: false,
    maxFixIterations: 3,
    enableAudit: false,
    ...overrides,
  };
}
