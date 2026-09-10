/**
 * Safely read an HTTP-style status code from an unknown thrown value.
 *
 * `catch` binds `unknown`, and any value can be thrown (including `null`,
 * a string, or a plain object). A raw `(err as { status?: number }).status`
 * cast therefore throws a secondary `TypeError` when `err` is not an object,
 * masking the original error. This helper never throws and returns `undefined`
 * when no numeric `status` is present.
 *
 * @param err - The value caught from a `try`/`catch` or a rejected promise.
 * @returns The numeric status code, or `undefined` if absent or not a number.
 */
export function getErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}
