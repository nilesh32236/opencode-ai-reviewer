import { describe, expect, it } from 'vitest';
import { isBotLogin, isBotUser } from '../../src/utils/bot.js';

describe('isBotLogin', () => {
  it('matches the name[bot] convention case-insensitively', () => {
    expect(isBotLogin('github-actions[bot]')).toBe(true);
    expect(isBotLogin('OpenCode-PR-Agent[BOT]')).toBe(true);
    expect(isBotLogin('dependabot[bot]')).toBe(true);
  });

  it('does not match ordinary logins', () => {
    expect(isBotLogin('octocat')).toBe(false);
    expect(isBotLogin('botnope')).toBe(false);
    expect(isBotLogin('someone[bot]-suffix')).toBe(false);
    expect(isBotLogin('')).toBe(false);
  });

  it('returns a verdict for a non-string login instead of throwing', () => {
    // `comment.user` / `sender` come off unvalidated webhook JSON, and the
    // pre-dispatch filter in `index.ts` calls this on five of those objects
    // with no try/catch. A `TypeError` here escapes the event filter for the
    // whole installation, so a non-string login must be a plain `false`.
    expect(isBotLogin(undefined)).toBe(false);
    expect(isBotLogin(null)).toBe(false);
    expect(isBotLogin(0)).toBe(false);
    expect(isBotLogin(42)).toBe(false);
    expect(isBotLogin({})).toBe(false);
    expect(isBotLogin([])).toBe(false);
    expect(isBotLogin(new String('github-actions[bot]'))).toBe(false);
    expect(isBotLogin({ toString: () => 'x' })).toBe(false);
  });
});

describe('isBotUser', () => {
  it('detects bots by type or login suffix', () => {
    expect(isBotUser({ type: 'Bot' })).toBe(true);
    expect(isBotUser({ type: 'Bot', login: 'octocat' })).toBe(true);
    expect(isBotUser({ type: 'User', login: 'github-actions[bot]' })).toBe(true);
  });

  it('does not flag human users or absent users', () => {
    expect(isBotUser({ type: 'User', login: 'octocat' })).toBe(false);
    expect(isBotUser({})).toBe(false);
    expect(isBotUser(undefined)).toBe(false);
  });

  it('does not throw on a type-confused login', () => {
    expect(isBotUser({ type: 'User', login: { toString: () => 'x' } })).toBe(false);
    expect(isBotUser({ login: null })).toBe(false);
  });
});
