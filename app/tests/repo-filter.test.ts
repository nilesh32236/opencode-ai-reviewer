import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRepoFilter, isRepoAllowed, logRepoFilter } from '../src/utils/repo-filter.js';

describe('repo filter', () => {
  describe('isRepoAllowed()', () => {
    it('allows every repo when no filter is configured', () => {
      const filter = buildRepoFilter({});
      expect(isRepoAllowed('any/repo', filter)).toBe(true);
    });

    it('allows a listed repo and denies an unlisted one', () => {
      const filter = buildRepoFilter({ ALLOWED_REPOS: 'acme/api' });
      expect(isRepoAllowed('acme/api', filter)).toBe(true);
      expect(isRepoAllowed('other/repo', filter)).toBe(false);
    });

    it('denies a denylisted repo even when the allowlist is empty', () => {
      const filter = buildRepoFilter({ DENIED_REPOS: 'acme/api' });
      expect(isRepoAllowed('acme/api', filter)).toBe(false);
      expect(isRepoAllowed('other/repo', filter)).toBe(true);
    });

    it('denies an empty repo name', () => {
      const filter = buildRepoFilter({ ALLOWED_REPOS: 'acme/api' });
      expect(isRepoAllowed(undefined, filter)).toBe(false);
      expect(isRepoAllowed('', filter)).toBe(false);
    });
  });

  describe('malformed denylist fails closed', () => {
    it('denies everything when the denylist is invalid', () => {
      // A dropped denylist entry is a repo the operator explicitly excluded
      // and will still run, so a denylist we cannot parse means nothing is
      // safe to process.
      const filter = buildRepoFilter({ DENIED_REPOS: 'myrepo' });
      expect(filter.denylistInvalid).toBe(true);
      expect(isRepoAllowed('myrepo', filter)).toBe(false);
      expect(isRepoAllowed('attacker/evil-repo', filter)).toBe(false);
    });

    it('is not invalid when the denylist parses', () => {
      const filter = buildRepoFilter({ DENIED_REPOS: 'acme/secret' });
      expect(filter.denylistInvalid).toBe(false);
      expect(isRepoAllowed('acme/secret', filter)).toBe(false);
      expect(isRepoAllowed('acme/api', filter)).toBe(true);
    });

    it('treats a whitespace-only denylist as unset', () => {
      const filter = buildRepoFilter({ DENIED_REPOS: '  ' });
      expect(filter.denylistInvalid).toBe(false);
      expect(isRepoAllowed('any/repo', filter)).toBe(true);
    });
  });

  // The startup log is the only way an operator learns their list was
  // discarded, so its behaviour is pinned rather than left to inspection.
  describe('logRepoFilter()', () => {
    const captured: { level: string; message: string }[] = [];
    let reset: () => void;

    beforeEach(async () => {
      const { Logger } = await import('@opencode-pr-agent/lib');
      captured.length = 0;
      const sink = {
        debug: (m: string) => captured.push({ level: 'debug', message: m }),
        info: (m: string) => captured.push({ level: 'info', message: m }),
        warn: (m: string) => captured.push({ level: 'warn', message: m }),
        error: (m: string) => captured.push({ level: 'error', message: m }),
      };
      Logger.setSink(sink);
      reset = () => Logger.resetSink();
    });

    afterEach(() => {
      reset?.();
    });

    const levels = () => captured.map((c) => c.level);
    const messages = () => captured.map((c) => c.message);

    it('reports an invalid allowlist as an error, not as "all eligible"', () => {
      logRepoFilter(buildRepoFilter({ ALLOWED_REPOS: 'myrepo' }));
      expect(levels()).toContain('error');
      expect(messages().join('\n')).toContain('ALLOWED_REPOS');
      expect(messages().join('\n')).not.toContain('all repositories are eligible');
    });

    it('reports an invalid denylist as an error, not as "all eligible"', () => {
      logRepoFilter(buildRepoFilter({ DENIED_REPOS: 'myrepo' }));
      expect(levels()).toContain('error');
      expect(messages().join('\n')).toContain('DENIED_REPOS');
      expect(messages().join('\n')).not.toContain('all repositories are eligible');
    });

    it('reports "all eligible" only when neither list was configured', () => {
      logRepoFilter(buildRepoFilter({}));
      expect(levels()).not.toContain('error');
      expect(messages().join('\n')).toContain('all repositories are eligible');
    });

    it('does not claim "all eligible" when a list was configured but empty', () => {
      logRepoFilter(buildRepoFilter({ DENIED_REPOS: '  ' }));
      expect(messages().join('\n')).toContain('all repositories are eligible');
    });

    it('lists the parsed allowlist and denylist', () => {
      logRepoFilter(buildRepoFilter({ ALLOWED_REPOS: 'acme/api', DENIED_REPOS: 'acme/secret' }));
      expect(messages().join('\n')).toContain('acme/api');
      expect(messages().join('\n')).toContain('acme/secret');
    });
  });

  // The defect these cover: an operator who typed ALLOWED_REPOS=myrepo (missing
  // the owner/ prefix) got an empty allowlist, and an empty allowlist means
  // "allow every repo" — so a typo silently granted the app access to every
  // repository the account can see, the exact opposite of the intent.
  describe('malformed allowlist fails closed', () => {
    it.each([
      ['no owner prefix', 'myrepo'],
      ['commas only', ',,,'],
      ['entries all lacking a slash', 'myrepo,otherrepo'],
    ])('denies everything when the allowlist is invalid: %s', (_label, raw) => {
      const filter = buildRepoFilter({ ALLOWED_REPOS: raw });
      expect(filter.allowlistInvalid).toBe(true);
      expect(isRepoAllowed('attacker/evil-repo', filter)).toBe(false);
      expect(isRepoAllowed('acme/api', filter)).toBe(false);
    });

    it('treats a whitespace-only allowlist as unset, not as invalid', () => {
      // A blank environment variable is the conventional way to mean "no
      // value", so this must not silently start denying traffic an operator
      // never asked to restrict.
      const filter = buildRepoFilter({ ALLOWED_REPOS: '   ' });
      expect(filter.allowlistInvalid).toBe(false);
      expect(isRepoAllowed('any/repo', filter)).toBe(true);
    });

    it('fails closed for entries that parse but name no real repo', () => {
      // "acme-api/" and "/web" both contain a slash, so they parse and the
      // allowlist is non-empty. The result is a list that matches nothing,
      // which already denies everything — the safe direction.
      const filter = buildRepoFilter({ ALLOWED_REPOS: 'acme-api/,/web' });
      expect(filter.allowlistInvalid).toBe(false);
      expect(isRepoAllowed('acme/api', filter)).toBe(false);
      expect(isRepoAllowed('acme/web', filter)).toBe(false);
    });

    it('does not flag a valid allowlist as invalid', () => {
      const filter = buildRepoFilter({ ALLOWED_REPOS: 'acme/api, acme/web ' });
      expect(filter.allowlistInvalid).toBe(false);
      expect(isRepoAllowed('acme/api', filter)).toBe(true);
    });

    it('does not flag an unset allowlist as invalid', () => {
      expect(buildRepoFilter({}).allowlistInvalid).toBe(false);
    });

    it('is not invalid when at least one entry parses, even if others do not', () => {
      // Partial validity is still a working allowlist: the operator's valid
      // entries must take effect rather than being discarded wholesale.
      const filter = buildRepoFilter({ ALLOWED_REPOS: 'myrepo,acme/api' });
      expect(filter.allowlistInvalid).toBe(false);
      expect(isRepoAllowed('acme/api', filter)).toBe(true);
      expect(isRepoAllowed('myrepo', filter)).toBe(false);
    });

    it('a hand-built filter without the flag keeps allow-all behavior', () => {
      const filter = { allowed: new Set<string>(), denied: new Set<string>() };
      expect(isRepoAllowed('any/repo', filter)).toBe(true);
    });
  });
});
