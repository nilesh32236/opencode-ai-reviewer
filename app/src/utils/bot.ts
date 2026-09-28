/**
 * Detect whether a GitHub user object represents a bot account. Centralizes the
 * bot-detection heuristics that were previously scattered across subscribers
 * (some checked `type === 'Bot'`, others exact `login === 'github-actions[bot]'`,
 * others `login.includes('[bot]')`) so every event is filtered by one
 * convention: `type === 'Bot'` or a login ending in `[bot]`.
 *
 * `login` is typed `unknown` because every caller reads it off untrusted webhook
 * JSON: the shared pre-dispatch filter in `index.ts` runs on payloads that were
 * never shape-validated, so a non-string login must yield a verdict, not a
 * `TypeError` thrown out of the event filter.
 * @param user - Optional GitHub user object with type/login fields.
 * @returns True if the user is a bot account.
 */
export function isBotUser(user: { type?: string; login?: unknown } | undefined): boolean {
  if (!user) return false;
  return user.type === 'Bot' || isBotLogin(user.login);
}

/**
 * Detect whether a GitHub login belongs to a bot account.
 * Matches the standard `name[bot]` login convention used by GitHub Apps.
 * @param login - Candidate login, narrowed to a string internally.
 * @returns True only when `login` is a string matching the bot login pattern.
 */
export function isBotLogin(login: unknown): boolean {
  return typeof login === 'string' && login.toLowerCase().endsWith('[bot]');
}
