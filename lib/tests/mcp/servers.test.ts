import { describe, expect, it } from 'vitest';
import { MCP_PACKAGE_VERSIONS, context7Server, githubMCPServer } from '../../src/mcp/servers.js';

const CONTEXT7_PACKAGE = '@upstash/context7-mcp';
const GITHUB_PACKAGE = '@modelcontextprotocol/server-github';

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
