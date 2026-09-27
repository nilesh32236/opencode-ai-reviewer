import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_PACKAGE_VERSIONS,
  findMcpTarballPath,
  findNpxPackageSpec,
  isAllowedMcpPackage,
  isNpxLauncher,
  parseNpxPackageSpec,
  resolveMcpTarballChecksum,
  resolveRequireMcpChecksum,
  verifyMcpTarball,
} from '../src/mcp/servers.js';

const ENV_KEYS = [
  'INPUT_REQUIRE_MCP_CHECKSUM',
  'REQUIRE_MCP_CHECKSUM',
  'MCP_TARBALL_SHA256',
  'INPUT_MCP_TARBALL_SHA256',
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
  vi.restoreAllMocks();
});

describe('parseNpxPackageSpec', () => {
  it('parses scoped packages', () => {
    expect(parseNpxPackageSpec('@upstash/context7-mcp@3.2.5')).toEqual({
      name: '@upstash/context7-mcp',
      version: '3.2.5',
    });
  });

  it('parses unscoped packages', () => {
    expect(parseNpxPackageSpec('pkg@1.2.3')).toEqual({ name: 'pkg', version: '1.2.3' });
  });

  it('returns null for malformed specs', () => {
    expect(parseNpxPackageSpec('node')).toBeNull();
    expect(parseNpxPackageSpec('')).toBeNull();
    expect(parseNpxPackageSpec('   ')).toBeNull();
    expect(parseNpxPackageSpec('pkg@')).toBeNull();
    expect(parseNpxPackageSpec('@pkg@')).toBeNull();
    expect(parseNpxPackageSpec('@scope/pkg')).toBeNull();
  });

  it('returns null for non-string runtime input', () => {
    expect(parseNpxPackageSpec(undefined)).toBeNull();
    expect(parseNpxPackageSpec(null)).toBeNull();
    expect(parseNpxPackageSpec(42)).toBeNull();
    expect(parseNpxPackageSpec({})).toBeNull();
  });
});

describe('findNpxPackageSpec', () => {
  it('finds the spec regardless of flag order', () => {
    expect(findNpxPackageSpec(['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'])).toEqual({
      name: '@upstash/context7-mcp',
      version: '3.2.5',
    });
  });

  it('returns null for custom commands without a spec', () => {
    expect(findNpxPackageSpec(['node', 'server.js'])).toBeNull();
  });

  it('skips flag args carrying @ (registry URL)', () => {
    expect(
      findNpxPackageSpec(['npx', '--registry=https://user@host', 'node', 'server.js']),
    ).toBeNull();
  });

  it('skips bare :// URLs', () => {
    expect(findNpxPackageSpec(['npx', 'https://user@host/pkg.tgz'])).toBeNull();
  });

  it('rejects non-package names (emails)', () => {
    expect(findNpxPackageSpec(['npx', 'not an email!@x'])).toBeNull();
  });

  it('honours args after a -- separator', () => {
    expect(findNpxPackageSpec(['npx', '--', '-weird@1.0.0'])).toEqual({
      name: '-weird',
      version: '1.0.0',
    });
  });

  it('returns null for non-array runtime input', () => {
    expect(findNpxPackageSpec(undefined as unknown as readonly unknown[])).toBeNull();
    expect(findNpxPackageSpec(null as unknown as readonly unknown[])).toBeNull();
  });
});

describe('isNpxLauncher', () => {
  it('matches bare, path-qualified, and Windows launcher spellings', () => {
    expect(isNpxLauncher('npx')).toBe(true);
    expect(isNpxLauncher('/usr/bin/npx')).toBe(true);
    expect(isNpxLauncher('C:\\tools\\npx.cmd')).toBe(true);
    expect(isNpxLauncher('npx.exe')).toBe(true);
    expect(isNpxLauncher('  npx  ')).toBe(true);
  });

  it('rejects non-launcher commands and non-string input', () => {
    expect(isNpxLauncher('node')).toBe(false);
    expect(isNpxLauncher('npx-extra')).toBe(false);
    expect(isNpxLauncher('')).toBe(false);
    expect(isNpxLauncher(undefined)).toBe(false);
    expect(isNpxLauncher(null)).toBe(false);
    expect(isNpxLauncher(42)).toBe(false);
  });
});

describe('isAllowedMcpPackage', () => {
  it('returns true silently for pinned pairs (no logging)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [name, version] of Object.entries(MCP_PACKAGE_VERSIONS)) {
      expect(isAllowedMcpPackage(name, version)).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('returns false for unknown packages and version mismatches', () => {
    const [pinnedName, pinnedVersion] = Object.entries(MCP_PACKAGE_VERSIONS)[0]!;
    expect(isAllowedMcpPackage('unknown-pkg', '1.0.0')).toBe(false);
    expect(isAllowedMcpPackage(pinnedName, `${pinnedVersion}-evil`)).toBe(false);
  });
});

describe('resolveRequireMcpChecksum', () => {
  it('defaults to false', () => {
    expect(resolveRequireMcpChecksum()).toBe(false);
  });

  it('explicit options win over env', () => {
    process.env.INPUT_REQUIRE_MCP_CHECKSUM = 'true';
    expect(resolveRequireMcpChecksum({ strict: false })).toBe(false);
    expect(resolveRequireMcpChecksum({ requireChecksum: false })).toBe(false);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env.INPUT_REQUIRE_MCP_CHECKSUM;
    expect(resolveRequireMcpChecksum({ strict: true })).toBe(true);
  });

  it('reads env vars and aliases case-insensitively', () => {
    process.env.REQUIRE_MCP_CHECKSUM = 'TRUE';
    expect(resolveRequireMcpChecksum()).toBe(true);
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env.REQUIRE_MCP_CHECKSUM;
    process.env.INPUT_REQUIRE_MCP_CHECKSUM = ' true ';
    expect(resolveRequireMcpChecksum()).toBe(true);
  });
});

describe('findMcpTarballPath / resolveMcpTarballChecksum', () => {
  it('detects tarball args and ignores normal npx commands', () => {
    expect(findMcpTarballPath(['npx', '-y', 'pkg@1.2.3'])).toBeNull();
    expect(findMcpTarballPath(['npx', '/tmp/mcp-1.0.0.tgz'])).toBe('/tmp/mcp-1.0.0.tgz');
    expect(findMcpTarballPath(['node', 'server.TAR.GZ'])).toBe('server.TAR.GZ');
  });

  it('returns the trimmed tarball arg so detection matches verification', () => {
    expect(findMcpTarballPath(['npx', '  /tmp/mcp-1.0.0.tgz  '])).toBe('/tmp/mcp-1.0.0.tgz');
  });

  it('skips remote tarball URLs (only local paths are verifiable)', () => {
    expect(findMcpTarballPath(['npx', 'https://host/pkg.tgz'])).toBeNull();
    expect(findMcpTarballPath(['npx', 'https://host/pkg.tar.gz'])).toBeNull();
  });

  it('prefers workflow env over per-server config (env is the integrity root)', () => {
    process.env.MCP_TARBALL_SHA256 = 'envhash';
    expect(resolveMcpTarballChecksum({ environment: { MCP_TARBALL_SHA256: 'serverhash' } })).toBe(
      'envhash',
    );
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env.MCP_TARBALL_SHA256;
    process.env.INPUT_MCP_TARBALL_SHA256 = 'aliashash';
    expect(resolveMcpTarballChecksum({ environment: { MCP_TARBALL_SHA256: 'serverhash' } })).toBe(
      'aliashash',
    );
  });

  it('resolves checksum from workflow env, falling back to self-attested server env', () => {
    expect(resolveMcpTarballChecksum({ environment: { MCP_TARBALL_SHA256: ' abc ' } })).toBe('abc');
    process.env.MCP_TARBALL_SHA256 = 'envhash';
    expect(resolveMcpTarballChecksum({})).toBe('envhash');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env.MCP_TARBALL_SHA256;
    process.env.INPUT_MCP_TARBALL_SHA256 = 'aliashash';
    expect(resolveMcpTarballChecksum(null)).toBe('aliashash');
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env.INPUT_MCP_TARBALL_SHA256;
    expect(resolveMcpTarballChecksum({})).toBeNull();
  });
});

describe('verifyMcpTarball', () => {
  function writeTemp(content: string): { file: string; sha: string } {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tarball-')), 'pkg.tgz');
    fs.writeFileSync(file, content);
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    return { file, sha };
  }

  it('verifies a matching hash and tolerates surrounding whitespace', async () => {
    const { file, sha } = writeTemp('hello-mcp');
    await expect(verifyMcpTarball(file, `  ${sha}  `)).resolves.toBe(true);
  });

  it('verifies a whitespace-padded path by normalizing before open', async () => {
    const { file, sha } = writeTemp('hello-mcp');
    await expect(verifyMcpTarball(`  ${file}  `, sha)).resolves.toBe(true);
  });

  it('fail-open: missing hash warns and returns false', async () => {
    const { file } = writeTemp('hello-mcp');
    await expect(verifyMcpTarball(file, null)).resolves.toBe(false);
  });

  it('fail-open: mismatch warns and returns false', async () => {
    const { file } = writeTemp('hello-mcp');
    await expect(verifyMcpTarball(file, '0'.repeat(64))).resolves.toBe(false);
  });

  it('strict mode throws on missing hash and mismatch', async () => {
    const { file } = writeTemp('hello-mcp');
    await expect(verifyMcpTarball(file, null, { strict: true })).rejects.toThrow();
    await expect(
      verifyMcpTarball(file, '0'.repeat(64), { requireChecksum: true }),
    ).rejects.toThrow();
  });

  it('routes warnings through the caller-provided logger', async () => {
    const { file } = writeTemp('hello-mcp');
    const warnings: string[] = [];
    const logger = { warn: (msg: string) => void warnings.push(msg) };
    await expect(verifyMcpTarball(file, null, undefined, logger)).resolves.toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
