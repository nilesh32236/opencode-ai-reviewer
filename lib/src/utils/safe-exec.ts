import * as net from 'node:net';
import * as path from 'node:path';

/**
 * Trust-boundary helpers for PR-editable repository configuration.
 *
 * `.opencode-reviewer.yml` is read from the PR checkout (see `loadConfig()` in
 * config.ts), so every value in it is attacker-controlled on hostile PRs.
 * Values that reach execution sinks (`child_process.execFile`, dynamic
 * `import()`, MCP transports, `fetch`, filesystem writes) must pass through
 * the guards in this module:
 *
 * - Linter binaries are constrained to a basename allowlist (no paths, no
 *   shell metacharacters) and working directories are confined to the checkout.
 * - Local MCP server commands are constrained to a launcher allowlist and
 *   remote MCP URLs must pass the same SSRF policy as webhook URLs.
 * - Pluggable event subscribers are default-denied unless the operator opts in
 *   via `OPENCODE_ENABLE_EVENT_SUBSCRIBERS=1`.
 * - Host checks canonicalize alternate IP representations (decimal, octal,
 *   hex, IPv4-mapped IPv6) so SSRF guards cannot be bypassed. The check stays
 *   purely synchronous by design: no DNS lookups are performed (CI sandboxes
 *   may block DNS, and fail-closed-on-resolution-failure would break legitimate
 *   webhooks on transient DNS errors).
 */

// ─── Linter commands ────────────────────────────────────────────

/**
 * Basename allowlist for `linters[].command` from repo-file config.
 * Only bare binary basenames resolved via `PATH` are permitted — never paths,
 * never generic runners (`sh`, `bash`, `node`, `python`, `curl`, `wget`,
 * `npx`, `npm`, ...) which are arbitrary-code primitives on their own via
 * config-controlled `args`. Operators needing an extra binary can extend the
 * set with `OPENCODE_ALLOWED_LINTERS` (comma-separated basenames, same
 * structural rules apply).
 */
export const ALLOWED_LINTER_COMMANDS: ReadonlySet<string> = new Set([
  'eslint',
  'prettier',
  'ruff',
  'tsc',
  'biome',
  'stylelint',
  'flake8',
  'pylint',
  'mypy',
  'black',
  'isort',
  'rubocop',
  'golangci-lint',
  'gofmt',
  'go',
  'cargo',
  'clippy-driver',
  'shellcheck',
  'hadolint',
  'yamllint',
  'actionlint',
  'tflint',
  'phpcs',
  'php-cs-fixer',
  'ktlint',
  'swiftlint',
  'scalafmt',
  'dart',
  'flutter',
  'dotnet',
]);

/** Shell metacharacters / separators that must never appear in a command basename. */
const UNSAFE_COMMAND_CHARS = /[/\\:;&|$`(){}!*?~#<>\n\r\0'"[\]%]/;

/**
 * Check whether a configured linter command is safe to execute.
 * Requires a bare basename on the allowlist: rejects absolute paths, relative
 * paths, `..` segments, and shell metacharacters. Extra operator-approved
 * basenames from `OPENCODE_ALLOWED_LINTERS` are honored with the same
 * structural rules.
 * @param cmd - Configured `linters[].command` value.
 * @returns True when the command may be executed via `execFile`.
 */
export function isAllowedLinterCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  const value = cmd.trim();
  if (value !== cmd || value.length > 128) return false;
  if (value.includes('..') || UNSAFE_COMMAND_CHARS.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  if (path.basename(value) !== value) return false;
  if (ALLOWED_LINTER_COMMANDS.has(value)) return true;
  const extra = (process.env.OPENCODE_ALLOWED_LINTERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (extra.length > 0 && extra.includes(value)) {
    if (extra.some((s) => UNSAFE_COMMAND_CHARS.test(s) || s.includes('..'))) return false;
    return true;
  }
  return false;
}

// ─── Path confinement ───────────────────────────────────────────

/**
 * Check whether `requested` resolves inside `base` (the checkout working dir).
 * Rejects absolute escapes and `..` traversal. Both arguments may be relative;
 * they are resolved against `process.cwd()` first.
 * @param base - Trusted base directory (the checkout working dir).
 * @param requested - Untrusted configured path.
 * @returns True when the resolved path stays inside the base.
 */
export function isConfinedPath(base: string, requested: string): boolean {
  if (typeof requested !== 'string' || requested.trim() === '') return false;
  const baseResolved = path.resolve(base);
  const target = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(baseResolved, requested);
  const rel = path.relative(baseResolved, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve an untrusted configured working directory against the checkout dir,
 * returning null when it would escape the checkout.
 * @param workDir - Trusted checkout working directory.
 * @param requested - Untrusted `workingDirectory` value (may be undefined).
 * @returns The confined absolute directory, or null when it escapes.
 */
export function resolveConfinedWorkingDir(workDir: string, requested?: string): string | null {
  if (requested === undefined || requested === null || String(requested).trim() === '') {
    return path.resolve(workDir);
  }
  const value = String(requested);
  const baseResolved = path.resolve(workDir);
  const target = path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseResolved, value);
  const rel = path.relative(baseResolved, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

// ─── Event subscribers / event log ──────────────────────────────

/** Default event-log path (relative to the checkout working dir). */
export const DEFAULT_EVENT_LOG_PATH = '.opencode/events.ndjson';

/** Operator opt-in gate for PR-editable pluggable event subscribers. */
export const EVENT_SUBSCRIBERS_ENV = 'OPENCODE_ENABLE_EVENT_SUBSCRIBERS';

/**
 * Whether pluggable `eventSubscribers` from repo-file config may be loaded.
 * Default-deny: repo-file subscriber entries execute arbitrary checkout code
 * via dynamic `import()` on the CI runner, so they require explicit operator
 * opt-in (`OPENCODE_ENABLE_EVENT_SUBSCRIBERS=1`).
 * @returns True only when the operator explicitly enabled subscribers.
 */
export function isEventSubscribersEnabled(): boolean {
  const raw = (process.env[EVENT_SUBSCRIBERS_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Resolve an untrusted configured event-log path against the checkout dir.
 * Absolute paths and `..` escapes are rejected (fail-closed → null) so a
 * hostile value cannot append/rename arbitrary runner files.
 * @param workDir - Trusted checkout working directory.
 * @param requested - Untrusted `eventLogging.path` value (may be undefined).
 * @returns The confined absolute log path, or null when it escapes.
 */
export function resolveConfinedEventLogPath(workDir: string, requested?: string): string | null {
  const value =
    typeof requested === 'string' && requested.trim() !== ''
      ? requested.trim()
      : DEFAULT_EVENT_LOG_PATH;
  if (path.isAbsolute(value)) return null;
  const baseResolved = path.resolve(workDir);
  const target = path.resolve(baseResolved, value);
  const rel = path.relative(baseResolved, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (path.extname(target) === '') return null;
  return target;
}

// ─── MCP commands ───────────────────────────────────────────────

/**
 * Basename allowlist for the launcher of local MCP servers (`mcpServers[].command[0]`).
 * Local MCP subprocesses receive credentials via `environment` (e.g.
 * `GITHUB_TOKEN`), so only well-known launchers are permitted — never shells
 * and never absolute/relative paths. Server arguments remain operator-visible
 * in config review; prefer the pinned built-in servers from `mcp/servers.ts`.
 */
export const ALLOWED_MCP_LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  'npx',
  'node',
  'python3',
  'python',
  'uvx',
  'bunx',
  'deno',
]);

/**
 * Check whether a local MCP server command vector is safe to spawn.
 * Requires a non-empty argv whose launcher is a bare basename on the launcher
 * allowlist (no paths, no shell metacharacters).
 * @param command - Configured `mcpServers[].command` vector.
 * @returns True when the vector may be spawned via `StdioClientTransport`.
 */
export function isAllowedMcpLocalCommand(command: unknown): boolean {
  if (!Array.isArray(command) || command.length === 0) return false;
  const launcher = command[0];
  if (typeof launcher !== 'string' || launcher.trim() === '' || launcher !== launcher.trim()) {
    return false;
  }
  if (launcher.includes('..') || UNSAFE_COMMAND_CHARS.test(launcher)) return false;
  if (path.isAbsolute(launcher)) return false;
  if (path.basename(launcher) !== launcher) return false;
  return ALLOWED_MCP_LOCAL_COMMANDS.has(launcher);
}

// ─── SSRF host policy (synchronous canonicalization) ────────────

/** Hostnames that always resolve to internal/metadata endpoints. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'metadata.azure.internal',
  'instance-data',
  'instance-data-compute',
  'rancher-metadata',
]);

/** Suffixes for internal-only DNS zones. */
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home', '.corp'];

/**
 * Parse one numeric IP part in decimal, octal (`0...`), or hex (`0x...`) form.
 * Returns null when the part is not numeric.
 * @param part - Single dot-separated host segment.
 * @returns The parsed integer, or null when not a valid numeric form.
 */
function parseNumericPart(part: string): number | null {
  if (/^0x[0-9a-fA-F]+$/.test(part)) return Number.parseInt(part, 16);
  if (/^0[0-7]*$/.test(part) && part.length > 1) return Number.parseInt(part, 8);
  if (/^[0-9]+$/.test(part)) {
    const n = Number.parseInt(part, 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Convert an `inet_aton`-style host (`2130706433`, `0x7f.0.0.1`, `0177.0.0.1`,
 * `127.1`, `10.0.1`) to four IPv4 bytes. Returns null when the host is not a
 * fully numeric address form.
 * @param host - Lowercased host string without port or brackets.
 * @returns The four IPv4 bytes, or null when not an alternate numeric form.
 */
function parseAlternateIPv4(host: string): [number, number, number, number] | null {
  if (!/^[0-9a-fA-Fx.]+$/.test(host) || !/[0-9]/.test(host)) return null;
  if (host.includes(':')) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parseNumericPart(part);
    if (n === null || n < 0) return null;
    nums.push(n);
  }
  let bytes: [number, number, number, number] | null = null;
  if (nums.length === 1) {
    const n = nums[0];
    if (n > 0xffffffff) return null;
    bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  } else if (nums.length === 2) {
    const [a, b] = nums;
    if (a > 0xff || b > 0xffffff) return null;
    bytes = [a, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff];
  } else if (nums.length === 3) {
    const [a, b, c] = nums;
    if (a > 0xff || b > 0xff || c > 0xffff) return null;
    bytes = [a, b, (c >>> 8) & 0xff, c & 0xff];
  } else {
    const [a, b, c, d] = nums;
    if ([a, b, c, d].some((n) => n > 0xff)) return null;
    bytes = [a, b, c, d];
  }
  return bytes;
}

/**
 * Check whether four IPv4 bytes fall in a blocked range (loopback, RFC1918,
 * link-local, CGNAT, `0/8`, or cloud-metadata `169.254.169.254` via link-local).
 * @param bytes - Four octets of an IPv4 address.
 * @returns True when the address targets a blocked internal range.
 */
function isBlockedIPv4Bytes(bytes: readonly [number, number, number, number]): boolean {
  const [a, b] = bytes;
  if (a === 127) return true; // loopback 127/8
  if (a === 10) return true; // RFC1918 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 0) return true; // 0/8 ("this network")
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && bytes[2] === 2) return true; // TEST-NET-1 (fail closed)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark testing
  if (a === 203 && b === 0 && bytes[2] === 113) return true; // TEST-NET-3 (fail closed)
  return false;
}

/**
 * Check whether a hostname (URL-decoded `hostname`, lowercased, no brackets)
 * targets a blocked internal endpoint. Canonicalizes alternate IP
 * representations: single-decimal (`2130706433`), octal/hex dotted
 * (`0x7f.0.0.1`, `0177.0.0.1`), short forms (`127.1`), and IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`, `[::ffff:7f00:1]`).
 * @param host - Lowercased hostname without port or brackets.
 * @returns True when the host must be rejected.
 */
export function isBlockedIpHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === '' || h === 'localhost') return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;

  const ipVersion = net.isIP(h);
  if (ipVersion === 4) {
    const bytes = h.split('.').map(Number) as [number, number, number, number];
    return isBlockedIPv4Bytes(bytes);
  }
  if (ipVersion === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fe80:') || h.startsWith('fe80::')) return true; // link-local
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local fc00::/7
    // IPv4-mapped / compatible forms: check the embedded IPv4 tail too.
    const tail = h.split(':').pop() ?? '';
    if (tail.includes('.')) {
      const bytes = tail.split('.').map(Number) as [number, number, number, number];
      if (bytes.length === 4 && bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return isBlockedIPv4Bytes(bytes);
      }
      return true;
    }
    if (h.includes('ffff:')) {
      const hexTail = h.split(':').slice(-2).join('');
      if (/^[0-9a-f]{1,8}$/.test(hexTail)) {
        const n = Number.parseInt(hexTail, 16);
        const bytes: [number, number, number, number] = [
          (n >>> 24) & 0xff,
          (n >>> 16) & 0xff,
          (n >>> 8) & 0xff,
          n & 0xff,
        ];
        return isBlockedIPv4Bytes(bytes);
      }
      return true;
    }
    return false;
  }

  // Alternate numeric representations that URL/net.isIP miss.
  const alt = parseAlternateIPv4(h);
  if (alt) return isBlockedIPv4Bytes(alt);
  if (/^[0-9]+$/.test(h)) {
    const n = Number.parseInt(h, 10);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      return isBlockedIPv4Bytes([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
    }
  }
  return false;
}

/**
 * SSRF policy for remote MCP server URLs from repo-file config: `https:` only,
 * no credentials in the URL, and no blocked/internal hosts (same policy as
 * webhook URLs). Purely synchronous — hostnames that do not parse as IPs are
 * checked against hostname blocklists only (no DNS resolution, by design).
 * @param url - Candidate remote MCP server URL.
 * @returns True when the URL is safe to open an SSE transport to.
 */
export function isSafeRemoteMcpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    return !isBlockedIpHost(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
