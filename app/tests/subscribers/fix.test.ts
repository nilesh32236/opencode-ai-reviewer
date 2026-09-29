import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands.js';
import { createFixSubscriber } from '../../src/subscribers/fix.js';
import { clearPrivilegeVerificationCache } from '../../src/utils/privilege.js';

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
      action: 'labeled',
      label: { name: 'autofix-trigger' },
      sender: { login: 'octocat', type: 'User', author_association: 'OWNER' },
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
    clearPrivilegeVerificationCache();
    // Server-side label-actor verification: stub the collaborator-permission
    // lookup as a privileged (write) collaborator.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ permission: 'write' }) })),
    );
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
    vi.unstubAllGlobals();
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

  // The three `issue.labeled` tests below assert only that the command is NOT
  // invoked. That is a one-sided assertion: it passes whether the gate rejects
  // the actor OR the subscriber simply never reaches the command for some
  // unrelated reason. In the pre-existing tests the latter was the actual
  // cause -- `verifyCollaboratorPermission` performs a real `fetch`, which is
  // unmocked, so it throws and the handler returns regardless of the gate.
  //
  // These add the missing side: control `fetch`, prove the privileged path
  // DOES reach the command, and assert the verification was actually issued.
  // Without them, deleting the gate leaves the whole file green.
  describe('issue.labeled label-actor gate (discriminating)', () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = realFetch;
      clearPrivilegeVerificationCache();
    });

    const labeledWithSender = (sender: Record<string, unknown>, prNumber: number): GitHubEvent =>
      ({
        type: 'issue.labeled',
        category: 'issue',
        timestamp: Date.now(),
        repo: 'owner/repo',
        prNumber,
        payload: {
          action: 'labeled',
          label: { name: 'autofix-trigger' },
          sender,
          issue: { number: prNumber, labels: [{ name: 'autofix-trigger' }] },
        },
      }) as GitHubEvent;

    it('a BOT label actor reaches the command without an API call', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

      await sub.handle(labeledWithSender({ login: 'dependabot[bot]', type: 'Bot' }, 201));

      expect(mockedHandleCommand, 'a bot re-applying the label must be allowed').toHaveBeenCalled();
      expect(fetchMock, 'a bot needs no collaborator lookup').not.toHaveBeenCalled();
    });

    it('a PRIVILEGED human actor reaches the command, and is verified server-side', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ permission: 'admin' }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

      await sub.handle(
        labeledWithSender({ login: 'maintainer', type: 'User', author_association: 'MEMBER' }, 202),
      );

      expect(mockedHandleCommand, 'a verified privileged actor must be allowed').toHaveBeenCalled();
      expect(
        fetchMock,
        'the actor must be verified via the collaborators API, not trusted from the hint',
      ).toHaveBeenCalledWith(
        expect.stringContaining('/collaborators/maintainer/permission'),
        expect.anything(),
      );
    });

    it('a privileged HINT is refused when the server-side lookup denies', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

      // The payload claims OWNER. The API says no. The hint must not win --
      // this is the whole point of the server-side check.
      await sub.handle(
        labeledWithSender({ login: 'impostor', type: 'User', author_association: 'OWNER' }, 203),
      );

      expect(mockedHandleCommand, 'a forged OWNER hint reached the command').not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
    });

    it('an unprivileged actor is refused even when the API would allow it', async () => {
      // Defence in depth: the hint check runs BEFORE the API call, so a
      // non-privileged association never reaches the lookup at all.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ permission: 'admin' }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

      await sub.handle(
        labeledWithSender({ login: 'outsider', type: 'User', author_association: 'NONE' }, 204),
      );

      expect(mockedHandleCommand).not.toHaveBeenCalled();
      expect(fetchMock, 'the hint check should reject before any API call').not.toHaveBeenCalled();
    });
  });

  // NOTE: the missing-sender-login guard is deliberately NOT pinned, because
  // it is not a security control. With `senderLogin` undefined the very next
  // checks already fail closed — `isBotUser(undefined)` is false and
  // `isPrivilegedAuthor(undefined)` is false — so removing the guard leaves
  // the suite green. It is a fast-fail that produces a clearer log line, not a
  // boundary. Documented rather than forced: a test that only distinguishes
  // log wording would be false coverage of a security property.
  it('does not trigger the fix command when the labeled event has no sender login', async () => {
    const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

    await sub.handle({
      type: 'issue.labeled',
      category: 'issue',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 126,
      payload: {
        issue: {
          number: 126,
          labels: [{ name: 'autofix-trigger' }],
        },
      },
    });

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('does not trigger the fix command for an unprivileged label actor', async () => {
    const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);

    await sub.handle({
      type: 'issue.labeled',
      category: 'issue',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 127,
      payload: {
        sender: { login: 'outsider', type: 'User', author_association: 'NONE' },
        issue: {
          number: 127,
          labels: [{ name: 'autofix-trigger' }],
        },
      },
    });

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
