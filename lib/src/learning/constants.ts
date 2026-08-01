/**
 * Dismissal signal values that indicate a finding is a genuine false positive
 * and should therefore suppress future flags. `/dismiss out_of_scope` and
 * `/dismiss other` mean the finding is valid but not applicable to this PR —
 * those are recorded for metrics but must not generate 'DO NOT flag' rules.
 * Legacy FeedbackSubscriber dismissal signals (review/comment dismissed or
 * deleted) represent real dismissal actions and remain suppression-worthy.
 */
export const SUPPRESSING_DISMISS_SIGNALS: ReadonlySet<string> = new Set<string>([
  'false_positive',
  'intentional',
  'review_dismissed',
  'comment_dismissed',
  'comment_deleted',
]);

/**
 * Whether a `dismissed` feedback signal value suppresses future flags.
 *
 * Legacy rows written before the reason taxonomy existed store `null`/`undefined`;
 * they represent real dismissal actions and are treated as suppression-worthy.
 *
 * @param value - The `signal_value` of a `dismissed` feedback row.
 * @returns True when the dismissal should suppress future flags.
 */
export function isSuppressingDismissSignal(value?: string | null): boolean {
  if (value === undefined || value === null) return true;
  return SUPPRESSING_DISMISS_SIGNALS.has(value);
}
