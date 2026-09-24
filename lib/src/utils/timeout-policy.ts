/**
 * Shared validation policy for application-level OpenCode timeouts.
 *
 * The value is expressed in minutes because that is the Action/CLI contract.
 * Keeping the maximum below Node's signed 32-bit timer limit prevents a valid
 * number from overflowing `setTimeout` and firing immediately.
 */

/** Maximum supported application timeout, in minutes (about 24.3 days). */
export const MAX_TIMEOUT_MINUTES = 35_000;

/** Human-readable error used by every timeout entry point. */
export const TIMEOUT_MINUTES_ERROR = `timeout_minutes must be a positive integer between 1 and ${MAX_TIMEOUT_MINUTES} minutes`;

/**
 * Validate an optional application-level OpenCode timeout.
 *
 * `undefined` is the only omitted value. All other values must be finite
 * positive safe integers within the supported timer range.
 *
 * @param value - Candidate timeout in minutes.
 * @returns The validated timeout, or `undefined` when omitted.
 * @throws Error when a non-undefined value is invalid.
 */
export function validateTimeoutMinutes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MINUTES
  ) {
    throw new Error(TIMEOUT_MINUTES_ERROR);
  }
  return value;
}
