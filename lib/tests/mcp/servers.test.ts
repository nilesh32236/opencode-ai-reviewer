import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MCP_PACKAGE_VERSIONS,
  context7Server,
  findNpxPackageSpec,
  githubMCPServer,
  isAllowedMcpPackage,
  isExactVersionShape,
  parseNpxPackageSpec,
  verifyMcpTarball,
} from '../../src/mcp/servers.js';
import { computeSha256 } from '../../src/utils/checksum.js';

const CONTEXT7_PACKAGE = '@upstash/context7-mcp';
const GITHUB_PACKAGE = '@modelcontextprotocol/server-github';

function stubLogger() {
  const messages: string[] = [];
  return {
    messages,
    logger: { warn: (msg: string) => void messages.push(msg) },
  };
}

describe('servers', () => {
  it('pins the context7 package to an exact version', () => {
    const command = context7Server().command ?? [];
    expect(command).toContain(`${CONTEXT7_PACKAGE}@${MCP_PACKAGE_VERSIONS[CONTEXT7_PACKAGE]}`);
    const spec = command.find((arg) => arg.startsWith(`${CONTEXT7_PACKAGE}@`));
    expect(spec).toMatch(/^@upstash\/context7-mcp@\d+\.\d+\.\d+$/);
  });

  it('pins the github package to an exact version', () => {
    const command = githubMCPServer('fake-token').command ?? [];
    expect(command).toContain(`${GITHUB_PACKAGE}@${MCP_PACKAGE_VERSIONS[GITHUB_PACKAGE]}`);
    const spec = command.find((arg) => arg.startsWith(`${GITHUB_PACKAGE}@`));
    expect(spec).toMatch(/^@modelcontextprotocol\/server-github@\d+\.\d+\.\d+$/);
  });

  it('draws the version strings from MCP_PACKAGE_VERSIONS', () => {
    expect(Object.keys(MCP_PACKAGE_VERSIONS)).toEqual(
      expect.arrayContaining([CONTEXT7_PACKAGE, GITHUB_PACKAGE]),
    );
    expect(MCP_PACKAGE_VERSIONS[CONTEXT7_PACKAGE]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MCP_PACKAGE_VERSIONS[GITHUB_PACKAGE]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('passes GITHUB_TOKEN via environment for the github server', () => {
    const config = githubMCPServer('super-secret-token');
    expect(config.environment?.GITHUB_TOKEN).toBe('super-secret-token');
  });
});

describe('parseNpxPackageSpec', () => {
  it('parses scoped name@version pairs', () => {
    expect(parseNpxPackageSpec(`${CONTEXT7_PACKAGE}@3.2.5`)).toEqual({
      name: CONTEXT7_PACKAGE,
      version: '3.2.5',
    });
  });

  it('parses unscoped name@version pairs', () => {
    expect(parseNpxPackageSpec('some-pkg@1.0.0')).toEqual({
      name: 'some-pkg',
      version: '1.0.0',
    });
  });

  it('returns null for malformed or empty specs', () => {
    expect(parseNpxPackageSpec('')).toBeNull();
    expect(parseNpxPackageSpec('   ')).toBeNull();
    expect(parseNpxPackageSpec('@upstash/context7-mcp')).toBeNull();
    expect(parseNpxPackageSpec('some-pkg')).toBeNull();
    expect(parseNpxPackageSpec('@scope/pkg@')).toBeNull();
  });

  it('parses tags/ranges as versions (rejected later by the allowlist)', () => {
    expect(parseNpxPackageSpec(`${CONTEXT7_PACKAGE}@latest`)).toEqual({
      name: CONTEXT7_PACKAGE,
      version: 'latest',
    });
    expect(parseNpxPackageSpec(`${CONTEXT7_PACKAGE}@^3.2.5`)).toEqual({
      name: CONTEXT7_PACKAGE,
      version: '^3.2.5',
    });
  });
});

describe('findNpxPackageSpec', () => {
  it('finds the package spec in a typical npx command', () => {
    expect(findNpxPackageSpec(['npx', '-y', '--quiet', `${CONTEXT7_PACKAGE}@3.2.5`])).toEqual({
      name: CONTEXT7_PACKAGE,
      version: '3.2.5',
    });
  });

  it('skips flags and URLs instead of misidentifying them', () => {
    expect(
      findNpxPackageSpec([
        'npx',
        '-y',
        '--registry=https://example.com/@scope',
        'https://example.com/foo@1.2.3',
        `${GITHUB_PACKAGE}@2025.4.8`,
      ]),
    ).toEqual({ name: GITHUB_PACKAGE, version: '2025.4.8' });
  });

  it('returns null when no spec is present', () => {
    expect(findNpxPackageSpec(['npx', '-y', '--quiet'])).toBeNull();
    expect(findNpxPackageSpec([])).toBeNull();
  });
});

describe('isExactVersionShape', () => {
  it('accepts exact pins including date versions', () => {
    expect(isExactVersionShape('3.2.5')).toBe(true);
    expect(isExactVersionShape('2025.4.8')).toBe(true);
  });

  it('rejects tags and ranges', () => {
    expect(isExactVersionShape('latest')).toBe(false);
    expect(isExactVersionShape('^1.2.3')).toBe(false);
    expect(isExactVersionShape('>=1.0')).toBe(false);
    expect(isExactVersionShape('')).toBe(false);
  });
});

describe('isAllowedMcpPackage', () => {
  it('returns true for pinned pairs without logging', () => {
    const { messages, logger } = stubLogger();
    expect(
      isAllowedMcpPackage(
        CONTEXT7_PACKAGE,
        MCP_PACKAGE_VERSIONS[CONTEXT7_PACKAGE] as string,
        logger,
      ),
    ).toBe(true);
    expect(messages).toHaveLength(0);
  });

  it('returns false with a warning for wrong versions', () => {
    const { messages, logger } = stubLogger();
    expect(isAllowedMcpPackage(CONTEXT7_PACKAGE, '0.0.0', logger)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(CONTEXT7_PACKAGE);
  });

  it('returns false with a warning for unknown packages', () => {
    const { messages, logger } = stubLogger();
    expect(isAllowedMcpPackage('evil-pkg', '1.0.0', logger)).toBe(false);
    expect(messages).toHaveLength(1);
  });

  it('warns specifically about non-exact tags/ranges', () => {
    const { messages, logger } = stubLogger();
    expect(isAllowedMcpPackage(CONTEXT7_PACKAGE, 'latest', logger)).toBe(false);
    expect(messages[0]).toContain('not an exact pin');
  });

  it('stays silent without a logger (verdict only)', () => {
    expect(isAllowedMcpPackage(CONTEXT7_PACKAGE, '0.0.0')).toBe(false);
  });
});

describe('verifyMcpTarball', () => {
  it('returns false with a warning when no checksum is available', async () => {
    const { messages, logger } = stubLogger();
    await expect(verifyMcpTarball('/tmp/missing.tgz', null, false, logger)).resolves.toBe(false);
    expect(messages[0]).toContain('No checksum available');
  });

  it('returns false with a warning for malformed checksums', async () => {
    const { messages, logger } = stubLogger();
    await expect(verifyMcpTarball('/tmp/missing.tgz', 'not-a-hash', false, logger)).resolves.toBe(
      false,
    );
    expect(messages[0]).toContain('Malformed checksum');
  });

  it('verifies a matching tarball and reports mismatches fail-open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-tarball-'));
    try {
      const file = join(dir, 'pkg.tgz');
      writeFileSync(file, 'tarball-bytes');
      const hash = await computeSha256(file);
      const { logger } = stubLogger();
      await expect(verifyMcpTarball(file, hash, false, logger)).resolves.toBe(true);

      const bad = stubLogger();
      await expect(verifyMcpTarball(file, '0'.repeat(64), false, bad.logger)).resolves.toBe(false);
      expect(bad.messages[0]).toContain('integrity check failed');

      await expect(verifyMcpTarball(file, '0'.repeat(64), true, logger)).rejects.toThrow(
        'Checksum mismatch',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
