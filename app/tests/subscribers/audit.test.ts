import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAudit } from '../../src/handlers/audit.js';
import { createAuditSubscriber } from '../../src/subscribers/audit.js';

vi.mock('../../src/handlers/audit.js', () => ({
  handleAudit: vi.fn(),
}));

const { mockPostOrUpdateComment } = vi.hoisted(() => ({
  mockPostOrUpdateComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn().mockImplementation(
      class {
        postOrUpdateComment = mockPostOrUpdateComment;
      },
    ),
  };
});

const mockedHandleAudit = vi.mocked(handleAudit);

function makeEvent(
  body: string,
  opts: { authorAssociation?: string; issue?: number; pr?: number; repo?: string } = {},
): GitHubEvent {
  const payload: Record<string, unknown> = {
    comment: {
      body,
      author_association: opts.authorAssociation,
      user: { login: 'octocat', type: 'User' },
    },
  };
  if (opts.issue !== undefined) payload.issue = { number: opts.issue };
  if (opts.pr !== undefined) payload.pull_request = { number: opts.pr };
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: opts.repo ?? 'owner/repo',
    prNumber: opts.pr ?? opts.issue ?? 0,
    payload,
  };
}

describe('AuditSubscriber repo/denial gates', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleAudit.mockReset();
    mockedHandleAudit.mockResolvedValue(undefined as never);
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue(undefined);
  });

  it('denied repo short-circuits before handleAudit', async () => {
    const sub = createAuditSubscriber(null as never, DEFAULT_CONFIG, undefined, {
      allowed: new Set(),
      denied: new Set(['owner/repo']),
    });
    await sub.handle(makeEvent('/audit', { authorAssociation: 'OWNER', issue: 7 }));
    expect(mockedHandleAudit).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('unprivileged /audit on a PR posts denial via pull_request fallback', async () => {
    const sub = createAuditSubscriber(null as never, DEFAULT_CONFIG);
    await sub.handle(makeEvent('/audit', { authorAssociation: 'NONE', pr: 99 }));
    expect(mockedHandleAudit).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      99,
      '<!-- permission-denied:audit -->',
      expect.stringContaining('/audit'),
    );
  });

  it('unprivileged /audit falls back to event.prNumber when no issue/pr payload', async () => {
    const sub = createAuditSubscriber(null as never, DEFAULT_CONFIG);
    await sub.handle(makeEvent('/audit', { authorAssociation: 'CONTRIBUTOR' }));
    // prNumber defaults to 0 here (no issue/pr) -> central guard no-ops cleanly
    expect(mockedHandleAudit).not.toHaveBeenCalled();
  });
});
