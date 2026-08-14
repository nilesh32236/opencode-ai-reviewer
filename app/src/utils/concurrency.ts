/**
 * Process-wide concurrency limiter for the Probot app.
 *
 * Reviews, fixes, audits, and other slash commands each spawn a resource-heavy
 * `opencode` subprocess (~550MB, CPU-bound LLM I/O). Without a global cap, the
 * EventBus dispatches up to `SUBSCRIBER_CONCURRENCY` webhook handlers at once
 * and every different repo/PR spawns its own subprocess in parallel — on a
 * small instance this oversubscribes CPU and memory and slows every review.
 *
 * A single shared semaphore limits how many heavy runs execute simultaneously
 * across ALL repos/PRs. Additional requests wait for a free slot up to a
 * bounded wait, then give up (returning a "busy" outcome) instead of hanging
 * the webhook response forever.
 *
 * The semaphore is REENTRANT: a call that runs while the caller already holds
 * the slot (e.g. `/review` → `handleCommand` → `handlePRReview`) reuses the
 * held slot instead of acquiring a second one and deadlocking. Reentrancy is
 * tracked via `AsyncLocalStorage` so it is safe across `await` boundaries.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@opencode-pr-agent/lib';

const logger = new Logger('ConcurrencyLimiter');

/** Outcome of acquiring a slot to run a heavy task. */
export interface ConcurrencyDecision {
  /** True when the caller may proceed immediately with its run. */
  acquired: boolean;
  /** Human-readable reason when the run was not started. */
  reason?: string;
}

/** Per-async-context slot state used to make acquisition reentrant. */
interface SlotState {
  /** Release function for the held slot. */
  release: () => void;
}

const slotContext = new AsyncLocalStorage<SlotState>();

/**
 * A simple async semaphore that limits concurrent executions to `limit`.
 * No external dependency — a promise-queue FIFO.
 *
 * Acquisition is reentrant per async context: if the current execution chain
 * already holds a slot (tracked by {@link slotContext}), a nested acquire
 * returns immediately without taking a second slot, so callers that delegate
 * (e.g. `/review` → `handlePRReview`) never deadlock themselves.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param limit - Maximum number of concurrent executions (>= 1).
   */
  constructor(private readonly limit: number) {
    if (limit < 1) {
      throw new Error(`Semaphore limit must be >= 1, got ${limit}`);
    }
  }

  /**
   * Acquire a slot, waiting for one to free up. When the caller already holds
   * a slot in the current async context, this returns the existing release
   * (no second slot is taken), making nested use safe.
   * @returns A release function that MUST be called when the work completes.
   */
  async acquire(): Promise<() => void> {
    const existing = slotContext.getStore();
    if (existing) {
      return existing.release;
    }
    if (this.active < this.limit) {
      this.active++;
      return this.release.bind(this);
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // A waiter is resumed only after a release has already handed the slot to
    // it, so no further bookkeeping is needed here.
    return this.release.bind(this);
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter without ever dropping below
      // the limit or briefly allowing an extra concurrent run.
      next();
      return;
    }
    this.active--;
  }
}

/**
 * Shared process-wide limiter for heavy LLM-backed runs. Defaults to a single
 * concurrent run; override with `MAX_CONCURRENT_RUNS` in the environment.
 */
export const runSemaphore = new Semaphore(
  Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_RUNS ?? '1', 10) || 1),
);

/**
 * Run `work` under the global semaphore with a bounded wait. If a slot is
 * available it runs immediately; otherwise it waits up to `maxWaitMs` for a
 * slot, and returns a "busy" decision without running when the wait elapses.
 *
 * The slot is tracked in an async context so any nested
 * {@link runWithConcurrencyLimit} call during `work` reuses it instead of
 * acquiring a second slot. A slot granted after the wait elapses is released
 * immediately, so the semaphore never leaks a slot on the timeout path.
 *
 * @param work - The heavy task to run while holding the slot.
 * @param label - Descriptive label for logging (e.g. "review nilesh32236/repo#5").
 * @param maxWaitMs - Maximum milliseconds to wait for a free slot (default 30s).
 * @returns `{ acquired: true }` after the work completes, or
 * `{ acquired: false, reason }` when the slot was not obtained in time.
 */
export async function runWithConcurrencyLimit<T>(
  work: () => Promise<T>,
  label: string,
  maxWaitMs = 30_000,
): Promise<ConcurrencyDecision> {
  // Reentrant fast path: the caller already holds the slot in this context.
  if (slotContext.getStore()) {
    await work();
    return { acquired: true };
  }

  const acquirePromise = runSemaphore.acquire();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), maxWaitMs);
  });
  // `acquirePromise.then((r) => r)` unwraps the release function; the race
  // yields either the release function or null (timeout).
  const slot = await Promise.race([acquirePromise.then((release) => release), timeout]);
  if (slot === null) {
    // The slot may still be granted after the timeout fired. Release it the
    // moment it arrives so the limiter never leaks a slot on this path.
    acquirePromise.then((release) => {
      release();
    });
    logger.warn(`Busy — skipping ${label}: all slots in use (${maxWaitMs}ms wait elapsed)`);
    return { acquired: false, reason: 'Too many concurrent runs' };
  }

  // Clear the timeout timer once the slot is won so it does not stay alive for
  // the full wait window on every completed run.
  if (timeoutHandle) clearTimeout(timeoutHandle);

  const state: SlotState = { release: slot };
  try {
    return await slotContext.run(state, async () => {
      await work();
      return { acquired: true };
    });
  } finally {
    slot();
  }
}
