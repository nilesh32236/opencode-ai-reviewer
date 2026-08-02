/**
 * Detect whether a GitHub user object represents a bot account. Centralizes the
 * bot-detection heuristics that were previously scattered across subscribers
 * (some checked `type === 'Bot'`, others exact `login === 'github-actions[bot]'`,
 * others `login.includes('[bot]')`) so every event is filtered by one
 * convention: `type === 'Bot'` or a login ending in `[bot]`.
 * @param user - Optional GitHub user object with type/login fields.
 * @returns True if the user is a bot account.
 */
export function isBotUser(user: { type?: string; login?: string } | undefined): boolean {
  if (!user) return false;
  return user.type === 'Bot' || isBotLogin(user.login);
}

/**
 * Detect whether a GitHub login string belongs to a bot account.
 * Matches the standard `name[bot]` login convention used by GitHub Apps.
 * @param login - GitHub login string.
 * @returns True if the login matches the bot login pattern.
 */
export function isBotLogin(login: string | undefined): boolean {
  return !!login && login.toLowerCase().endsWith('[bot]');
}
