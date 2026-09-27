/**
 * Pre-configured MCP server definitions.
 * Users can import these and merge with their own configs.
 *
 * SECURITY: Local MCP server subprocesses (npx commands) receive only an
 * allowlisted subset of the parent environment (see filterEnv in client.ts)
 * plus the explicit `environment` overrides below, which include CONTEXT7_API_KEY
 * and GITHUB_TOKEN. These credentials are visible to any npm package executed by
 * the MCP server. Only use trusted MCP server packages and consider running MCP
 * servers in a sandboxed environment.
 */

import type { MCPServerConfig } from '../types/index.js';
import { verifyChecksum } from '../utils/checksum.js';
import { Logger } from '../utils/logger.js';

/**
 * Exact pinned versions of MCP server npm packages.
 * Pinning prevents `npx` from auto-installing the latest release, mitigating
 * supply-chain attacks via compromised or typosquatted packages (audit 4.2).
 *
 * Warn-only CI check `.github/scripts/check-mcp-pins.sh` verifies these pins
 * against `pnpm-lock.yaml` (fail-open, never fails the build).
 * @since NEXT
 */
export const MCP_PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  '@upstash/context7-mcp': '3.2.5',
  '@modelcontextprotocol/server-github': '2025.4.8',
};

/**
 * Minimal npm package-name syntax check used to reject false-positive
 * `name@version` parses from non-package args (emails, registry URLs).
 * Covers unscoped (`pkg`) and scoped (`@scope/pkg`) names; full registry
 * validation is intentionally out of scope — this is a warn-and-continue
 * heuristic, not an install gate.
 */
const NPM_PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*|[a-z0-9-~][a-z0-9-._~]*)$/i;

/**
 * Parse an `npx` package spec (`name@version`) from a single command arg.
 * Handles scoped packages (`@scope/pkg@1.2.3`) by splitting on the last `@`
 * after position 0. Returns null for malformed specs (no version separator,
 * empty name/version) so callers stay fail-open.
 * @param arg - Single command-line arg (e.g. `@upstash/context7-mcp@3.2.5`).
 * Accepts `unknown` at runtime because command arrays may come from
 * PR-editable config; non-strings return null.
 * @returns The `{ name, version }` pair, or null when unparseable.
 * @since NEXT
 */
export function parseNpxPackageSpec(arg: unknown): { name: string; version: string } | null {
  if (typeof arg !== 'string') return null;
  const trimmed = arg.trim();
  if (trimmed === '') return null;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;
  const name = trimmed.slice(0, at).trim();
  const version = trimmed.slice(at + 1).trim();
  if (name === '' || version === '') return null;
  return { name, version };
}

/**
 * Extract the first parseable `name@version` package spec from an npx-style
 * command array. Scans every arg so flag order (`npx -y --quiet pkg@ver`)
 * does not matter. Returns null when no arg carries a version separator
 * (e.g. custom `node server.js` commands with nothing to allowlist-check).
 *
 * False-positive guard: args starting with `-` are skipped unless they appear
 * after a `--` separator, args containing `://` (registry URLs such as
 * `--registry=https://user@host`) are skipped, and the parsed name must match
 * minimal npm package syntax. Remaining edge cases (e.g. a bare `a@b` arg)
 * stay warn-and-continue by design — never blocking.
 * @param command - Local server command array (e.g. `['npx', '-y', 'pkg@1.2.3']`).
 * Accepts `unknown` at runtime; non-array or non-string entries return/skip null.
 * @returns The first `{ name, version }` pair, or null when absent/malformed.
 * @since NEXT
 */
export function findNpxPackageSpec(
  command: readonly unknown[],
): { name: string; version: string } | null {
  if (!Array.isArray(command)) return null;
  let seenSeparator = false;
  for (const arg of command) {
    if (typeof arg !== 'string') continue;
    if (arg === '--') {
      seenSeparator = true;
      continue;
    }
    // Fast-path: only args with a version separator can parse.
    if (!arg.includes('@')) continue;
    // Skip CLI flags (e.g. `--registry=...`) unless after `--`.
    if (!seenSeparator && arg.startsWith('-')) continue;
    // Skip registry URLs / auth-embedded URLs (e.g. `https://user@host`).
    if (arg.includes('://')) continue;
    const spec = parseNpxPackageSpec(arg);
    if (!spec) continue;
    if (!NPM_PACKAGE_NAME_PATTERN.test(spec.name)) continue;
    return spec;
  }
  return null;
}

/**
 * Check whether an MCP `name@version` pair matches the pinned
 * {@link MCP_PACKAGE_VERSIONS} allowlist. Strict equality on both name and
 * version. Pure predicate — it never logs; callers emit the single
 * contextual warning so unpinned packages log exactly once per connect.
 *
 * The allowlist lives in-code (no file IO), so there is no unreadable-file
 * path — verification is always a pure version-pin comparison.
 * @param packageName - npm package name (e.g. `@upstash/context7-mcp`).
 * @param version - Exact version string (e.g. `3.2.5`).
 * @returns True only for pinned name-plus-version pairs; false otherwise.
 * @since NEXT
 */
export function isAllowedMcpPackage(packageName: string, version: string): boolean {
  const pinned = MCP_PACKAGE_VERSIONS[packageName];
  return pinned !== undefined && pinned === version;
}

/**
 * Resolve whether MCP tarball checksum enforcement is on. An explicit option
 * wins; otherwise the `INPUT_REQUIRE_MCP_CHECKSUM` env var (or the
 * `REQUIRE_MCP_CHECKSUM` alias) applies. Defaults to false so existing
 * workflows keep the warn-and-continue behavior. Mirrors
 * `resolveRequireChecksum` in `opencode.ts`.
 * @param options - Optional overrides (`requireChecksum` / `strict`).
 * @returns True when unverified MCP tarballs must fail closed.
 * @since NEXT
 */
export function resolveRequireMcpChecksum(options?: {
  requireChecksum?: boolean;
  strict?: boolean;
}): boolean {
  if (options?.strict !== undefined) return options.strict;
  if (options?.requireChecksum !== undefined) return options.requireChecksum;
  const env = process.env.INPUT_REQUIRE_MCP_CHECKSUM ?? process.env.REQUIRE_MCP_CHECKSUM;
  return env?.trim().toLowerCase() === 'true';
}

/**
 * Find a downloaded MCP tarball path in a local server command array, if any.
 * Matches args ending in `.tgz`, `.tar.gz`, `.tar`, or `.zip` (case-insensitive).
 * Skips CLI flags unless they appear after a `--` separator. Returns null when
 * the server spawns via `npx pkg@ver` with no on-disk tarball, so the
 * tarball-verification path stays opt-in and never warns for normal connects.
 * @param command - Local server command array.
 * @returns The first tarball-like arg, or null when absent.
 * @since NEXT
 */
export function findMcpTarballPath(command: readonly unknown[]): string | null {
  if (!Array.isArray(command)) return null;
  let seenSeparator = false;
  for (const arg of command) {
    if (typeof arg !== 'string') continue;
    if (arg === '--') {
      seenSeparator = true;
      continue;
    }
    if (!seenSeparator && arg.startsWith('-')) continue;
    const lowered = arg.trim().toLowerCase();
    if (
      lowered.endsWith('.tgz') ||
      lowered.endsWith('.tar.gz') ||
      lowered.endsWith('.tar') ||
      lowered.endsWith('.zip')
    ) {
      return arg;
    }
  }
  return null;
}

/**
 * Resolve the expected SHA-256 for a downloaded MCP tarball, if configured.
 * Precedence: per-server `environment.MCP_TARBALL_SHA256` > the
 * `MCP_TARBALL_SHA256` env var > the `INPUT_MCP_TARBALL_SHA256` alias.
 * Returns null when unconfigured (fail-open: the caller warns and continues).
 * @param server - MCP server config (reads `environment`), or nullish.
 * @returns The trimmed expected hash, or null when unknown.
 * @since NEXT
 */
export function resolveMcpTarballChecksum(
  server?: {
    environment?: Record<string, string>;
  } | null,
): string | null {
  const fromServer = server?.environment?.MCP_TARBALL_SHA256?.trim();
  if (fromServer) return fromServer;
  const fromEnv = (
    process.env.MCP_TARBALL_SHA256 ??
    process.env.INPUT_MCP_TARBALL_SHA256 ??
    ''
  ).trim();
  return fromEnv !== '' ? fromEnv : null;
}

/**
 * Verify a downloaded MCP tarball against an expected SHA-256 before spawn.
 * Reuses {@link verifyChecksum} from `utils/checksum.ts`; streaming sha256
 * runs only when a file path plus hash are both present (allowlist compares
 * stay under ~5 ms, no extra network queries).
 *
 * Fail-open by default: a missing hash logs a warning and returns false so
 * the caller continues; a mismatch logs a warning and returns false. Strict
 * mode (opt-in via `options` or `INPUT_REQUIRE_MCP_CHECKSUM`) throws instead
 * with pin-plus-sha256 remediation.
 * @param tarballPath - Path to the downloaded MCP tarball on disk.
 * @param expectedChecksum - Expected SHA-256 hex string, or null when unknown.
 * @param options - Optional strict enforcement (`strict` / `requireChecksum`).
 * @returns True when the checksum verified; false when skipped/failed-open.
 * @throws When strict mode is on and the hash is missing or mismatched.
 * @since NEXT
 */
export async function verifyMcpTarball(
  tarballPath: unknown,
  expectedChecksum?: string | null,
  options?: { requireChecksum?: boolean; strict?: boolean },
): Promise<boolean> {
  const logger = new Logger('MCPManager');
  const strict = resolveRequireMcpChecksum(options);
  if (typeof tarballPath !== 'string' || tarballPath.trim() === '') {
    if (strict) {
      throw new Error(
        'MCP integrity verification failed: no tarball path provided and strict MCP checksum enforcement is enabled. ' +
          'Provide a downloaded tarball path plus its expected sha256, or re-run without strict enforcement at your own risk.',
      );
    }
    logger.warn('No MCP tarball path provided — skipping integrity verification (fail-open).');
    return false;
  }
  if (typeof expectedChecksum !== 'string' || expectedChecksum.trim() === '') {
    if (strict) {
      throw new Error(
        `MCP integrity verification failed: no checksum available for ${tarballPath} and strict MCP checksum enforcement is enabled. ` +
          'Pin the MCP package to a version in MCP_PACKAGE_VERSIONS (lib/src/mcp/servers.ts) and record its manually verified sha256, ' +
          'or re-run without strict enforcement at your own risk (this disables integrity protection).',
      );
    }
    logger.warn(
      `No checksum available for MCP tarball ${tarballPath} — skipping integrity verification (fail-open).`,
    );
    return false;
  }
  try {
    await verifyChecksum(tarballPath, expectedChecksum.trim());
    return true;
  } catch (err) {
    if (strict) throw err;
    logger.warn(
      `MCP tarball integrity check failed for ${tarballPath} — continuing fail-open. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Context7 MCP server — resolves latest library documentation.
 * Reduces false positives in reviews by providing current API info.
 * Package version is pinned to mitigate supply-chain attacks (audit 4.2).
 *
 * Setup: npm install -g @upstash/context7-mcp
 *
 * @returns MCPServerConfig for the Context7 documentation server
 */
export function context7Server(): MCPServerConfig {
  const apiKey = process.env.CONTEXT7_API_KEY || '';
  if (!apiKey) {
    new Logger('MCPManager').warn('CONTEXT7_API_KEY is empty — MCP server may fail');
  }
  return {
    name: 'context7',
    type: 'local',
    command: [
      'npx',
      '-y',
      '--quiet',
      `@upstash/context7-mcp@${MCP_PACKAGE_VERSIONS['@upstash/context7-mcp']}`,
    ],
    environment: {
      CONTEXT7_API_KEY: apiKey,
    },
  };
}

/** Tracks whether the third-party-token warning has been emitted (log once). */
let githubTokenWarningLogged = false;

/**
 * Reset the log-once flag for the GitHub MCP token warning.
 * Test-only helper so warning assertions stay order-independent within a
 * single process.
 */
export function resetGithubMCPWarningForTesting(): void {
  githubTokenWarningLogged = false;
}

/**
 * GitHub MCP server — provides repository-aware context.
 * Reads files, searches code, understands PR structure.
 * Package version is pinned to mitigate supply-chain attacks (audit 4.2).
 *
 * SECURITY: `token` is passed verbatim into the environment of a third-party
 * npx-executed npm package. Prefer a repo-scoped, minimally-privileged
 * (fine-grained PAT) token; a full-scope PAT exposed to compromised/
 * typosquatted package code would grant broad account access. MCP servers are
 * disabled by default in CI — enable them only with trusted packages, and
 * consider sandboxing the npx subprocess (containers/namespaces).
 * @param token - GitHub personal access token for authentication
 * @returns MCPServerConfig for the GitHub MCP server
 */
export const githubMCPServer = (token: string): MCPServerConfig => {
  if (!githubTokenWarningLogged) {
    githubTokenWarningLogged = true;
    new Logger('MCPManager').warn(
      'Passing full GITHUB_TOKEN to third-party npx MCP server package — ' +
        'prefer a repo-scoped, minimally-privileged token and keep MCP servers ' +
        'disabled by default in CI.',
    );
  }
  return {
    name: 'github',
    type: 'local',
    command: [
      'npx',
      '-y',
      '--quiet',
      `@modelcontextprotocol/server-github@${MCP_PACKAGE_VERSIONS['@modelcontextprotocol/server-github']}`,
    ],
    environment: {
      GITHUB_TOKEN: token,
    },
  };
};

/**
 * Example remote MCP server configuration.
 * Connects to a remote MCP service via Streamable HTTP with automatic SSE
 * fallback (`remoteTransport: 'auto'`). Use `environment` to pass
 * authentication headers. The default Streamable HTTP endpoint (`/mcp`) is
 * tried first without fallback cost; legacy SSE-only endpoints (`/sse`)
 * will exercise the automatic SSE fallback path.
 * @param url - URL of the remote MCP server endpoint (Streamable HTTP or SSE)
 * @returns MCPServerConfig for a remote MCP server
 */
export function exampleRemoteServer(url = 'https://mcp.example.com/mcp'): MCPServerConfig {
  return {
    name: 'example-remote',
    type: 'remote',
    url,
    timeoutMs: 10000,
  };
}

/**
 * Default MCP configuration for typical use.
 * Includes Context7 for docs.
 * @param githubToken - GitHub personal access token (may be empty if not available)
 * @returns Array of default MCP server configurations
 */
export function getDefaultMCPServers(githubToken: string): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [context7Server()];
  if (githubToken) {
    servers.push(githubMCPServer(githubToken));
  }
  return servers;
}

/**
 * Serialize one internal {@link MCPServerConfig} to its legacy V1 wire shape
 * (`mcp: { <name>: {...} }` map entry).
 *
 * Internal-only fields (`name`, `allowedTools`, `allowedEnv`, `timeoutMs`,
 * `remoteTransport`) are stripped: the remaining fields are client-side
 * connection policy, not CLI config. Optional `cwd` (local servers only) and
 * `disabled` pass through when present so spawned servers start in the right
 * directory and respect disable toggles; absent/invalid values are omitted
 * (fail-open, output matches the prior shape).
 * @param server - The internal server config to serialize.
 * @returns The V1 wire entry (without the server name key).
 * @since NEXT
 */
export function toV1ServerEntry(server: MCPServerConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: server.type };
  if (server.type === 'local') {
    if (server.command !== undefined) entry.command = [...server.command];
    if (server.environment !== undefined) entry.environment = { ...server.environment };
    // @since NEXT: optional cwd passthrough (fail-open: omit when absent/blank).
    if (typeof server.cwd === 'string' && server.cwd.trim() !== '') entry.cwd = server.cwd;
  } else {
    if (server.url !== undefined) entry.url = server.url;
    // Remote entries carry auth material as `headers` (not `environment`) per
    // the opencode MCP servers schema — see https://opencode.ai/docs/mcp/servers/.
    if (server.environment !== undefined) entry.headers = { ...server.environment };
  }
  // @since NEXT: optional disabled passthrough (fail-open: omit unknown values).
  if (typeof server.disabled === 'boolean') entry.disabled = server.disabled;
  return entry;
}

/**
 * Serialize a list of servers to the legacy V1 `mcp` map shape.
 * @param servers - The internal server configs to serialize.
 * @returns Map of server name → V1 wire entry.
 * @since NEXT
 */
export function toV1ServersMap(
  servers: MCPServerConfig[],
): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const server of servers ?? []) {
    if (!server || typeof server.name !== 'string' || !server.name) continue;
    try {
      map[server.name] = toV1ServerEntry(server);
    } catch {
      // Fail-open: serializer errors fall back to the prior minimal shape.
      map[server.name] = { type: server.type };
    }
  }
  return map;
}

/**
 * Serialize one internal {@link MCPServerConfig} to its V2 wire shape
 * (`mcp.servers.<name>` map entry). Identical to {@link toV1ServerEntry}
 * (including optional `cwd` passthrough) plus the V2 `disabled` flag
 * (`false` = enabled, the default when unset or non-boolean).
 * @param server - The internal server config to serialize.
 * @returns The V2 wire entry (without the server name key).
 * @since NEXT
 */
export function toV2ServerEntry(server: MCPServerConfig): Record<string, unknown> {
  return {
    ...toV1ServerEntry(server),
    disabled: typeof server.disabled === 'boolean' ? server.disabled : false,
  };
}

/**
 * Serialize a list of servers to the V2 `mcp.servers` map shape.
 * @param servers - The internal server configs to serialize.
 * @returns Map of server name → V2 wire entry (each carrying `disabled`).
 * @since NEXT
 */
export function toV2ServersMap(
  servers: MCPServerConfig[],
): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const server of servers ?? []) {
    if (!server || typeof server.name !== 'string' || !server.name) continue;
    try {
      map[server.name] = toV2ServerEntry(server);
    } catch {
      // Fail-open: serializer errors fall back to the prior minimal shape.
      map[server.name] = { type: server.type, disabled: false };
    }
  }
  return map;
}
