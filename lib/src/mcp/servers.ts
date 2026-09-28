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
 * Check whether a command arg is an npx launcher (basename match).
 * Matches `npx` plus path-qualified (`/usr/bin/npx`) and Windows
 * (`npx.cmd`, `npx.exe`, `npx.ps1`, `npx.bat`, `npx.com`) variants so
 * versionless-npx detection cannot be evaded via launcher path spelling.
 * Used to warn on unpinned npx invocations that yield no parseable
 * `name@version` spec.
 * @param arg - Single command arg; non-strings return false.
 * @returns True when the arg launches npx.
 * @since NEXT
 */
export function isNpxLauncher(arg: unknown): boolean {
  if (typeof arg !== 'string') return false;
  return /(^|[/\\])npx(\.(cmd|exe|ps1|bat|com))?$/i.test(arg.trim());
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
 *   Precedence: `strict` > `requireChecksum` > env vars > default false.
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
 * Resolve whether the MCP package allowlist must fail closed. An explicit
 * option wins; otherwise the `INPUT_STRICT_MCP_ALLOWLIST` env var (or the
 * `STRICT_MCP_ALLOWLIST` alias) applies. Defaults to false so existing
 * workflows keep the warn-and-continue behavior. When true, a local server
 * whose npx package spec is not pinned in {@link MCP_PACKAGE_VERSIONS} is
 * skipped instead of spawned — closing the fail-open gap where a substituted
 * wrong-version package of an allowlisted name would still execute with
 * forwarded credentials.
 * @param options - Optional overrides (`strictMcpAllowlist` / `strict`).
 * @returns True when unpinned MCP packages must be skipped, not spawned.
 * @since NEXT
 */
export function resolveStrictMcpAllowlist(options?: {
  strictMcpAllowlist?: boolean;
  strict?: boolean;
}): boolean {
  if (options?.strictMcpAllowlist !== undefined) return options.strictMcpAllowlist;
  if (options?.strict !== undefined) return options.strict;
  const env = process.env.INPUT_STRICT_MCP_ALLOWLIST ?? process.env.STRICT_MCP_ALLOWLIST;
  return env?.trim().toLowerCase() === 'true';
}

/** Archive extensions that mark a downloaded MCP tarball arg. */
const MCP_TARBALL_EXTENSIONS: readonly string[] = ['.tgz', '.tar.gz', '.tar', '.zip'];

/**
 * Check whether an arg carries a tarball archive extension. The raw arg is
 * tested first (no allocation); the trimmed/lowered copy is only allocated
 * when the arg plausibly carries an extension (contains a dot), so normal
 * npx args such as `pkg@1.2.3` never allocate.
 * @param arg - Single command arg.
 * @returns True when the arg ends with a known tarball extension.
 * @since NEXT
 */
function hasMcpTarballExtension(arg: string): boolean {
  if (MCP_TARBALL_EXTENSIONS.some((ext) => arg.endsWith(ext))) return true;
  if (!arg.includes('.')) return false;
  const lowered = arg.trim().toLowerCase();
  return MCP_TARBALL_EXTENSIONS.some((ext) => lowered.endsWith(ext));
}

/**
 * Find a downloaded MCP tarball path in a local server command array, if any.
 * Matches args ending in `.tgz`, `.tar.gz`, `.tar`, or `.zip` (case-insensitive).
 * Skips CLI flags unless they appear after a `--` separator. Returns null when
 * the server spawns via `npx pkg@ver` with no on-disk tarball, so the
 * tarball-verification path stays opt-in and never warns for normal connects.
 * @param command - Local server command array.
 * @returns The first tarball-like arg (trimmed), or null when absent.
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
    // Skip remote URLs (e.g. https://host/pkg.tgz): only local on-disk
    // tarball paths are verifiable via verifyChecksum. Without this guard a
    // remote URL would be returned as a path, fail to open, and fall into
    // the fail-open path looking like it was checked.
    if (arg.includes('://')) continue;
    if (hasMcpTarballExtension(arg)) {
      return arg.trim();
    }
  }
  return null;
}

/** Shared default logger for MCP tarball helpers so direct callers without an
 * explicit logger share one log context instead of constructing a new
 * `Logger('MCPManager')` per call. Call sites with their own logger
 * (e.g. `MCPManager.connect` → `this.logger`) should pass it explicitly.
 * @since NEXT
 */
const defaultMcpLogger = new Logger('MCPManager');

/**
 * Resolve the expected SHA-256 for a downloaded MCP tarball, if configured.
 * Precedence: the `MCP_TARBALL_SHA256` env var > the `INPUT_MCP_TARBALL_SHA256`
 * alias > per-server `environment.MCP_TARBALL_SHA256`.
 * Workflow-controlled env values are the only trustworthy integrity roots:
 * server entries may come from PR-editable (untrusted) config, so a
 * per-server checksum is self-attested — an attacker controlling the command
 * could supply both the tarball path and a matching hash, making verification
 * vacuous. The self-attested fallback is therefore ignored (null) in strict
 * mode and emits a warning otherwise so operators can distinguish trusted vs
 * self-attested roots. Returns null when unconfigured (fail-open: the
 * caller warns and continues).
 * @param server - MCP server config (reads `environment`), or nullish.
 * @param options - Optional strict enforcement (`strict` / `requireChecksum`);
 *   when strict, self-attested per-server checksums are ignored. Defaults to
 *   the live env resolution when omitted.
 * @param logger - Optional logger for the self-attested fallback warning;
 *   defaults to the shared module-level `MCPManager` logger. Prefer passing
 *   the caller's logger (e.g. `this.logger`) to keep one log context.
 * @returns The trimmed expected hash, or null when unknown (or when only a
 *   self-attested hash exists under strict enforcement).
 * @since NEXT
 */
export function resolveMcpTarballChecksum(
  server?: {
    environment?: Record<string, string>;
  } | null,
  options?: { requireChecksum?: boolean; strict?: boolean },
  logger?: Pick<Logger, 'warn'>,
): string | null {
  const fromEnv = (
    process.env.MCP_TARBALL_SHA256 ??
    process.env.INPUT_MCP_TARBALL_SHA256 ??
    ''
  ).trim();
  if (fromEnv !== '') return normalizeMcpChecksum(fromEnv, logger);
  const fromServer = server?.environment?.MCP_TARBALL_SHA256?.trim();
  if (!fromServer) return null;
  // Self-attested per-server checksums are ignored by default (not just in
  // strict mode): server entries may come from PR-editable (untrusted) config,
  // so an attacker controlling the command could supply both the tarball path
  // and a matching hash, making verification vacuous. Only workflow-controlled
  // env values are trustworthy integrity roots.
  (logger ?? defaultMcpLogger).warn(
    'Ignoring self-attested per-server MCP_TARBALL_SHA256 (untrusted) — set the MCP_TARBALL_SHA256 workflow env var for a trustworthy integrity root.',
  );
  return null;
}

/**
 * Validate a configured MCP tarball checksum is well-formed SHA-256 hex.
 * A malformed value (non-hex, wrong length) can never match a computed
 * digest, so it would silently produce a generic 'integrity check failed'
 * warning that operators may learn to ignore. Emit a distinct warning and
 * return null (treated as unconfigured) so the failure mode is unmistakable.
 * @param checksum - The trimmed checksum candidate.
 * @param logger - Optional logger for the malformed-checksum warning;
 *   defaults to the shared module-level `MCPManager` logger.
 * @returns The checksum when well-formed, null otherwise.
 * @since NEXT
 */
function normalizeMcpChecksum(checksum: string, logger?: Pick<Logger, 'warn'>): string | null {
  if (/^[a-fA-F0-9]{64}$/.test(checksum)) return checksum;
  (logger ?? defaultMcpLogger).warn(
    `Malformed MCP_TARBALL_SHA256 configured ("${checksum.slice(0, 16)}…") — expected 64 hex characters (sha256). ` +
      'Ignoring it; set a valid checksum to enable integrity verification.',
  );
  return null;
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
 *
 * The boolean return is advisory: only strict mode affects behavior (a throw
 * the caller can act on). In the default fail-open mode a `false` result
 * still connects — callers that need enforcement must enable strict mode.
 *
 * TOCTOU residual risk: the tarball is hashed, then the process is spawned
 * moments later. A local attacker with write access to the tarball path can
 * swap contents after hashing and before npx extracts/runs it. Verification
 * runs immediately before spawn to shrink the window; stronger mitigations
 * (verifying extracted package contents, or relying on npm's own integrity
 * via lockfile/pinned install in addition to the pre-spawn hash) are out of
 * scope for this helper.
 *
 * Performance note: the tarball is streamed and hashed on every connect with
 * no cache. This is intentional — connects run once at startup on small
 * files, so a path+mtime memo would add state without measurable benefit.
 * Revisit with a cache only if tarball checks become a hot per-call path.
 * @param tarballPath - Path to the downloaded MCP tarball on disk.
 * @param expectedChecksum - Expected SHA-256 hex string, or null when unknown.
 * @param options - Optional strict enforcement (`strict` / `requireChecksum`).
 *   Precedence: `strict` > `requireChecksum` > env vars > default false.
 * @param logger - Optional logger for warnings; defaults to the shared
 *   module-level `MCPManager` logger so direct callers work without one.
 *   Prefer passing the caller's logger (e.g. `this.logger` in
 *   `MCPManager.connect`) to keep one log context for the whole connect flow.
 * @returns True when the checksum verified; false when skipped/failed-open
 *   (advisory — only strict mode changes connect behavior).
 * @throws When strict mode is on and the hash is missing or mismatched.
 * @since NEXT
 */
export async function verifyMcpTarball(
  tarballPath: unknown,
  expectedChecksum?: string | null,
  options?: { requireChecksum?: boolean; strict?: boolean },
  logger: Pick<Logger, 'warn'> = defaultMcpLogger,
): Promise<boolean> {
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
    const normalizedPath = tarballPath.trim();
    if (strict) {
      throw new Error(
        `MCP integrity verification failed: no checksum available for ${normalizedPath} and strict MCP checksum enforcement is enabled. ` +
          'Pin the MCP package to a version in MCP_PACKAGE_VERSIONS (lib/src/mcp/servers.ts) and record its manually verified sha256, ' +
          'or re-run without strict enforcement at your own risk (this disables integrity protection).',
      );
    }
    logger.warn(
      `No checksum available for MCP tarball ${normalizedPath} — skipping integrity verification (fail-open).`,
    );
    return false;
  }
  // Normalize once so detection, verification, and log messages all use the
  // same value: a padded path would otherwise fail to open (ENOENT) and fall
  // into the fail-open warn path even though the trimmed path would verify.
  const normalizedPath = tarballPath.trim();
  const normalizedChecksum = expectedChecksum.trim();
  try {
    await verifyChecksum(normalizedPath, normalizedChecksum);
    return true;
  } catch (err) {
    if (strict) throw err;
    logger.warn(
      `MCP tarball integrity check failed for ${normalizedPath} — continuing fail-open. ` +
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
    defaultMcpLogger.warn('CONTEXT7_API_KEY is empty — MCP server may fail');
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
export function githubMCPServer(token: string): MCPServerConfig {
  if (!githubTokenWarningLogged) {
    githubTokenWarningLogged = true;
    defaultMcpLogger.warn(
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
}

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
    map[server.name] = toV1ServerEntry(server);
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
    map[server.name] = toV2ServerEntry(server);
  }
  return map;
}
