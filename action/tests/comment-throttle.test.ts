import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockContext, mockGetInput, mockWarning } = vi.hoisted(() => {
  const _mockContext = {
    actor: 'fallback-actor',
    payload: {} as Record<string, unknown>,
    repo: { owner: 'o', repo: 'r' },
  };
  return {
    mockContext: _mockContext,
    mockGetInput: vi.fn(),
    mockWarning: vi.fn(),
  };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  info: vi.fn(),
  warning: mockWarning,
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  saveState: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: mockContext,
}));

import {
  DEFAULT_COMMENT_THROTTLE_MS,
  MAX_COMMENT_TRIGGERS_PER_HOUR,
  checkAndRecordCommentTrigger,
  resetCommentThrottle,
} from '../src/comment-throttle.js';
import { parseCommentThrottleMs } from '../src/inputs.js';

function setCommentTrigger(actor: string, body: string, issueNumber: number): void {
  mockContext.actor = 'workflow-actor';
  mockContext.payload = {
    issue: { number: issueNumber },
    comment: { body, user: { login: actor } },
  };
}

describe('parseCommentThrottleMs()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves empty input to the default cooldown', () => {
    expect(parseCommentThrottleMs('')).toBe(DEFAULT_COMMENT_THROTTLE_MS);
    expect(parseCommentThrottleMs('   ')).toBe(DEFAULT_COMMENT_THROTTLE_MS);
  });

  it('accepts explicit values including 0 (cooldown disabled)', () => {
    expect(parseCommentThrottleMs('0')).toBe(0);
    expect(parseCommentThrottleMs('60000')).toBe(60000);
  });

  it('fails open to the default on invalid input', () => {
    expect(parseCommentThrottleMs('abc')).toBe(DEFAULT_COMMENT_THROTTLE_MS);
    expect(parseCommentThrottleMs('-5')).toBe(DEFAULT_COMMENT_THROTTLE_MS);
    expect(mockWarning).toHaveBeenCalled();
  });
});

describe('checkAndRecordCommentTrigger()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommentThrottle();
    mockGetInput.mockReturnValue('');
  });

  it('allows the first trigger and throttles an immediate duplicate', () => {
    setCommentTrigger('alice', '/fix please', 42);
    expect(checkAndRecordCommentTrigger(1_000_000, 300_000).throttled).toBe(false);
    const second = checkAndRecordCommentTrigger(1_000_001, 300_000);
    expect(second.throttled).toBe(true);
    expect(second.reason).toContain('cooldown');
  });

  it('allows the same trigger again after the cooldown elapses', () => {
    setCommentTrigger('alice', '/fix please', 42);
    expect(checkAndRecordCommentTrigger(1_000_000, 300_000).throttled).toBe(false);
    expect(checkAndRecordCommentTrigger(1_000_000 + 300_001, 300_000).throttled).toBe(false);
  });

  it('scopes the cooldown per actor, PR, and command', () => {
    setCommentTrigger('alice', '/fix please', 42);
    expect(checkAndRecordCommentTrigger(1_000_000, 300_000).throttled).toBe(false);
    // Different PR: allowed.
    setCommentTrigger('alice', '/fix please', 43);
    expect(checkAndRecordCommentTrigger(1_000_001, 300_000).throttled).toBe(false);
    // Different command: allowed.
    setCommentTrigger('alice', '/review please', 42);
    expect(checkAndRecordCommentTrigger(1_000_002, 300_000).throttled).toBe(false);
    // Different actor: allowed.
    setCommentTrigger('bob', '/fix please', 42);
    expect(checkAndRecordCommentTrigger(1_000_003, 300_000).throttled).toBe(false);
  });

  it('enforces the per-actor hourly cap across PRs', () => {
    for (let pr = 1; pr <= MAX_COMMENT_TRIGGERS_PER_HOUR; pr++) {
      setCommentTrigger('spammer', '/fix please', pr);
      // Cooldown disabled so only the hourly cap can trip.
      expect(checkAndRecordCommentTrigger(pr * 1000, 0).throttled).toBe(false);
    }
    setCommentTrigger('spammer', '/fix please', MAX_COMMENT_TRIGGERS_PER_HOUR + 1);
    const capped = checkAndRecordCommentTrigger((MAX_COMMENT_TRIGGERS_PER_HOUR + 1) * 1000, 0);
    expect(capped.throttled).toBe(true);
    expect(capped.reason).toContain('rate limit');
  });

  it('allows triggers again once the hourly window slides', () => {
    setCommentTrigger('spammer', '/fix please', 1);
    const hourMs = 60 * 60 * 1000;
    for (let i = 0; i < MAX_COMMENT_TRIGGERS_PER_HOUR; i++) {
      setCommentTrigger('spammer', '/fix please', i + 1);
      expect(checkAndRecordCommentTrigger(i * 1000, 0).throttled).toBe(false);
    }
    setCommentTrigger('spammer', '/fix please', 99);
    expect(checkAndRecordCommentTrigger(hourMs + 60_000, 0).throttled).toBe(false);
  });

  it('fails open (allows) when no author can be resolved', () => {
    // A comment payload with no author refuses the workflow-actor fallback,
    // so no stable key exists — the permission gate already failed closed.
    mockContext.actor = 'workflow-actor';
    mockContext.payload = { comment: { body: '/fix please' } };
    expect(checkAndRecordCommentTrigger(1_000_000, 300_000).throttled).toBe(false);
  });
});
