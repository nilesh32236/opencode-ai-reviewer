import { type MCPServerConfig } from '@opencode-pr-agent/lib';
import { type ActionInputs } from './inputs.js';
/**
 * Resolve the validated platform for the main run (fail-closed allowlist).
 * Shared owner is `parsePlatform()` in `utils.ts` so `index.ts`,
 * `post-entry.ts`, and `setup.ts` agree on invalid input: typos such as
 * `PLATFORM=githb` fail instead of silently falling through to GitHub.
 * @returns The normalized platform, or `null` after recording the failure.
 */
export declare function resolvePlatform(): 'github' | 'gitlab' | null;
/**
 * Resolve the repository slug for the current platform.
 * @param platform - Validated platform.
 * @returns `owner/repo` (GitHub) or `namespace/project` (GitLab).
 */
export declare function resolveRepo(platform: 'github' | 'gitlab'): string;
/**
 * Resolve the git commit identity (name + email) for bot commits.
 * Pinned to a stable bot identity (overridable via inputs) so the autofix
 * branch-reuse gate stays stable across triggering actors.
 * @param platform - Validated platform.
 * @returns Git user name and email.
 */
export declare function setupGitIdentity(platform: 'github' | 'gitlab'): {
    gitUser: string;
    gitEmail: string;
};
/**
 * Resolve MCP server configs: explicit `mcp-servers` JSON wins when valid,
 * otherwise fall back to defaults. Invalid JSON/config warns (fail-open to
 * defaults) so a malformed workflow input never blocks the run.
 * @param inputs - Parsed action inputs (gates on `enableMCP`).
 * @param token - Auth token passed to default MCP servers.
 * @returns Resolved MCP server list (empty when MCP is disabled).
 */
export declare function resolveMCPServers(inputs: ActionInputs, token: string): MCPServerConfig[];
