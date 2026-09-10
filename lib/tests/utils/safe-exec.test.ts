import { describe, expect, it } from 'vitest';
import {
  isAllowedLinterCommand,
  isAllowedMcpLocalCommand,
  isBlockedIpHost,
  isConfinedPath,
  isSafeLinterArgs,
  isSafeRemoteMcpUrl,
  resolveConfinedWorkingDir,
} from '../../src/utils/safe-exec.js';

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
});

describe('isAllowedMcpLocalCommand', () => {
  it('allows the pinned built-in server vectors', () => {
    expect(isAllowedMcpLocalCommand(['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'])).toBe(
      true,
    );
    expect(isAllowedMcpLocalCommand(['node', 'server.js'])).toBe(true);
  });

  it('rejects code-evaluation flags', () => {
    expect(isAllowedMcpLocalCommand(['node', '-e', 'evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['node', '--eval', 'evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-c', 'evil()'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['deno', 'eval', 'evil'])).toBe(false);
    expect(isAllowedMcpLocalCommand(['python3', '-p', '8080'])).toBe(false);
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
  });
});

describe('resolveConfinedWorkingDir', () => {
  it('resolves the checkout root for "." and empty values', () => {
    expect(resolveConfinedWorkingDir('/checkout', '.')).toBe('/checkout');
    expect(resolveConfinedWorkingDir('/checkout', undefined)).toBe('/checkout');
    expect(resolveConfinedWorkingDir('/checkout', 'sub')).toBe('/checkout/sub');
    expect(resolveConfinedWorkingDir('/checkout', '../escape')).toBeNull();
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
  });
});
