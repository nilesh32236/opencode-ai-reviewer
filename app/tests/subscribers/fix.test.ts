import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands.js';
import { createFixSubscriber } from '../../src/subscribers/fix.js';

vi.mock('../../src/handlers/commands.js', () => ({
  handleCommand: vi.fn(),
}));

const mockedHandleCommand = vi.mocked(handleCommand);

/** Allowing stub limiter so tests exercise behavior, not rate limits. */
function makeAllowLimiter() {
  return {
    checkReview: vi.fn(async () => ({
      allowed: true,
      remaining: 10,
      resetAt: Date.now() + 60_000,
      reservationId: 'res-allow',
    })),
    recordReview: vi.fn(async () => undefined),
  } as never;
}

function makeLabeledEvent(prNumber: number, labelNames: string[]): GitHubEvent {
  return {
    type: 'issue.labeled',
    category: 'issue',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber,
    payload: {
      issue: {
        number: prNumber,
        labels: labelNames.map((name) => ({ name })),
      },
    },
  };
}

describe('FixSubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleCommand.mockReset();
    mockedHandleCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('triggers the fix command when an issue is labeled autofix-trigger', async () => {
    const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

    await sub.handle(makeLabeledEvent(123, ['autofix-trigger']));

    expect(mockedHandleCommand).toHaveBeenCalledTimes(1);
    expect(mockedHandleCommand).toHaveBeenCalledWith(
      'fix',
      123,
      'owner/repo',
      'test-token',
      expect.any(Object),
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('does not trigger the fix command for unrelated labels', async () => {
    const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

    await sub.handle(makeLabeledEvent(124, ['bug']));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('does not trigger the fix command when the labeled item is a pull request', async () => {
    const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

    await sub.handle({
      type: 'issue.labeled',
      category: 'issue',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 125,
      payload: {
        issue: {
          number: 125,
          pull_request: {},
          labels: [{ name: 'autofix-trigger' }],
        },
      },
    });

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });
});
