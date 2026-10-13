/**
 * Run an async function over items with bounded parallelism.
 * Results are aligned with the input order. Each worker checks
 * `signal?.throwIfAborted()` before starting the next item so
 * cancellation stops the queue promptly.
 *
 * @param items - Items to process.
 * @param limit - Maximum concurrent workers (clamped to >= 1).
 * @param fn - Async function applied to each item.
 * @param signal - Optional AbortSignal to cancel remaining work.
 * @returns Results aligned with the input array.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const safeLimit =
    typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(safeLimit, items.length) },
    async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted?.();
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Validate a caller-supplied concurrency value.
 * @param value - Requested concurrency.
 * @param def - Default when the value is undefined.
 * @returns Floored concurrency >= 1.
 * @throws RangeError when the value is defined but not a finite number >= 1.
 */
export function resolveConcurrency(value: number | undefined, def: number): number {
  if (value === undefined) return def;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.floor(value) < 1) {
    throw new RangeError(`Invalid concurrency: must be an integer >= 1 (got ${String(value)})`);
  }
  return Math.floor(value);
}
