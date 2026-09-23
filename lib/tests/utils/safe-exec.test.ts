import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  dnsResolvesBlockedHost,
  getLinterIsolationArgs,
  isAllowedLinterCommand,
  isAllowedMcpLocalCommand,
  isBlockedIpHost,
  isConfinedPath,
  isRepoLintersEnabled,
  isSafeLinterArgs,
  isSafeRemoteMcpUrl,
  resolveConfinedWorkingDir,
} from '../../src/utils/safe-exec.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';

describe('isAllowedLinterCommand', () => {
  it('allows single-purpose linter binaries', () => {
    expect(isAllowedLinterCommand('eslint')).toBe(true);
    expect(isAllowedLinterCommand('ruff')).toBe(true);
    expect(isAllowedLinterCommand('shellcheck')).toBe(true);
  });

  it('rejects generic code-execution toolchains', () => {
    for (const cmd of ['go', 'cargo', 'dotnet', 'dart', 'flutter']) {
      expect(isAllowedLinterCommand(cmd)).toBe(false);
    }
  });

  it('rejects paths and runners', () => {
    expect(isAllowedLinterCommand('/usr/bin/eslint')).toBe(false);
    expect(isAllowedLinterCommand('sh')).toBe(false);
    expect(isAllowedLinterCommand('npx')).toBe(false);
  });

  it('validates only the matched value from OPENCODE_ALLOWED_LINTERS', () => {
    // One malformed operator entry must not DoS an otherwise-valid custom linter.
    vi.stubEnv('OPENCODE_ALLOWED_LINTERS', 'my-linter,evil;cmd');
    try {
      expect(isAllowedLinterCommand('my-linter')).toBe(true);
      expect(isAllowedLinterCommand('other-linter')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('isSafeLinterArgs', () => {
  it('accepts undefined and well-formed string args', () => {
    expect(isSafeLinterArgs(undefined)).toBe(true);
    expect(isSafeLinterArgs(['--format', 'json'])).toBe(true);
  });

  it('rejects non-string args, NUL bytes, and overlong values', () => {
    expect(isSafeLinterArgs([42])).toBe(false);
    expect(isSafeLinterArgs(['ok\0evil'])).toBe(false);
    expect(isSafeLinterArgs(['x'.repeat(2049)])).toBe(false);
    expect(isSafeLinterArgs('not-an-array')).toBe(false);
  });

  it('rejects plugin/code-loading flags including --flag=value forms', () => {
    for (const args of [
      ['--rulesdir', './evil-rules'],
      ['--rulesdir=./evil-rules'],
      ['--plugin', './evil-plugin'],
      ['--plugin=./evil-plugin'],
      ['--plugin-search-dir', './evil'],
      ['--load-rules', './evil'],
      ['--require', './evil-hook'],
      ['-r', './evil-hook'],
      ['-revil-hook'],
      ['--loader', './evil-loader'],
      ['--custom-formatter', './evil-formatter'],
      ['--config', './evil.js'],
      ['--config=./evil.js'],
      ['--config-file', './evil.js'],
      ['--formatter', './evil-formatter'],
      ['-c', './evil.js'],
      ['-cevil.js'],
    ]) {
      expect(isSafeLinterArgs(args)).toBe(false);
    }
    // Ordinary linter flags still pass.
    expect(isSafeLinterArgs(['--format', 'json', '--quiet'])).toBe(true);
  });
});

describe('isRepoLintersEnabled (REF-002)', () => {
  it('is default-deny without the operator opt-in', () => {
    vi.stubEnv('OPENCODE_ENABLE_REPO_LINTERS', '');
    try {
      expect(isRepoLintersEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(isRepoLintersEnabled()).toBe(false);
  });

  it('accepts 1/true/yes opt-in forms', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', ' Yes ']) {
      vi.stubEnv('OPENCODE_ENABLE_REPO_LINTERS', v);
      try {
        expect(isRepoLintersEnabled()).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    }
    vi.stubEnv('OPENCODE_ENABLE_REPO_LINTERS', '0');
    try {
      expect(isRepoLintersEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('getLinterIsolationArgs (REF-002)', () => {
  it('returns verified discovery-off flags for eslint/prettier/ruff', () => {
    expect(getLinterIsolationArgs('eslint')).toEqual(['--no-config-lookup']);
    expect(getLinterIsolationArgs('prettier')).toEqual(['--no-config']);
    expect(getLinterIsolationArgs('ruff')).toEqual(['--isolated']);
  });

  it('returns [] for tools with no verified flag (gate covers the gap)', () => {
    for (const cmd of [
      'stylelint',
      'tsc',
      'rubocop',
      'phpcs',
      'php-cs-fixer',
      'biome',
      'gofmt',
      'shellcheck',
      'unknown-tool',
    ]) {
      expect(getLinterIsolationArgs(cmd)).toEqual([]);
    }
  });

  it('proves a hostile checkout config cannot execute via implicit discovery', () => {
    // Hostile checkout: eslint.config.js with an exfil payload + a linters
    // entry relying on defaults. The engine appends --no-config-lookup after
    // PR-controlled args and before `--` + files, so the payload file is
    // never loaded — assert via arg inspection (no exec here).
    const configArgs = ['--format', 'json'];
    const files = ['src/victim.ts'];
    const finalArgs = [...configArgs, ...getLinterIsolationArgs('eslint'), '--', ...files];
    expect(finalArgs).toEqual(['--format', 'json', '--no-config-lookup', '--', 'src/victim.ts']);
    // The isolation flag precedes `--`, so filenames cannot become options
    // and the checkout config is never discovered.
    expect(finalArgs.indexOf('--no-config-lookup')).toBeLessThan(finalArgs.indexOf('--'));
  });
});

describe('isAllowedMcpLocalCommand', () => {
  it('allows the pinned built-in server vectors', () => {
    expect(isAllowedMcpLocalCommand(['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'])).toBe(
      true,
    );
    expect(
      isAllowedMcpLocalCommand([
        'npx',
        '-y',
        '--quiet',
        '@modelcontextprotocol/server-github@2025.4.8',
      ]),
    ).toBe(true);
  });

  it('rejects checkout-controlled script-file args', () => {
    expect(isAllowedMcpLocalCommand(['node', 'server.js'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', 'evil.py'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['deno', 'run', 'evil.ts'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', './scripts/c7.mjs'])).toBe(false);
  });

  it('rejects unpinned npx packages', () => {
    expect(isAllowedMcpLocalCommand(['npx', '-y', 'evil-pkg'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['npx', '-y', '@upstash/context7-mcp-fake@1.0.0'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['uvx', 'evil-pkg'])).toBe(false);
  });

  it('rejects code-evaluation flags', () => {
    expect(isAllowedMcpLocalCommand(['node', '-e', 'evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--eval', 'evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-c', 'evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['deno', 'eval', 'evil'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-p', '8080'])).toBe(false);
  });

  it('rejects concatenated --flag=value and joined short-flag forms', () => {
    expect(isAllowedMcpLocalCommand(['node', '--eval=evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--code=evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '-econsole.log(1)'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-cimport os'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-p8080'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--require=./evil-hook'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--loader', './evil-loader'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-m', 'evil'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-mevil'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--run', 'dev'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--run=dev'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['uvx', '--from', 'evil-pkg', 'tool'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['uvx', '--with', 'evil-pkg', 'tool'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--import-map', './evil.json'])).toBe(false);
  });

  it('rejects non-allowlisted launchers and non-string args', () => {
    expect(isAllowedMcpLocalCommand(['sh', '-c', 'evil'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', 42])).toBe(false);
    expect(isAllowedMcpLocalCommand([])).toBe(false);
  });
});

describe('isConfinedPath', () => {
  const base = '/checkout';

  it('treats the base directory itself as confined', () => {
    expect(isConfinedPath(base, '.')).toBe(true);
  });

  it('confines relative paths and rejects escapes', () => {
    expect(isConfinedPath(base, 'sub/dir')).toBe(true);
    expect(isConfinedPath(base, '../outside')).toBe(false);
    expect(isConfinedPath(base, '/etc/passwd')).toBe(false);
    // Benign dot-dot-prefixed names stay inside the base (segment check).
    expect(isConfinedPath(base, '..foo')).toBe(true);
  });
});

describe('resolveConfinedWorkingDir', () => {
  it('resolves the checkout root for "." and empty values', () => {
    expect(resolveConfinedWorkingDir('/checkout', '.')).toBe('/checkout');
    expect(resolveConfinedWorkingDir('/checkout', undefined)).toBe('/checkout');
    expect(resolveConfinedWorkingDir('/checkout', 'sub')).toBe('/checkout/sub');
    expect(resolveConfinedWorkingDir('/checkout', '../escape')).toBeNull();
    expect(resolveConfinedWorkingDir('/checkout', '..foo')).toBe('/checkout/..foo');
    expect(resolveConfinedWorkingDir('/checkout', 42 as unknown as string)).toBeNull();
  });

  it('rejects checkout symlinks pointing outside the checkout', () => {
    const outside = mkdtempSync(join(tmpdir(), 'safe-exec-outside-'));
    const checkout = mkdtempSync(join(tmpdir(), 'safe-exec-checkout-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(checkout, 'link'));
    try {
      expect(resolveConfinedWorkingDir(checkout, 'link')).toBeNull();
      expect(isConfinedPath(checkout, 'link')).toBe(false);
      // A symlink staying inside the checkout remains confined.
      mkdirSync(join(checkout, 'real-sub'));
      symlinkSync(join(checkout, 'real-sub'), join(checkout, 'inner-link'));
      expect(resolveConfinedWorkingDir(checkout, 'inner-link')).not.toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe('isBlockedIpHost', () => {
  it('blocks IPv6 link-local across fe80-febf (fe80::/10)', () => {
    for (const h of ['fe80::1', 'fe90::1', 'fea0::1', 'feb0::1', 'febf:ffff::1']) {
      expect(isBlockedIpHost(h)).toBe(true);
    }
    expect(isBlockedIpHost('fec0::1')).toBe(false);
  });

  it('decodes hex-embedded IPv4 tails with 16-bit groups', () => {
    // ::ffff:192.168.0.1 in hex-embedded form must still classify as private.
    expect(isBlockedIpHost('::ffff:c0a8:1')).toBe(true);
    expect(isBlockedIpHost('::ffff:7f00:1')).toBe(true);
    // Public address in hex-embedded form stays public.
    expect(isBlockedIpHost('::ffff:0808:0808')).toBe(false);
  });

  it('blocks classic alternate IPv4 representations', () => {
    expect(isBlockedIpHost('2130706433')).toBe(true);
    expect(isBlockedIpHost('0x7f.0.0.1')).toBe(true);
    expect(isBlockedIpHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('allows ordinary public hosts', () => {
    expect(isBlockedIpHost('mcp.example.com')).toBe(false);
    expect(isBlockedIpHost('8.8.8.8')).toBe(false);
  });
});

describe('isSafeRemoteMcpUrl', () => {
  it('accepts public https URLs without credentials', () => {
    expect(isSafeRemoteMcpUrl('https://mcp.example.com/sse')).toBe(true);
  });

  it('rejects non-https, credentialed, and internal URLs', () => {
    expect(isSafeRemoteMcpUrl('http://mcp.example.com/sse')).toBe(false);
    expect(isSafeRemoteMcpUrl('https://user:pass@mcp.example.com/sse')).toBe(false);
    expect(isSafeRemoteMcpUrl('https://169.254.169.254/latest')).toBe(false);
    // Bracketed IPv6 literals (as returned by `URL.hostname`) are stripped
    // before the host-policy check — mapped loopback must still be blocked.
    expect(isSafeRemoteMcpUrl('https://[::ffff:127.0.0.1]/sse')).toBe(false);
    expect(isSafeRemoteMcpUrl('https://[::1]/sse')).toBe(false);
  });
});

describe('dnsResolvesBlockedHost (issue #546)', () => {
  const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

  it('denies hostnames resolving to blocked addresses', async () => {
    mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(dnsResolvesBlockedHost('evil.example.com')).resolves.toBe(true);
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(dnsResolvesBlockedHost('metadata.example.com')).resolves.toBe(true);
  });

  it('denies when any of several records is blocked', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]);
    await expect(dnsResolvesBlockedHost('mixed.example.com')).resolves.toBe(true);
  });

  it('allows public resolutions', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(dnsResolvesBlockedHost('mcp.example.com')).resolves.toBe(false);
  });

  it('classifies literal IPs without DNS', async () => {
    mockLookup.mockClear();
    await expect(dnsResolvesBlockedHost('127.0.0.1')).resolves.toBe(true);
    await expect(dnsResolvesBlockedHost('8.8.8.8')).resolves.toBe(false);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('fails open on DNS errors (sandboxed CI without DNS keeps working)', async () => {
    mockLookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    await expect(dnsResolvesBlockedHost('mcp.example.com')).resolves.toBe(false);
  });

  it('fails closed on empty host', async () => {
    await expect(dnsResolvesBlockedHost('')).resolves.toBe(true);
  });
});
