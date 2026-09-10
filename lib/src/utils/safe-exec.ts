import * as fs from 'node:fs';
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
 *   webhooks on transient DNS errors). Residual risk: attacker-controlled
 *   hostnames that resolve to internal addresses (DNS rebinding) are out of
 *   scope — pin URLs to operator-known hosts or validate at fetch time (see
 *   `isSafeRemoteMcpUrl`).
 */

// ─── Linter commands ────────────────────────────────────────────

/**
 * Basename allowlist for `linters[].command` from repo-file config.
 * Only bare single-purpose linter/formatter binary basenames resolved via
 * `PATH` are permitted — never paths, never generic runners (`sh`, `bash`,
 * `node`, `python`, `curl`, `wget`, `npx`, `npm`, ...) and never generic
 * language toolchains (`go`, `cargo`, `dotnet`, `dart`, `flutter`, ...) which
 * are arbitrary-code primitives on their own via config-controlled `args`
 * (e.g. `go run evil.go`, `cargo run`, `dotnet run`). Operators needing an
 * extra binary can extend the set with `OPENCODE_ALLOWED_LINTERS`
 * (comma-separated basenames, same structural rules apply) — only add
 * single-purpose binaries, never toolchains or shells.
 *
 * BREAKING: generic language toolchains (`go`, `cargo`, `dotnet`, `dart`,
 * `flutter`) are intentionally NOT allowlisted: they are arbitrary-code
 * primitives via config-controlled `args`. Operators relying on them must
 * migrate to a single-purpose wrapper binary exposed via
 * `OPENCODE_ALLOWED_LINTERS`.
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
  // Validate only the matched value: the requested basename already passed
  // the structural checks above, so an unrelated malformed operator entry
  // must not DoS an otherwise-valid custom linter.
  if (extra.includes(value)) return true;
  return false;
}

/** Maximum accepted length for a single linter argument (DoS guard). */
const MAX_LINTER_ARG_LENGTH = 2048;

/**
 * Flags that turn an allowlisted single-purpose linter into a checkout-code
 * execution primitive by loading plugins/formatters/requirements from
 * attacker-controlled checkout files (`eslint --rulesdir ./evil`,
 * `prettier --plugin ./evil`, `stylelint --custom-formatter ./evil`,
 * `eslint --config ./evil.js` (flat config is executed JS),
 * `--formatter ./evil-formatter` custom-formatter paths,
 * linter `--require`/`--loader` hooks, ...). The attacker controls both the
 * yml `args` and the checkout files, so these are rejected even though the
 * binary itself is allowlisted. Matching is prefix-aware: `--flag=value` and
 * `--flag:value` concatenated forms are blocked the same as the bare flag.
 */
const BLOCKED_LINTER_ARGS: ReadonlySet<string> = new Set([
  '--rulesdir',
  '--plugin',
  '--plugin-search-dir',
  '--resolve-plugins-relative-to',
  '--load-rules',
  '--load',
  '--require',
  '--custom-formatter',
  '--custom-syntax',
  '--loader',
  '--import',
  '--config',
  '--config-file',
  '--formatter',
  '-r',
  '-c',
]);

/**
 * Check whether a single linter arg is a blocked plugin/code-loading flag.
 * @param arg - Single configured argument string.
 * @returns True when the arg must be rejected.
 */
function isBlockedLinterArg(arg: string): boolean {
  const v = arg.trim();
  if (BLOCKED_LINTER_ARGS.has(v)) return true;
  for (const blocked of BLOCKED_LINTER_ARGS) {
    if (blocked.startsWith('--') && (v.startsWith(`${blocked}=`) || v.startsWith(`${blocked}:`))) {
      return true;
    }
  }
  // Joined short-flag forms (`-revil`, `-c evil.js` config shorthand, `-r evil.js` loader shorthand).
  if (/^-[rc]\S/.test(v)) return true;
  return false;
}

/**
 * Check whether configured linter `args` are safe strings for `execFile`.
 * `execFile` spawns without a shell, so metacharacters are inert — but args
 * must still be well-formed strings: rejects non-strings, embedded NUL bytes
 * (which truncate C-level argv and can confuse argument parsing), overlong
 * values, and plugin/code-loading flags (see {@link BLOCKED_LINTER_ARGS})
 * that would execute checkout-controlled code via the linter. Matched file
 * paths are appended by the engine itself and are not covered here.
 * @param args - Configured `linters[].args` value.
 * @returns True when every arg is a safe string.
 */
export function isSafeLinterArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (!Array.isArray(args)) return false;
  return args.every(
    (a) =>
      typeof a === 'string' &&
      a.length <= MAX_LINTER_ARG_LENGTH &&
      !a.includes('\0') &&
      !isBlockedLinterArg(a),
  );
}

// ─── Path confinement ───────────────────────────────────────────

/**
 * Resolve the nearest existing ancestor of `target` via realpath and check
 * whether the fully-resolved target stays inside the (realpath-resolved)
 * base. Lexical `path.resolve`/`path.relative` confinement alone can be
 * bypassed by a checkout symlink (e.g. `workingDirectory: link` where
 * `link -> /etc`): the lexical check passes but the exec cwd / log write
 * follows the link outside the checkout. When nothing on the path exists yet
 * (e.g. a not-yet-created log file in a fresh checkout) there is nothing to
 * resolve and the lexical verdict stands.
 *
 * Residual risk: TOCTOU — a symlink swapped in between this check and the
 * exec/mkdir still escapes. Sinks should re-check immediately before use;
 * fully untrusted checkouts should run with OS-level sandboxing.
 * @param baseResolved - Lexically resolved trusted base directory.
 * @param target - Lexically resolved untrusted target path.
 * @returns True when realpath resolution reveals an escape outside the base.
 */
/**
 * Check whether a lexical `path.relative` result escapes the base.
 * A bare `startsWith('..')` false-positives on benign in-base names such as
 * `..foo` (rel `..foo` stays inside the base). Only the exact parent (`..`),
 * the `../` prefix, and the Windows `..\` prefix are traversals.
 */
function isTraversalRel(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
}

function realpathRevealsEscape(baseResolved: string, target: string): boolean {
  let baseReal = baseResolved;
  try {
    baseReal = fs.realpathSync(baseResolved);
  } catch {
    // Base does not exist (yet) — fall back to the lexical base.
  }
  let probe = target;
  while (true) {
    try {
      const real = fs.realpathSync(probe);
      const remainder = path.relative(probe, target);
      const realTarget = remainder ? path.join(real, remainder) : real;
      const rel = path.relative(baseReal, realTarget);
      if (rel === '') return false;
      return isTraversalRel(rel) || path.isAbsolute(rel);
    } catch (err) {
      // Fail closed on unexpected filesystem errors: an attacker-crafted
      // symlink loop (ELOOP), permission error (EACCES), or overlong name
      // (ENAMETOOLONG) must not be treated as confined. Only a missing path
      // (ENOENT — ancestor walk continues) falls back to the lexical verdict.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return true;
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

/**
 * Check whether `requested` resolves inside `base` (the checkout working dir).
 * Rejects absolute escapes and `..` traversal. Both arguments may be relative;
 * they are resolved against `process.cwd()` first. When the target exists on
 * disk, its realpath is also checked so a checkout symlink pointing outside
 * the checkout is rejected (see {@link realpathRevealsEscape}).
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
  // `rel === ''` is the base directory itself — confined. This agrees with
  // `resolveConfinedWorkingDir`, which resolves an empty/absent value to the
  // base, so `workingDirectory: '.'` (checkout root) is benign.
  if (rel === '') {
    return !realpathRevealsEscape(baseResolved, target);
  }
  if (isTraversalRel(rel) || path.isAbsolute(rel)) return false;
  return !realpathRevealsEscape(baseResolved, target);
}

/**
 * Resolve an untrusted configured working directory against the checkout dir,
 * returning null when it would escape the checkout. The lexical check is
 * followed by a realpath check so a checkout symlink pointing outside the
 * checkout is rejected (see {@link realpathRevealsEscape}).
 * @param workDir - Trusted checkout working directory.
 * @param requested - Untrusted `workingDirectory` value (may be undefined).
 * @returns The confined absolute directory, or null when it escapes.
 */
export function resolveConfinedWorkingDir(workDir: string, requested?: unknown): string | null {
  // Empty/absent values resolve to the trusted base itself. Route through the
  // same lexical + realpath checks as an explicit '.' (rather than returning
  // the base unchecked) so both spellings of the checkout root take the same
  // checked path. The base is trusted, so the check trivially passes unless
  // the filesystem reveals an escape.
  // Fail closed on non-string input (objects/numbers must not coerce into the
  // base via String()); mirrors resolveConfinedEventLogPath's typeof guard.
  if (requested !== undefined && requested !== null && typeof requested !== 'string') return null;
  const value =
    requested === undefined || requested === null || (requested as string).trim() === ''
      ? '.'
      : (requested as string);
  const baseResolved = path.resolve(workDir);
  const target = path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseResolved, value);
  const rel = path.relative(baseResolved, target);
  if (isTraversalRel(rel) || path.isAbsolute(rel)) return null;
  if (realpathRevealsEscape(baseResolved, target)) return null;
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
 * hostile value cannot append/rename arbitrary runner files. A realpath check
 * additionally rejects checkout symlinks pointing outside the checkout.
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
  if (rel === '' || isTraversalRel(rel) || path.isAbsolute(rel)) return null;
  if (path.extname(target) === '') return null;
  if (realpathRevealsEscape(baseResolved, target)) return null;
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
 * Argument tokens that turn an allowlisted launcher into an arbitrary-code
 * primitive (`node -e '...'`, `python3 -c '...'`, `deno eval '...'`,
 * `--loader/--require/--import` hooks loading checkout code, `python -m`
 * module execution (including joined `-mevil`), `node --run` package-script
 * execution, `uvx --from/--with` arbitrary-package fetch). Any command
 * vector containing one of these is rejected. Matching is prefix-aware (see
 * {@link isBlockedMcpLocalArg}): `--eval=x`, `-econsole.log(1)`,
 * `-cimport os`, `-mevil`, and `-p8080` concatenated forms are blocked the same as the
 * bare flags, since node/python/deno all accept `--flag=value` and joined
 * short flags.
 *
 * This is intentionally fail-closed: a legitimate server that needs e.g.
 * `-c config.json` or `-p 8080` as literal flags is also rejected and must be
 * run outside PR-editable config. NOTE: `-y`/`--yes` (used by the pinned
 * built-in `npx` servers in `mcp/servers.ts`) remain permitted, but `npx`
 * package names are additionally pinned (see {@link PINNED_MCP_NPM_PACKAGES}):
 * `npx -y <attacker-package>` would otherwise fetch and execute an arbitrary
 * npm package named in config with forwarded `environment` credentials.
 */
const BLOCKED_MCP_LOCAL_ARGS: ReadonlySet<string> = new Set([
  '-e',
  '--eval',
  '--evaluate',
  '-c',
  '--code',
  '-p',
  '--print',
  'eval',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--package',
  '-m',
  '--run',
  '--from',
  '--with',
  '--import-map',
]);

/**
 * Npm packages that repo-file config may ask a package-runner launcher
 * (`npx`/`uvx`/`bunx`) to fetch and execute. These mirror the pinned
 * built-in servers in `mcp/servers.ts` (`MCP_PACKAGE_VERSIONS`); any other
 * package name (including typosquats and attacker-published packages) is
 * rejected. Version suffixes are allowed (`pkg@1.2.3`).
 */
export const PINNED_MCP_NPM_PACKAGES: ReadonlySet<string> = new Set([
  '@upstash/context7-mcp',
  '@modelcontextprotocol/server-github',
]);

/** Script-file extensions that indicate a checkout-controlled program file. */
const SCRIPT_FILE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.mts', '.cts', '.py'];

/**
 * Extract the bare package name from an npm package specifier, stripping a
 * trailing `@version` suffix (`@scope/pkg@1.2.3` → `@scope/pkg`,
 * `pkg@1.2.3` → `pkg`).
 * @param spec - Raw package specifier from the command vector.
 * @returns The bare package name.
 */
function extractNpmPackageName(spec: string): string {
  const s = spec.trim();
  if (s.startsWith('@')) {
    const secondAt = s.indexOf('@', 1);
    return secondAt === -1 ? s : s.slice(0, secondAt);
  }
  const at = s.indexOf('@');
  return at === -1 ? s : s.slice(0, at);
}

/**
 * Check whether a single MCP local-server arg is a blocked code-evaluation /
 * code-loading flag, including `--flag=value` / `--flag:value` concatenated
 * forms and joined short flags (`-e<code>`, `-c<code>`, `-p<port>`,
 * `-r<module>`, `-m<module>`).
 * @param arg - Single configured argument string.
 * @returns True when the arg must be rejected.
 */
function isBlockedMcpLocalArg(arg: string): boolean {
  const v = arg.trim();
  if (BLOCKED_MCP_LOCAL_ARGS.has(v)) return true;
  for (const blocked of BLOCKED_MCP_LOCAL_ARGS) {
    if (blocked.startsWith('--') && (v.startsWith(`${blocked}=`) || v.startsWith(`${blocked}:`))) {
      return true;
    }
  }
  if (/^-[ecprm]\S/.test(v)) return true;
  if (/^eval[=:.]/.test(v)) return true;
  return false;
}

/**
 * Check whether an MCP local-server arg names a checkout-controlled script
 * file. Any arg that looks like a file path (contains a path separator) or
 * ends with a script extension (`server.js`, `evil.py`, `run evil.ts`) would
 * execute attacker-controlled checkout code with credentials inherited via
 * the subprocess environment, so it is rejected.
 *
 * NOTE: extension heuristics alone cannot stop extensionless checkout files:
 * `node server` resolves `server.js` via extension probing and `python3 run`
 * executes an exact relative path with no extension. Callers additionally
 * reject any bare non-flag positional arg for the script launchers
 * (`node`/`python`/`python3`/`deno`) — see {@link isAllowedMcpLocalCommand}.
 * This is intentionally fail-closed: legitimate servers needing positional
 * args under these launchers must run outside PR-editable config.
 * @param arg - Single configured argument string.
 * @returns True when the arg looks like a script file reference.
 */
function isMcpScriptFileArg(arg: string): boolean {
  const v = arg.trim();
  if (v.includes('/') || v.includes('\\')) return true;
  const lower = v.toLowerCase();
  return SCRIPT_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Launchers that execute a file/positional program arg directly. */
const SCRIPT_LAUNCHERS: ReadonlySet<string> = new Set(['node', 'python', 'python3', 'deno']);

/**
 * Check whether a launcher executes script files from positional args.
 * @param launcher - Bare launcher basename.
 * @returns True for node/python/deno family launchers.
 */
function isScriptLauncher(launcher: string): boolean {
  return SCRIPT_LAUNCHERS.has(launcher);
}

/**
 * Check whether an arg is a bare positional (not a `-`/`--` flag).
 * @param arg - Single configured argument string.
 * @returns True when the trimmed arg is non-empty and not flag-shaped.
 */
function isBarePositionalArg(arg: string): boolean {
  const v = arg.trim();
  return v !== '' && !v.startsWith('-');
}

/**
 * Check whether a local MCP server command vector is safe to spawn.
 * Requires a non-empty argv whose launcher is a bare basename on the launcher
 * allowlist (no paths, no shell metacharacters). Remaining arguments must
 * contain none of the code-evaluation/loading flags (see
 * {@link BLOCKED_MCP_LOCAL_ARGS}, prefix-aware) and none of the
 * checkout-controlled script-file references: `node server.js`,
 * `python3 evil.py`, and `deno run evil.ts` would execute PR-checkout code
 * with credentials inherited via the subprocess environment. Package-runner
 * launchers (`npx`/`uvx`/`bunx`) may additionally only fetch the pinned
 * built-in packages in {@link PINNED_MCP_NPM_PACKAGES} — any other package
 * name would fetch and run arbitrary registry code.
 *
 * BREAKING: local file-path script servers (`node server.js`, `python3 run`,
 * extensionless checkout files) are rejected, unpinned npx/uvx/bunx packages
 * are rejected, and `isAllowedLinterCommand` no longer allowlists the generic
 * toolchains (`go`/`cargo`/`dotnet`/`dart`/`flutter`). Migration: move custom
 * repo-local servers outside PR-editable config (operator-managed transport),
 * pin package-runner servers to the built-ins in `mcp/servers.ts`, and use
 * `OPENCODE_ALLOWED_LINTERS` only for single-purpose binaries (never shells
 * or toolchains). Filtered entries are skipped, never executed.
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
  if (!ALLOWED_MCP_LOCAL_COMMANDS.has(launcher)) return false;
  const args = command.slice(1);
  // For package runners the positional package spec (a scoped npm name such
  // as `@upstash/context7-mcp@3.2.5`, which legitimately contains a `/`) is
  // validated against the pinned-package set below instead of the
  // script-file rule.
  const isPackageRunner = launcher === 'npx' || launcher === 'uvx' || launcher === 'bunx';
  const packageSpec = isPackageRunner
    ? args.find(
        (a): a is string => typeof a === 'string' && a.trim() !== '' && !a.trim().startsWith('-'),
      )
    : undefined;
  for (const arg of args) {
    if (typeof arg !== 'string') return false;
    if (isBlockedMcpLocalArg(arg)) return false;
    if (arg !== packageSpec && isMcpScriptFileArg(arg)) return false;
    // Extensionless bypass guard: node extension-probing (`node server` →
    // `server.js`) and exact-path execution (`python3 run`) work without a
    // script extension or separator, so any bare non-flag positional arg to a
    // script launcher is a checkout-code reference. Fail closed (this also
    // rejects benign `prog 8080` port args — run those outside PR config).
    if (!isPackageRunner && isScriptLauncher(launcher) && isBarePositionalArg(arg)) {
      return false;
    }
  }
  if (isPackageRunner) {
    // No positional package means there is nothing legitimate to run — reject.
    if (!packageSpec) return false;
    if (!PINNED_MCP_NPM_PACKAGES.has(extractNpmPackageName(packageSpec))) return false;
  }
  return true;
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
  // Strip any IPv6 zone ID (`fe80::1%eth0`) before canonicalization:
  // zones are interface-scoped link-local addresses and must classify as
  // blocked, but `net.isIP` rejects the `%zone` form outright.
  const h = host.toLowerCase().replace(/\.$/, '').split('%')[0] ?? '';
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
    // Link-local fe80::/10 spans first hextet fe80–febf (not just fe80:).
    const firstHextet = Number.parseInt(h.split(':')[0], 16);
    if (Number.isInteger(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) {
      return true;
    }
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
      // Each hextet is exactly 16 bits: parse the last two groups separately
      // with zero-padding semantics (joining `c0a8` + `1` into `c0a81` and
      // parsing as one number mis-decodes `::ffff:c0a8:1` as public).
      const groups = h.split(':').slice(-2);
      const hi = Number.parseInt(groups[0].padStart(4, '0'), 16);
      const lo = Number.parseInt(groups[1].padStart(4, '0'), 16);
      if (
        groups.length === 2 &&
        groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) &&
        Number.isSafeInteger(hi) &&
        Number.isSafeInteger(lo)
      ) {
        const bytes: [number, number, number, number] = [
          (hi >>> 8) & 0xff,
          hi & 0xff,
          (lo >>> 8) & 0xff,
          lo & 0xff,
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
 *
 * NOTE (residual risk): this check cannot stop DNS-based bypass. An
 * attacker-controlled hostname that *resolves* to `169.254.169.254` or
 * RFC1918 space (DNS rebinding, malicious dynamic-DNS) passes this check and
 * would be fetched. Mitigate by pinning remote MCP/webhook URLs to
 * operator-known hosts, or by adding resolve-and-validate at fetch time as a
 * follow-up; do not rely on this check alone for hostile DNS.
 * @param url - Candidate remote MCP server URL.
 * @returns True when the URL is safe to open an SSE transport to.
 */
export function isSafeRemoteMcpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    // `URL.hostname` retains brackets for IPv6 literals (`[::1]`), but
    // `isBlockedIpHost` expects a bare host — strip them first (non-greedy
    // bracket class) and drop any `%zone` suffix before the host check.
    const host =
      parsed.hostname
        .toLowerCase()
        .replace(/^\[([^\]]*)\]$/, '$1')
        .split('%')[0] ?? '';
    return !isBlockedIpHost(host);
  } catch {
    return false;
  }
}
