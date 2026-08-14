import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformDb } from '../src/db/client.js';
import type { TaskQueue } from '../src/queue/manager.js';
import { eventToTask, handleWebhook, verifyWebhookSignature } from '../src/webhooks.js';

const SECRET = 'test-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Minimal in-memory fake of the delivery-dedup interface. */
function makeFakeDb(): { db: PlatformDb; insertCalled: () => number } {
  let inserts = 0;
  const db = {
    queryOne: vi.fn(async (sql: string, params: unknown[]) => {
      // The atomic claim is an INSERT ... ON CONFLICT DO NOTHING RETURNING id.
      // For a duplicate delivery it returns no row (conflict); otherwise it
      // returns the claimed row.
      if (sql.includes('INSERT INTO webhook_events')) {
        const id = params[0] as string;
        return id === 'dup-delivery' ? undefined : { id: 'claimed' };
      }
      return undefined;
    }),
    execute: vi.fn(async () => {
      inserts++;
    }),
    query: vi.fn(async () => []),
    ping: vi.fn(async () => true),
  } as unknown as PlatformDb;
  return { db, insertCalled: () => inserts };
}

/** Minimal fake queue. */
function makeFakeQueue(enqueueShouldFail = false): { queue: TaskQueue; enqueued: string[] } {
  const enqueued: string[] = [];
  const queue = {
    enqueue: vi.fn(async (data: { repo: string; type: string }) => {
      if (enqueueShouldFail) throw new Error('redis down');
      enqueued.push(`${data.repo}|${data.type}`);
    }),
    close: vi.fn(async () => {}),
  } as unknown as TaskQueue;
  return { queue, enqueued };
}

function prPayload(): string {
  return JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/app' },
    pull_request: {
      number: 42,
      title: 'Fix',
      head: { sha: 'abc123', ref: 'feature/x' },
      base: { ref: 'main' },
    },
  });
}

describe('handleWebhook', () => {
  it('rejects a missing signature when a secret is configured', async () => {
    const { db } = makeFakeDb();
    const { queue } = makeFakeQueue();
    const res = await handleWebhook(
      'pull_request',
      'del-1',
      undefined,
      Buffer.from(prPayload()),
      db,
      queue,
      SECRET,
    );
    expect(res.status).toBe(401);
  });

  it('rejects an invalid signature', async () => {
    const { db } = makeFakeDb();
    const { queue } = makeFakeQueue();
    const res = await handleWebhook(
      'pull_request',
      'del-1',
      'sha256=deadbeef',
      Buffer.from(prPayload()),
      db,
      queue,
      SECRET,
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON', async () => {
    const { db } = makeFakeDb();
    const { queue } = makeFakeQueue();
    const res = await handleWebhook(
      'pull_request',
      'del-1',
      sign('not json'),
      Buffer.from('not json'),
      db,
      queue,
      SECRET,
    );
    expect(res.status).toBe(400);
  });

  it('claims a delivery and enqueues a review task', async () => {
    const { db } = makeFakeDb();
    const { queue, enqueued } = makeFakeQueue();
    const body = prPayload();
    const res = await handleWebhook(
      'pull_request',
      'del-1',
      sign(body),
      Buffer.from(body),
      db,
      queue,
      SECRET,
    );
    expect(res.status).toBe(200);
    expect(res.message).toContain('Queued');
    expect(enqueued).toContain('acme/app|review');
  });

  it('ignores duplicate deliveries without enqueueing', async () => {
    const { db } = makeFakeDb();
    const { queue, enqueued } = makeFakeQueue();
    const body = prPayload();
    const res = await handleWebhook(
      'pull_request',
      'dup-delivery',
      sign(body),
      Buffer.from(body),
      db,
      queue,
      SECRET,
    );
    expect(res.status).toBe(200);
    expect(res.message).toBe('Duplicate delivery ignored');
    expect(enqueued).toHaveLength(0);
  });

  it('returns 500 and does not swallow the delivery when enqueue fails', async () => {
    const { db } = makeFakeDb();
    const { queue } = makeFakeQueue(true);
    const body = prPayload();
    const res = await handleWebhook(
      'pull_request',
      'del-fail',
      sign(body),
      Buffer.from(body),
      db,
      queue,
      SECRET,
    );
    expect(res.status).toBe(500);
    expect(res.message).toBe('Failed to enqueue task');
  });
});

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
