/**
 * GitHub webhook receiver for the platform.
 *
 * Verifies the X-Hub-Signature-256 HMAC against the configured webhook secret,
 * deduplicates deliveries by their unique X-GitHub-Delivery id, and enqueues
 * review/fix/audit tasks to the BullMQ queue. The receiver is intentionally
 * stateless (all state lives in Postgres + the queue) so a restart never loses
 * a delivery.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@opencode-pr-agent/lib';
import type { Request, Response } from 'express';
import type { PlatformDb } from './db/client.js';
import type { TaskQueue } from './queue/manager.js';
import type { PlatformTaskType, TaskJobData } from './queue/types.js';

const logger = new Logger('WebhookReceiver');

/** Webhook events we turn into review tasks. */
const TASK_EVENTS = new Set(['pull_request', 'issue_comment']);

/** Comment commands that trigger a task. */
const COMMAND_TASKS: Record<string, PlatformTaskType> = {
  review: 'review',
  fix: 'fix',
  audit: 'audit',
  analyze: 'analyze',
  docs: 'docs',
};

/**
 * Verify an X-Hub-Signature-256 HMAC header using a timing-safe comparison.
 * @param payload - The raw request body (Buffer).
 * @param signatureHeader - The signature header value, or undefined.
 * @param secret - The webhook secret.
 * @returns True when the signature is valid.
 */
export function verifyWebhookSignature(
  payload: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Extract a task to enqueue from a webhook payload, or null when the event
 * should not trigger a task.
 * @param eventName - The GitHub event name (e.g. 'pull_request').
 * @param payload - The parsed webhook payload.
 * @returns The task job data, or null.
 */
export function eventToTask(
  eventName: string,
  payload: Record<string, unknown>,
): TaskJobData | null {
  if (eventName === 'pull_request') {
    const action = typeof payload.action === 'string' ? payload.action : '';
    // Only opened / synchronize trigger a review; closed/merged is handled by
    // lifecycle cleanup (Chunk 5.5) and does not enqueue work.
    if (action !== 'opened' && action !== 'synchronize' && action !== 'reopened') return null;
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (!pr) return null;
    const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as
      | string
      | undefined;
    if (!repo) return null;
    const prHead = (pr.head ?? {}) as Record<string, unknown>;
    const prBase = (pr.base ?? {}) as Record<string, unknown>;
    return {
      repo,
      type: 'review',
      prNumber: typeof pr.number === 'number' ? pr.number : undefined,
      prTitle: typeof pr.title === 'string' ? pr.title : undefined,
      headSha: typeof prHead.sha === 'string' ? prHead.sha : undefined,
      baseBranch: typeof prBase.ref === 'string' ? prBase.ref : undefined,
      headBranch: typeof prHead.ref === 'string' ? prHead.ref : undefined,
      triggerSource: 'webhook',
    };
  }

  if (eventName === 'issue_comment') {
    const comment = payload.comment as Record<string, unknown> | undefined;
    const body = typeof comment?.body === 'string' ? comment.body : '';
    const command = body.trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase();
    const type = COMMAND_TASKS[command];
    if (!type) return null;
    const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as
      | string
      | undefined;
    if (!repo) return null;
    const issue = payload.issue as Record<string, unknown> | undefined;
    const prNumber = typeof issue?.number === 'number' ? (issue.number as number) : undefined;
    return {
      repo,
      type,
      prNumber,
      issueNumber: prNumber,
      triggerSource: 'webhook',
    };
  }

  return null;
}

/**
 * Handle an incoming webhook: verify, dedup, and enqueue.
 * @param eventName - GitHub event name (from the X-GitHub-Event header).
 * @param deliveryId - Unique delivery id (X-GitHub-Delivery header).
 * @param signatureHeader - The X-Hub-Signature-256 header value.
 * @param rawBody - The raw request body Buffer.
 * @param db - The platform database (for delivery dedup).
 * @param queue - The task queue.
 * @param webhookSecret - The configured webhook secret (undefined = skip verification).
 * @returns An HTTP status code and message for the response.
 */
export async function handleWebhook(
  eventName: string,
  deliveryId: string,
  signatureHeader: string | undefined,
  rawBody: Buffer,
  db: PlatformDb,
  queue: TaskQueue,
  webhookSecret: string | undefined,
): Promise<{ status: number; message: string }> {
  if (webhookSecret) {
    if (!signatureHeader) {
      return { status: 401, message: 'Missing signature' };
    }
    if (!verifyWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
      logger.warn(`Webhook signature verification failed (delivery ${deliveryId})`);
      return { status: 401, message: 'Invalid signature' };
    }
  }

  // Dedup: skip deliveries we have already processed.
  const seen = await db.queryOne<{ id: string }>(
    'SELECT id FROM webhook_events WHERE delivery_id = $1',
    [deliveryId],
  );
  if (seen) {
    return { status: 200, message: 'Duplicate delivery ignored' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
  } catch {
    return { status: 400, message: 'Invalid JSON payload' };
  }

  const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as
    | string
    | undefined;

  // Persist the delivery (best-effort) so redeliveries are deduped even if a
  // later step fails. Insert conflicts are ignored (concurrent deliveries).
  try {
    await db.execute(
      `INSERT INTO webhook_events (delivery_id, event_type, repo, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, eventName, repo ?? 'unknown', JSON.stringify(payload)],
    );
  } catch (err) {
    logger.warn(
      `Failed to record webhook delivery ${deliveryId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!TASK_EVENTS.has(eventName)) {
    return { status: 200, message: 'Event not handled' };
  }

  const task = eventToTask(eventName, payload);
  if (!task) {
    return { status: 200, message: 'Event does not trigger a task' };
  }

  try {
    await queue.enqueue(task);
  } catch (err) {
    logger.error(
      `Failed to enqueue task for delivery ${deliveryId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: 500, message: 'Failed to enqueue task' };
  }

  logger.info(`Enqueued ${task.type} task for ${task.repo} (delivery ${deliveryId})`);
  return { status: 200, message: `Queued ${task.type}` };
}

/**
 * Express route handler for the webhook endpoint.
 * @param db - The platform database.
 * @param queue - The task queue.
 * @param webhookSecret - The configured webhook secret.
 * @returns An Express request handler for POST /webhooks/github.
 */
export function createWebhookHandler(
  db: PlatformDb,
  queue: TaskQueue,
  webhookSecret: string | undefined,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const eventName = req.header('x-github-event') ?? '';
    const deliveryId = req.header('x-github-delivery') ?? 'unknown';
    const signatureHeader = req.header('x-hub-signature-256') ?? undefined;
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    const { status, message } = await handleWebhook(
      eventName,
      deliveryId,
      signatureHeader,
      rawBody,
      db,
      queue,
      webhookSecret,
    );
    res.status(status).json({ ok: status < 400, message });
  };
}
