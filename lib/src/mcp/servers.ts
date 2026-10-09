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
import { extractNpmPackageName } from '../utils/safe-exec.js';

/**
 * Module-scoped fallback logger for the warn-only MCP helpers when callers
 * do not pass their own logger. Single shared instance (no per-call
 * construction).
 */
const fallbackLogger = new Logger('MCPManager');

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
 * Parse an npx package spec (`name@version`) from a single command argument.
 * Shares name-splitting with `extractNpmPackageName` in
 * `../utils/safe-exec.js` (scoped packages split on the last `@` after
 * position 0) so the two parsers cannot diverge. Returns null for malformed
 * specs (fail-open: callers warn-and-continue rather than throwing).
 *
 * NOTE: no version-shape validation here — tags/ranges (`latest`, `^1.2.3`,
 * `>=1.0`) parse successfully and are rejected later by
 * {@link isAllowedMcpPackage} with a specific non-exact-version warning.
 * @param arg - Single command argument (e.g. `@upstash/context7-mcp@3.2.5`).
 * @returns The parsed `{ name, version }`, or null when not a `name@version` spec.
 * @since NEXT
 */
export function parseNpxPackageSpec(arg: string): { name: string; version: string } | null {
  if (typeof arg !== 'string' || arg.trim() === '') return null;
  const spec = arg.trim();
  const name = extractNpmPackageName(spec);
  // No version suffix (bare name) or empty remainder → not a name@version spec.
  if (name === spec) return null;
  const version = spec.slice(name.length + 1);
  if (name === '' || version === '') return null;
  return { name, version };
}

/**
 * Launchers that fetch and execute a registry package (`npx`/`uvx`/`bunx`).
 * Only for these launchers does a missing package spec indicate an unpinned
 * supply-chain risk; other launchers (`node`, `python3`, `deno`) run local
 * code and have no registry spec to check.
 * @since NEXT
 */
export const PACKAGE_RUNNER_LAUNCHERS: ReadonlySet<string> = new Set(['npx', 'uvx', 'bunx']);

/**
 * Whether a command vector is launched via a registry package runner.
 * @param command - Command vector (e.g. `['npx', '-y', 'pkg@1.2.3']`).
 * @returns True when the launcher is `npx`, `uvx`, or `bunx`.
 * @since NEXT
 */
export function isPackageRunnerCommand(command: readonly string[]): boolean {
  if (!Array.isArray(command) || command.length === 0) return false;
  const launcher = command[0];
  return typeof launcher === 'string' && PACKAGE_RUNNER_LAUNCHERS.has(launcher.trim());
}

/**
 * Opt-in strict enforcement for the MCP pinned-version allowlist.
 * Mirrors the `require_opencode_checksum` pattern: default false (fail-open
 * warn-and-continue); when `MCP_REQUIRE_PINNED=true` (or the GitHub Action
 * input form `INPUT_MCP_REQUIRE_PINNED=true`) unpinned specs are skipped
 * instead of executed.
 * @returns True when unpinned MCP packages must be skipped.
 * @since NEXT
 */
export function resolveMcpStrictPins(): boolean {
  for (const key of ['MCP_REQUIRE_PINNED', 'INPUT_MCP_REQUIRE_PINNED'] as const) {
    const raw = process.env[key]?.trim().toLowerCase();
    if (raw === 'true' || raw === '1') return true;
  }
  return false;
}

/**
 * Find ALL npx package specs (`name@version`) in a command vector.
 * Unlike {@link findNpxPackageSpec} (first match only, kept for
 * backward compatibility), this returns every spec so a command with a
 * pinned first arg plus a second unpinned package arg cannot hide the
 * unpinned one from the allowlist check. Single-pass: each arg is parsed at
 * most once and the parsed result is reused. Flag-shaped args (`-y`,
 * `--quiet`, `--flag=value`) and URL-looking args (containing `://`) are
 * skipped so flag values or registry URLs are never misidentified as the
 * package spec.
 * @param command - Command vector (e.g. `['npx', '-y', 'pkg@1.2.3']`).
 * @returns Every parsed `{ name, version }` in order (possibly empty).
 * @since NEXT
 */
export function findAllNpxPackageSpecs(
  command: readonly string[],
): Array<{ name: string; version: string }> {
  if (!Array.isArray(command)) return [];
  const specs: Array<{ name: string; version: string }> = [];
  for (const arg of command) {
    if (typeof arg !== 'string') continue;
    const trimmed = arg.trim();
    if (trimmed === '' || trimmed.startsWith('-') || trimmed.includes('://')) continue;
    const parsed = parseNpxPackageSpec(trimmed);
    if (parsed) specs.push(parsed);
  }
  return specs;
}

/**
 * Find the first npx package spec (`name@version`) in a command vector.
 * Single-pass: each arg is parsed at most once and the parsed result is
 * reused, so the predicate and the returned value cannot diverge. Flag-shaped
 * args (`-y`, `--quiet`, `--flag=value`) and URL-looking args (containing
 * `://`) are skipped so flag values or registry URLs are never misidentified
 * as the package spec.
 *
 * NOTE: returns only the first spec. Callers enforcing a supply-chain
 * allowlist should use {@link findAllNpxPackageSpecs} and check every spec —
 * checking only the first lets a second unpinned package arg slip through.
 * @param command - Command vector (e.g. `['npx', '-y', 'pkg@1.2.3']`).
 * @returns The first parsed `{ name, version }`, or null when none is present.
 * @since NEXT
 */
export function findNpxPackageSpec(
  command: readonly string[],
): { name: string; version: string } | null {
  const all = findAllNpxPackageSpecs(command);
  return all.length > 0 ? (all[0] as { name: string; version: string }) : null;
}

/** Minimal logger shape needed by {@link isAllowedMcpPackage}. */
export interface WarnLogger {
  warn(message: string): void;
}

/**
 * Whether a version string is an exact pinned-version shape (`X.Y.Z`,
 * optionally with a pre-release/build suffix, or a date version such as
 * `2025.4.8`). Tags (`latest`), ranges (`^1.2.3`, `>=1.0`), and dist-tags
 * fail this check so callers can warn specifically about non-exact versions.
 * @param version - Version string from a parsed npx spec.
 * @returns True when the version looks like an exact pin.
 * @since NEXT
 */
export function isExactVersionShape(version: string): boolean {
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version.trim());
}

/**
 * Whether an MCP npm `name@version` pair matches the pinned
 * {@link MCP_PACKAGE_VERSIONS} allowlist. Strict equality on both name and
 * version; unknown pairs return false (fail-open: callers warn-and-continue
 * by default, never throw).
 *
 * WARN-ONLY (telemetry, not enforcement): this function never blocks an
 * install — a `false` verdict means "not pinned, proceed with extra caution",
 * not "refused". Call sites MUST act on the return value (at minimum log a
 * loud fail-open warning); discarding it is security theater.
 * @param packageName - npm package name (e.g. `@upstash/context7-mcp`).
 * @param version - Exact version string (e.g. `3.2.5`).
 * @param logger - Optional logger for the mismatch warning (avoids per-call
 * `new Logger()` so callers pass `this.logger` for consistent/testable logs).
 * When omitted the function stays silent and just returns the verdict.
 * @returns True only for pinned name-plus-version pairs.
 * @since NEXT
 */
export function isAllowedMcpPackage(
  packageName: string,
  version: string,
  logger?: WarnLogger,
): boolean {
  const pinned = MCP_PACKAGE_VERSIONS[packageName];
  if (pinned !== undefined && pinned === version) return true;
  try {
    const detail = !isExactVersionShape(version)
      ? ` (version "${version}" is not an exact pin — tags/ranges such as "latest", "^x.y.z", ">=x.y" never match; pin the exact version)`
      : pinned !== undefined
        ? ` (pinned version is ${pinned})`
        : '';
    logger?.warn(
      `MCP package "${packageName}@${version}" is not on the pinned allowlist${detail}` +
        ' — continuing fail-open (warn-only, install NOT blocked). Pin the version in MCP_PACKAGE_VERSIONS to silence this.',
    );
  } catch {
    /* logging must never throw */
  }
  return false;
}

/**
 * Expected shape of a sha256 hex digest (64 lowercase hex chars).
 * @since NEXT
 */
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Verify a downloaded MCP tarball against a known sha256 before npx spawn.
 * Reuses `verifyChecksum()` (streaming sha256, statically imported per repo
 * ESM convention). Fail-open by default: a missing hash warns and returns
 * false (continue); a mismatch warns and returns false unless `strict` is
 * true, in which case the mismatch error is re-thrown (fail fast with
 * pin-plus-sha256 remediation, mirroring the `require_opencode_checksum`
 * pattern).
 *
 * OPT-IN utility (not auto-wired): `MCPManager.connect()` spawns `npx`
 * directly and never materializes a tarball file, so there is no artifact to
 * verify on that path. Callers that DO download a tarball (e.g. a future
 * prefetch/offline-install flow) should call this before spawn. The return
 * value distinguishes only verified (`true`) vs unverified (`false`); the
 * log line distinguishes the unverified cause ("No checksum available" vs
 * "integrity check failed" vs "malformed checksum").
 * @param tarballPath - Path to the downloaded MCP tarball.
 * @param expectedChecksum - Expected sha256 hex string, or null/undefined when unknown.
 * @param strict - When true, re-throw mismatches instead of warn-and-continue.
 * @param logger - Optional logger for warnings (avoids per-call `new Logger()`).
 * When omitted a module-scoped fallback logger is used so warnings are never lost.
 * @returns True when verified; false when fail-open continuing without verification.
 * @since NEXT
 */
export async function verifyMcpTarball(
  tarballPath: string,
  expectedChecksum: string | null | undefined,
  strict = false,
  logger?: WarnLogger,
): Promise<boolean> {
  const log = logger ?? fallbackLogger;
  if (typeof expectedChecksum !== 'string' || expectedChecksum.trim() === '') {
    log.warn(
      `No checksum available for MCP tarball ${tarballPath} — continuing fail-open. ` +
        'Pin the package version in MCP_PACKAGE_VERSIONS or supply a sha256 to enforce integrity.',
    );
    return false;
  }
  const normalized = expectedChecksum.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    log.warn(
      `Malformed checksum for MCP tarball ${tarballPath} (expected 64 hex chars) — continuing fail-open.`,
    );
    return false;
  }
  try {
    await verifyChecksum(tarballPath, normalized);
    return true;
  } catch (err) {
    if (strict) throw err;
    log.warn(
      `MCP tarball integrity check failed for ${tarballPath} (mismatch vs expected sha256) — continuing fail-open`,
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
