/**
 * Safely read an HTTP-style status code from an unknown thrown value.
 *
 * `catch` binds `unknown`, and any value can be thrown (including `null`,
 * a string, or a plain object). A raw `(err as { status?: number }).status`
 * cast therefore throws a secondary `TypeError` when `err` is not an object,
 * masking the original error. This helper never throws and returns `undefined`
 * when no numeric `status` is present.
 *
 * Shapes covered, checked in order:
 * - `err.status` (Octokit errors, fetch `Response` instances, plain objects)
 * - `err.statusCode` (Node `http`, axios-style errors)
 * - `err.response.status` / `err.response.statusCode` (axios-style wrappers)
 * - `err.cause` chain (wrapped errors), walked with a bounded depth and a
 *   cycle guard so cyclic causes terminate instead of looping
 *
 * Only finite numbers are accepted; numeric strings (e.g. `{ status: '404' }`)
 * are rejected so stringly-typed metadata can never be mistaken for a real
 * HTTP status. Every property read is guarded, so even throwing getters
 * yield `undefined` instead of masking the original error.
 *
 * @param err - The value caught from a `try`/`catch` or a rejected promise.
 * @returns The numeric status code, or `undefined` if absent or not a number.
 */
export function getErrorStatus(err: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  // Walk at most 4 links to avoid unbounded recursion on deep/cyclic causes.
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const direct = readStatusKeys(current);
    if (direct !== undefined) {
      return direct;
    }
    const nested = readResponseStatus(current);
    if (nested !== undefined) {
      return nested;
    }
    current = safeRead(current, 'cause');
  }
  return undefined;
}

/**
 * Read a property without ever throwing (e.g. on throwing getters).
 *
 * @param obj - The object to read from.
 * @param key - The property key to read.
 * @returns The property value, or `undefined` when unreadable.
 */
function safeRead(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Coerce a candidate status value into a usable status code.
 *
 * @param value - The candidate value.
 * @returns The status code, or `undefined` when not a finite number.
 */
function toStatusNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a direct `status` / `statusCode` from an error object.
 * `status` wins over `statusCode` when both are present.
 *
 * @param obj - The error-like object to inspect.
 * @returns The status code, or `undefined` when absent.
 */
function readStatusKeys(obj: object): number | undefined {
  const status = toStatusNumber(safeRead(obj, 'status'));
  if (status !== undefined) {
    return status;
  }
  return toStatusNumber(safeRead(obj, 'statusCode'));
}

/**
 * Read `response.status` / `response.statusCode` from an axios-style wrapper.
 *
 * @param obj - The error-like object to inspect.
 * @returns The nested status code, or `undefined` when absent.
 */
function readResponseStatus(obj: object): number | undefined {
  const response = safeRead(obj, 'response');
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  return readStatusKeys(response);
}
