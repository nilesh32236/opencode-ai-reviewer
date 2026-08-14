import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventToTask, verifyWebhookSignature } from '../src/webhooks.js';

const SECRET = 'test-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyWebhookSignature', () => {
  const body = Buffer.from('{"hello":"world"}');

  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(body, sign(body.toString()), SECRET)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifyWebhookSignature(body, 'sha256=deadbeef', SECRET)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a signature with the wrong secret', () => {
    expect(verifyWebhookSignature(body, sign(body.toString(), 'wrong'), SECRET)).toBe(false);
  });
});

describe('eventToTask', () => {
  it('maps a pull_request opened event to a review task', () => {
    const task = eventToTask('pull_request', {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      pull_request: {
        number: 42,
        title: 'Fix bug',
        head: { sha: 'abc123', ref: 'feature/x' },
        base: { ref: 'main' },
      },
    });
    expect(task).toEqual({
      repo: 'acme/app',
      type: 'review',
      prNumber: 42,
      prTitle: 'Fix bug',
      headSha: 'abc123',
      baseBranch: 'main',
      headBranch: 'feature/x',
      triggerSource: 'webhook',
    });
  });

  it('ignores pull_request events that are not opened/synchronize/reopened', () => {
    expect(
      eventToTask('pull_request', {
        action: 'closed',
        repository: { full_name: 'acme/app' },
        pull_request: { number: 42 },
      }),
    ).toBeNull();
  });

  it('maps a /review comment to a review task', () => {
    const task = eventToTask('issue_comment', {
      repository: { full_name: 'acme/app' },
      issue: { number: 7 },
      comment: { body: '/review' },
    });
    expect(task).toEqual({
      repo: 'acme/app',
      type: 'review',
      prNumber: 7,
      issueNumber: 7,
      triggerSource: 'webhook',
    });
  });

  it('maps a /fix comment to a fix task', () => {
    const task = eventToTask('issue_comment', {
      repository: { full_name: 'acme/app' },
      issue: { number: 9 },
      comment: { body: '/fix --force' },
    });
    expect(task?.type).toBe('fix');
  });

  it('ignores non-command comments', () => {
    expect(
      eventToTask('issue_comment', {
        repository: { full_name: 'acme/app' },
        issue: { number: 1 },
        comment: { body: 'just a comment' },
      }),
    ).toBeNull();
  });

  it('returns null for unknown events', () => {
    expect(eventToTask('ping', { repository: { full_name: 'acme/app' } })).toBeNull();
  });
});
