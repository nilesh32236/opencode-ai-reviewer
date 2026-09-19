import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';
import { toV1ServersMap, toV2ServersMap } from './mcp/servers.js';
import type { LLMConfig, LLMProviderConfig, MCPServerConfig } from './types/index.js';
import {
  buildMissingChecksumError,
  computeSha256,
  findChecksumAsset,
  getKnownChecksum,
  markIntegrityError,
  parseChecksumFile,
  verifyChecksum,
} from './utils/checksum.js';
import { Logger } from './utils/logger.js';
import { validateModelString } from './utils/model-string.js';
import { isNetworkError, withRetry, withRetryAndTimeout } from './utils/retry.js';
import {
  MINIMUM_OPENCODE_VERSION,
  TESTED_OPENCODE_VERSION,
  UNPARSEABLE_VERSION,
  WARN_BELOW_OPENCODE_VERSION,
  compareVersions,
  formatVersion,
  isBelowWarnFloor,
  parseVersion,
} from './utils/version.js';

export {
  MINIMUM_OPENCODE_VERSION,
  TESTED_OPENCODE_VERSION,
  WARN_BELOW_OPENCODE_VERSION,
} from './utils/version.js';

/** Default timeout for the `opencode --version` health probe, in milliseconds. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Snapshot of the module-level opencode subprocess state (binary path,
 * validation cache, CI config, LLM/run-mode overrides). The state itself
 * remains in module `let` bindings (reset via {@link resetOpenCodeState});
 * this grouped view exists so long-lived multi-repo processes (Probot) and
 * tests can inspect/reset shared state in one place without touching eight
 * separate globals. New code should prefer passing `llm`/`runMode` per run
 * (see `runLLM` in engine.ts) over mutating shared state.
 */
export interface OpenCodeStateSnapshot {
  binPath: string | null;
  validatedBinPath: string | null;
  ciConfigCached: boolean;
  versionRaw: string | null;
  hasLlmConfig: boolean;
  hasRunModeOverride: boolean;
}

let opencodePath: string | null = null;
/** Path of the opencode binary most recently confirmed compatible by checkHealth(). */
let validatedOpenCodePath: string | null = null;
let cachedCIConfig: string | null = null;
/**
 * Raw version string (e.g. "v1.2.3") from the most recent successful
 * `opencode --version` probe. Used to gate version-dependent config shapes
 * (e.g. the V2 subagent permissions array) without spawning a new process.
 */
let cachedOpenCodeVersionRaw: string | null = null;
/** Per-version cache of V2 subagent-permission gate decisions (no extra spawns). */
const subagentV2DecisionCache = new Map<string, boolean>();
const askPassDirs: string[] = [];
/** Custom LLM provider configuration applied to every OpenCode run. */
let llmProviderConfig: LLMConfig | undefined;

/** Overrides for how OpenCode CLI runs are invoked (used by the local CLI). */
export interface OpenCodeRunMode {
  /**
   * Custom OpenCode config JSON injected as OPENCODE_CONFIG_CONTENT. Replaces the
   * CI config (which clears MCP/plugins and forces every tool to allow).
   */
  opencodeConfig?: string;
  /**
   * Whether to pass `--auto` to auto-approve tool permissions. CI behavior is
   * `true`; interactive local use should set this to `false` so the user can
   * approve permissions at the prompt. Defaults to `true`.
   */
  autoApprove?: boolean;
  /**
   * Optional model variant passed as `opencode run --variant <value>` (e.g.
   * `low`, `medium`, `high` reasoning-effort aliases — exact values depend on
   * the provider). String passthrough only, allowlisted to `[A-Za-z0-9_-]`
   * (max 64 chars). Off by default; absent/empty/invalid means no flag.
   * @since NEXT
   */
  opencodeVariant?: string;
}

/**
 * Minimum CLI version that supports `opencode run --variant`. Kept equal to
 * the minimum compatible CLI so every health-checked binary passes the gate;
 * older or unparseable versions skip the flag silently (fail-open).
 * @since NEXT
 */
export const OPENCODE_VARIANT_MIN_VERSION = MINIMUM_OPENCODE_VERSION;

/** Allowlist for the `--variant` passthrough (alphanumeric plus dash/underscore, max 64 chars). */
const OPENCODE_VARIANT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate an `opencode run --variant` value. Pure (no env reads; the caller
 * resolves precedence) so it stays unit-testable.
 * @param raw - The raw candidate value.
 * @returns The trimmed value when it matches the allowlist, else `undefined`.
 * @since NEXT
 */
export function sanitizeVariant(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!OPENCODE_VARIANT_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Resolve the effective `--variant` value for a run. Explicit per-run option
 * wins, then the run-mode override, then `OPENCODE_VARIANT` /
 * `INPUT_OPENCODE_VARIANT` env. Returns `undefined` when absent or invalid.
 * An explicitly-passed empty string suppresses the env fallback (used by the
 * unknown-flag retry so the stripped retry sends no flag).
 * @param explicit - Optional explicit per-run value.
 * @returns The sanitized variant, or `undefined` when the flag must be omitted.
 * @since NEXT
 */
export function resolveOpenCodeVariant(explicit?: string): string | undefined {
  const raw =
    explicit ??
    runModeOverride?.opencodeVariant ??
    process.env.OPENCODE_VARIANT ??
    process.env.INPUT_OPENCODE_VARIANT;
  if (raw === undefined) return undefined;
  const sanitized = sanitizeVariant(raw);
  if (sanitized === undefined) {
    core.debug('Ignoring invalid opencode variant (expected [A-Za-z0-9_-], max 64 chars).');
  }
  return sanitized;
}

/**
 * Decide whether the detected CLI supports `opencode run --variant`.
 * Fail-open toward skipping: unknown, missing, or unparseable versions return
 * false so the run proceeds without the flag. Zero extra spawns — uses the
 * already-probed cached version by default.
 * @param cliVersion - Raw detected CLI version; defaults to the last probed version.
 * @returns True when the CLI is at or above {@link OPENCODE_VARIANT_MIN_VERSION}.
 * @since NEXT
 */
export function supportsOpenCodeVariant(cliVersion?: string | null): boolean {
  try {
    const version = cliVersion ?? cachedOpenCodeVersionRaw;
    if (typeof version !== 'string' || !version.trim()) return false;
    const cmp = compareVersions(version, OPENCODE_VARIANT_MIN_VERSION);
    if (cmp === UNPARSEABLE_VERSION) return false;
    return cmp >= 0;
  } catch {
    return false;
  }
}

/**
 * Detect a CLI rejection of the unknown `--variant` flag in captured output.
 * Mirrors the existing provider-timeout retry pattern (bounded substring scan).
 * @param output - The captured CLI output.
 * @returns True when the output blames an unknown/invalid `variant` flag.
 * @since NEXT
 */
export function isVariantFlagRejection(output: string): boolean {
  return /(unknown|invalid|unexpected|unrecognized)[\w\s'".:-]{0,80}variant|variant[\w\s'".:-]{0,80}(unknown|invalid|unexpected|unrecognized|not supported|not allowed)/i.test(
    output,
  );
}

/**
 * Resolve the effective resumable-retry flag for an `opencode run` invocation.
 * Explicit per-run option wins, then `INPUT_RESUME_ON_NETWORK_ERROR` env
 * (the `resume_on_network_error` action input), else false (current behavior).
 * @param explicit - Optional explicit per-run value.
 * @returns True when a failed network_error run should resume/retry.
 * @since NEXT
 */
export function resolveResumeOnNetworkError(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.INPUT_RESUME_ON_NETWORK_ERROR?.trim().toLowerCase() === 'true';
}

/**
 * Detect a transient `network_error` in captured CLI output. String overload
 * delegating to the shared {@link isNetworkError} classifier in retry.ts.
 * Non-string or empty input never matches.
 * @param output - Combined stdout/stderr of the failed CLI run.
 * @returns True when the output looks like a transient network failure.
 * @since NEXT
 */
export function isNetworkErrorOutput(output: unknown): boolean {
  if (typeof output !== 'string' || !output) return false;
  return isNetworkError(output);
}

/**
 * Extract a resumable opencode session/task id from captured CLI output.
 * Bounded scan for `task_id`/`taskId`/`session` tokens and bare `ses_<id>`
 * session ids (the `opencode run --session <id>` resume key). Returns the
 * first allowlisted match (`[A-Za-z0-9_-]`, 8–128 chars) or undefined.
 * Pure and side-effect-free; never throws.
 * @param output - Combined stdout/stderr of the failed CLI run.
 * @returns The extracted session id, or undefined when absent/invalid.
 * @since NEXT
 */
export function extractTaskId(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output) return undefined;
  const text = output.length > 50 * 1024 ? output.slice(-50 * 1024) : output;
  const labeled =
    /(?:task[_-]?id|session[_-]?id|session)\s*[:=]\s*["']?([A-Za-z0-9_-]{8,128})["']?/i.exec(text);
  if (labeled?.[1] && /^[A-Za-z0-9_-]{8,128}$/.test(labeled[1])) {
    return labeled[1];
  }
  const bare = /\b(ses_[A-Za-z0-9_-]{8,128})\b/.exec(text);
  if (bare?.[1]) return bare[1];
  return undefined;
}

/**
 * Validate a caller-supplied resume task/session id against the CLI-safe
 * allowlist (`[A-Za-z0-9_-]`, 8–128 chars, plus the `ses_` prefixed form).
 * Prevents argv injection from untrusted output or inputs.
 * @param taskId - The candidate id.
 * @returns True when the id is safe to pass as `--session <id>`.
 * @since NEXT
 */
export function isValidResumeTaskId(taskId: unknown): boolean {
  return (
    typeof taskId === 'string' && /^(?:ses_[A-Za-z0-9_-]{8,128}|[A-Za-z0-9_-]{8,128})$/.test(taskId)
  );
}

/**
 * Build the resume argv for `opencode run --session <id>` from the base run
 * args. Inserts `--session <id>` immediately after `run` and preserves all
 * other flags (model, variant, auto-approve, prompt). Pure; returns a copy.
 * @param baseArgs - The argv used for the initial full run.
 * @param taskId - The validated session id to resume.
 * @returns A new argv array with the `--session` flag inserted.
 * @since NEXT
 */
export function buildResumeArgs(baseArgs: readonly string[], taskId: string): string[] {
  const next = [...baseArgs];
  const idx = next.indexOf('run');
  const at = idx >= 0 ? idx + 1 : 0;
  next.splice(at, 0, '--session', taskId);
  return next;
}

let runModeOverride: OpenCodeRunMode | undefined;

/**
 * Isolated per-run HOME roots created for `opencode run` spawns, tracked so
 * `cleanupOpenCodeRunHomes()` (process exit) and per-run finally blocks can
 * remove them. Each entry is a temp dir prefix `opencode-home-`.
 */
const openCodeRunHomeDirs: string[] = [];

/**
 * Create an isolated HOME directory for a single `opencode run` spawn.
 *
 * Concurrent `opencode run` processes share one embedded opencode store
 * derived from HOME (same HOME / working tree), and concurrent store
 * migrations race (`CREATE TABLE workspace` failure, exit 1). The race is
 * not confined to this process — two Node processes or CI runners sharing
 * the same HOME collide too — so a process-local mutex cannot fix it.
 * Giving every run its own HOME (plus XDG data/config/cache dirs beneath
 * it) isolates the embedded store per run, which fixes cross-process
 * collisions and preserves `MAX_BATCH_CONCURRENCY` parallelism (no global
 * serialization, no ~8x wall-clock regression on large reviews).
 * @returns The path of the freshly created temp HOME directory.
 */
export function createIsolatedOpenCodeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-home-'));
  openCodeRunHomeDirs.push(dir);
  return dir;
}

/**
 * Remove a per-run isolated HOME directory created by
 * {@link createIsolatedOpenCodeHome}. Best-effort (never throws).
 * @param dir - The temp HOME directory to remove.
 */
export function cleanupIsolatedOpenCodeHome(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ok */
  }
  const idx = openCodeRunHomeDirs.indexOf(dir);
  if (idx >= 0) openCodeRunHomeDirs.splice(idx, 1);
}

/**
 * @deprecated Process-local run serialization was removed in favor of
 * per-run store isolation (`createIsolatedOpenCodeHome`). Kept as a no-op
 * for backward compatibility with existing imports/tests; runs are
 * concurrent and each spawn gets its own HOME-backed store.
 */
export function resetOpenCodeRunChainForTests(): void {
  // No-op: there is no serialization chain anymore.
}

/**
 * Default for dual-emitting V2 permissions-array subagent rules alongside V1
 * permission keys. `true` keeps subagent reviews working on both newer CLIs
 * (which prefer `permissions`) and older CLIs (which require `permission`).
 * Overridable per call via an explicit `dualEmit` argument, per run via the
 * `dualEmitSubagentPermissions` option on {@link runOpenCode}, process-wide via
 * {@link setDualEmitSubagentPermissions}, or via the
 * `OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS` env var (`false` disables).
 *
 * Strict-schema note: the V2 docs quoted on
 * {@link SUBAGENT_V2_PERMISSIONS_CUTOFF} say "Do not use `permission`..." in V2
 * configuration. Dual-emit therefore assumes V2 CLIs tolerate (ignore or warn
 * on) the extra legacy `permission` key alongside `permissions`. If a V2 CLI
 * ever performs strict-schema validation and rejects the legacy key, disable
 * dual-emit via one of the opt-outs above (e.g. pass `false` per call/run, call
 * `setDualEmitSubagentPermissions(false)`, or set
 * `OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS=false`) to fall back to gated
 * single-shape behavior (V2-only on new CLIs, legacy-only on old/unknown).
 */
let dualEmitSubagentPermissionsDefault = true;

/**
 * Configure whether V2-capable subagent configs emit both the legacy V1
 * `permission` object and the V2 `permissions` array side by side.
 *
 * See the module-default comment above for the strict-schema caveat: if a V2
 * CLI rejects the legacy key, call `setDualEmitSubagentPermissions(false)` or
 * set `OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS=false`.
 * @param enabled - `true` (default) to dual-emit, `false` for gated
 * single-shape behavior, `undefined` to restore the default (`true`).
 */
export function setDualEmitSubagentPermissions(enabled?: boolean): void {
  dualEmitSubagentPermissionsDefault = enabled ?? true;
}

/**
 * Resolve the effective dual-emit flag: an explicit per-call/per-run boolean
 * wins, then the `OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS` env var, then the
 * module default set via {@link setDualEmitSubagentPermissions} (`true`).
 * Unrecognized env values fall through to the module default (fail-open).
 * @param explicit - Optional explicit override for this call.
 * @returns The effective dual-emit setting.
 */
export function resolveDualEmitSubagentPermissions(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const raw = process.env.OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS;
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  }
  return dualEmitSubagentPermissionsDefault;
}

/**
 * Default for dual-emitting the legacy V1 `mcp` map entries alongside the V2
 * `mcp.servers` map. `true` keeps MCP servers loading on both newer CLIs
 * (which prefer `mcp.servers` with the `disabled` flag) and older CLIs (which
 * require the legacy `mcp: { <name>: {...} }` map). Overridable per call via
 * an explicit `dualEmit` argument, per run via the `dualEmitMCP` option on
 * {@link runOpenCode}, process-wide via {@link setDualEmitMCP}, or via the
 * `OPENCODE_DUAL_EMIT_MCP` env var (`false` disables).
 *
 * Strict-schema note: dual-emit assumes V2 CLIs tolerate (ignore or warn on)
 * the extra legacy sibling keys alongside `servers`. If a V2 CLI ever performs
 * strict-schema validation and rejects the legacy keys, disable dual-emit via
 * one of the opt-outs above to fall back to gated single-shape behavior
 * (V2-only on new/unknown CLIs, legacy-only on old CLIs). A strict rejection
 * also auto-disables dual-emit for the rest of the process (see
 * {@link noteMCPConfigRejection}) and the failed run is retried once without
 * the legacy keys.
 * @since NEXT
 */
let dualEmitMCPDefault = true;

/** Per-version cache of V2 MCP-servers gate decisions (no extra spawns). */
const mcpV2DecisionCache = new Map<string, boolean>();

/**
 * Configure whether V2-capable MCP configs emit both the legacy V1 `mcp` map
 * entries and the V2 `mcp.servers` map side by side.
 *
 * See the module-default comment above for the strict-schema caveat: if a V2
 * CLI rejects the legacy keys, call `setDualEmitMCP(false)` or set
 * `OPENCODE_DUAL_EMIT_MCP=false`.
 * @param enabled - `true` (default) to dual-emit, `false` for gated
 * single-shape behavior, `undefined` to restore the default (`true`).
 * @since NEXT
 */
export function setDualEmitMCP(enabled?: boolean): void {
  dualEmitMCPDefault = enabled ?? true;
}

/**
 * Resolve the effective MCP dual-emit flag: an explicit per-call/per-run
 * boolean wins, then the `OPENCODE_DUAL_EMIT_MCP` env var, then the module
 * default set via {@link setDualEmitMCP} (`true`). Unrecognized env values
 * fall through to the module default (fail-open).
 * @param explicit - Optional explicit override for this call.
 * @returns The effective dual-emit setting.
 * @since NEXT
 */
export function resolveDualEmitMCP(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const raw = process.env.OPENCODE_DUAL_EMIT_MCP;
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  }
  return dualEmitMCPDefault;
}

/**
 * Configure how the OpenCode CLI is invoked for the current process.
 *
 * The GitHub Action and App never call this and keep the default CI behavior
 * (`--auto` + CI config). The local CLI sets a mode with `autoApprove: false`
 * and a non-CI config so interactive permission prompts are possible.
 * @param mode - The run mode to apply, or `undefined` to restore CI defaults.
 */
export function setOpenCodeRunMode(mode: OpenCodeRunMode | undefined): void {
  runModeOverride = mode;
}

/**
 * Configure custom LLM providers for OpenCode CLI runs.
 *
 * The declared provider map is merged into the injected OpenCode config
 * (`OPENCODE_CONFIG_CONTENT`), custom Azure/Bedrock settings are translated
 * into the standard `AZURE_*` / `AWS_*` env vars, and a configured
 * `defaultProvider` prefixes bare model names.
 *
 * This sets a module-level default that is used by {@link runOpenCode} runs
 * that do not pass an explicit `llm` option. Long-lived processes that handle
 * concurrent runs with different provider configs (the Probot App) should pass
 * `llm` per run instead of relying on this shared global, which can be
 * overwritten by a subsequently constructed engine.
 * @param llm - The custom LLM provider configuration, or `undefined` to clear.
 */
export function setLLMProviderConfig(llm: LLMConfig | undefined): void {
  llmProviderConfig = llm;
}

/**
 * Build the OpenCode config object for interactive local use.
 *
 * Unlike {@link buildCIConfig}, this keeps MCP servers and plugins enabled
 * (nothing is cleared) so a developer's own opencode.json / plugins work
 * locally, and it does not force every tool to "allow". Combined with
 * `autoApprove: false` on `setOpenCodeRunMode`, tool usage is prompted for
 * approval during a local review.
 * @returns A JSON string of the local OpenCode config.
 */
export function buildLocalOpenCodeConfig(): string {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    // Disable auto-update and sharing — irrelevant for one-shot local reviews.
    autoupdate: false,
    share: 'disabled',
  };
  return JSON.stringify(config);
}

/**
 * Reset the module-level OpenCode state (cached binary path, validation cache,
 * and CI config cache). Used by tests and by long-lived processes that re-run
 * setup against a changed environment.
 */
export function resetOpenCodeState(): void {
  opencodePath = null;
  validatedOpenCodePath = null;
  cachedCIConfig = null;
  cachedOpenCodeVersionRaw = null;
  subagentV2DecisionCache.clear();
  mcpV2DecisionCache.clear();
  runModeOverride = undefined;
  dualEmitSubagentPermissionsDefault = true;
  dualEmitMCPDefault = true;
  llmProviderConfig = undefined;
  cleanupOpenCodeRunHomes();
  signalHandlersRegistered = false;
}

/**
 * Inspect the shared module-level opencode state as one grouped snapshot
 * (see {@link OpenCodeStateSnapshot}). Read-only; mutate via the dedicated
 * setters and {@link resetOpenCodeState}.
 * @returns The current module-level opencode state snapshot.
 */
export function getOpenCodeState(): OpenCodeStateSnapshot {
  return {
    binPath: opencodePath,
    validatedBinPath: validatedOpenCodePath,
    ciConfigCached: cachedCIConfig !== null,
    versionRaw: cachedOpenCodeVersionRaw,
    hasLlmConfig: llmProviderConfig !== undefined,
    hasRunModeOverride: runModeOverride !== undefined,
  };
}

let signalHandlersRegistered = false;

/** Remove all tracked per-run isolated HOME directories (best-effort). */
function cleanupOpenCodeRunHomes(): void {
  for (const dir of [...openCodeRunHomeDirs]) {
    cleanupIsolatedOpenCodeHome(dir);
  }
}

function cleanupAskPassDirs(): void {
  for (const dir of askPassDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
  cleanupOpenCodeRunHomes();
}

/**
 * Remove one temp directory asynchronously (off the event-loop critical path).
 * Best-effort, never throws. Preferred for per-run cleanup; the sync
 * variants below remain for `exit`-handler use (async work is unavailable
 * during `process.on('exit')`).
 * @param dir - Temp directory to remove.
 */
export async function removeTempDirAsync(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    /* ok */
  }
}

/**
 * Async per-run isolated-HOME removal (see {@link removeTempDirAsync}).
 * @param dir - Isolated HOME directory to remove.
 */
export async function cleanupIsolatedOpenCodeHomeAsync(dir: string): Promise<void> {
  await removeTempDirAsync(dir);
  const idx = openCodeRunHomeDirs.indexOf(dir);
  if (idx >= 0) openCodeRunHomeDirs.splice(idx, 1);
}

/**
 * Async removal of one GIT_ASKPASS helper dir (see {@link removeTempDirAsync}).
 * Best-effort, never throws. Preferred off the event-loop critical path; the
 * sync sweep below remains for `exit`-handler use where async is unavailable.
 * @param dir - Ask-pass temp directory to remove.
 */
export async function cleanupAskPassDirAsync(dir: string): Promise<void> {
  await removeTempDirAsync(dir);
  const idx = askPassDirs.indexOf(dir);
  if (idx >= 0) askPassDirs.splice(idx, 1);
}

function registerSignalHandlers(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  process.on('exit', cleanupAskPassDirs);

  const sigintHandler = () => {
    cleanupAskPassDirs();
    process.off('SIGINT', sigintHandler);
    process.kill(process.pid, 'SIGINT');
  };
  process.on('SIGINT', sigintHandler);

  const sigtermHandler = () => {
    cleanupAskPassDirs();
    process.off('SIGTERM', sigtermHandler);
    process.kill(process.pid, 'SIGTERM');
  };
  process.on('SIGTERM', sigtermHandler);
}

/**
 * Lazily install process exit/SIGINT/SIGTERM cleanup handlers (idempotent).
 * Prefer calling this explicitly from setup/run entry points; the automatic
 * registration below is kept for backward compatibility so existing entry
 * points that never call it still clean up temp dirs.
 */
export function ensureSignalHandlers(): void {
  registerSignalHandlers();
}

ensureSignalHandlers();

/**
 * Parsed OpenCode CLI version, with the raw text matched from `--version` output.
 */
export interface OpenCodeVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (e.g. "rc.1") or null for a release version. */
  prerelease: string | null;
}

/**
 * Parse an OpenCode CLI version from `opencode --version` output.
 * Handles output like "opencode v1.1.1", "1.1.1-rc.1", or plain "v1.2.3".
 *
 * The version token must be standalone (bounded by whitespace or the start/end
 * of the output) so version-like numbers embedded in error text, stack traces,
 * or file paths are not accepted as the CLI version.
 * @param output - The raw output from `opencode --version`.
 * @returns A parsed version, or null when no standalone semver token is found.
 */
export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  const match = output.match(
    /(?:^|\s)(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/,
  );
  if (!match) return null;
  const raw = match[1];
  const parsed = parseVersion(raw);
  if (!parsed) return null;
  return {
    raw,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
  };
}

/**
 * Compare a parsed OpenCode version against a minimum semver string.
 * @param version - The parsed OpenCode version.
 * @param minimum - Minimum acceptable version (default: {@link MINIMUM_OPENCODE_VERSION}).
 * @returns True when the version is at or above the minimum.
 */
export function isVersionCompatible(
  version: OpenCodeVersion,
  minimum: string = MINIMUM_OPENCODE_VERSION,
): boolean {
  const cmp = compareVersions(formatVersion(version), minimum);
  if (cmp === UNPARSEABLE_VERSION) return false;
  return cmp >= 0;
}

/**
 * Structured health status of the OpenCode CLI integration.
 */
export interface OpenCodeHealth {
  /** Whether an opencode binary is present and executable. */
  available: boolean;
  /** Parsed version from `opencode --version`, or null when unavailable/unparseable. */
  version: OpenCodeVersion | null;
  /** Whether the installed version meets the minimum supported version. */
  compatible: boolean;
  /** Human-readable status with install/upgrade instructions when needed. */
  message: string;
}

/**
 * Options for {@link checkHealth}.
 */
export interface CheckHealthOptions {
  /** Absolute path to the opencode binary. Defaults to the cached path or a PATH lookup. */
  binPath?: string;
  /** Minimum acceptable version (default: {@link MINIMUM_OPENCODE_VERSION}). */
  minimumVersion?: string;
  /** Timeout for the `--version` probe in milliseconds (default: 5000). */
  timeoutMs?: number;
  /**
   * Optional replacement for the generic npm upgrade hint shown when the
   * installed version is below the minimum. Used by the download/cached setup
   * paths, where a global npm upgrade would not fix the installed binary.
   */
  upgradeHint?: string;
}

const INSTALL_MESSAGE =
  'OpenCode CLI not found. Install it via: npm install -g opencode-ai\n' +
  'Or download from: https://github.com/anomalyco/opencode/releases';

/**
 * Whether the untested-CLI version warning is disabled.
 * Set `OPENCODE_DISABLE_VERSION_WARN=true` to restore the previous silent
 * behavior for versions between the hard floor and the warn floor.
 * @returns True when the warning tier should stay silent.
 * @since NEXT
 */
export function isVersionWarnDisabled(): boolean {
  const raw = process.env.OPENCODE_DISABLE_VERSION_WARN?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/**
 * Build the upgrade-guidance warning for an untested but compatible CLI.
 * @param raw - Raw version string of the installed CLI.
 * @returns Warning text with upgrade guidance and docs links.
 * @since NEXT
 */
export function buildUntestedVersionWarning(raw: string): string {
  return (
    `OpenCode ${raw} is below the tested version ${TESTED_OPENCODE_VERSION} ` +
    `(warning floor ${WARN_BELOW_OPENCODE_VERSION}). Reviews may behave unexpectedly. ` +
    `Upgrade with: npm install -g opencode-ai@latest. ` +
    `See https://opencode.ai/docs/cli and releases at https://github.com/sst/opencode/releases.`
  );
}

/**
 * Run `opencode --version` asynchronously, bounded by a timeout.
 * The probe is deliberately non-blocking (unlike execFileSync) so a slow or
 * hung binary cannot stall the event loop for concurrent batch processing.
 * @param binPath - Absolute path to the opencode binary.
 * @param timeoutMs - Timeout before the probe is killed (SIGKILL).
 * @returns The raw stdout of the version command.
 * @throws The underlying execFile error (ENOENT, ETIMEDOUT, etc.).
 */
function execVersion(binPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      binPath,
      ['--version'],
      {
        encoding: 'utf-8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Pre-flight health check for the OpenCode CLI integration.
 * Runs `opencode --version` with a short timeout and verifies the installed
 * version meets the minimum supported version. External consumers can call
 * this before issuing commands to surface a clear, actionable error instead of
 * an opaque ENOENT/parse failure.
 *
 * The probe is asynchronous (never blocks the event loop) and bounded by
 * `timeoutMs`. On success the checked binary path is recorded so that
 * {@link runOpenCode} can skip the redundant probe for an already-validated
 * binary.
 * @param options - Health check options.
 * @returns A structured health result.
 */
export async function checkHealth(options: CheckHealthOptions = {}): Promise<OpenCodeHealth> {
  const minimumVersion = options.minimumVersion ?? MINIMUM_OPENCODE_VERSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const binPath = options.binPath ?? opencodePath ?? (await io.which('opencode', false));
  if (!binPath) {
    return {
      available: false,
      version: null,
      compatible: false,
      message: INSTALL_MESSAGE,
    };
  }
  try {
    const stdout = await execVersion(binPath, timeoutMs);
    const version = parseOpenCodeVersion(stdout || '');
    if (version) {
      // Remember the probed version so version-gated config emission (e.g.
      // the V2 subagent permissions array) can reuse it with zero extra spawns.
      cachedOpenCodeVersionRaw = version.raw;
    }
    if (!version) {
      if (!isVersionWarnDisabled()) {
        core.warning(
          `OpenCode CLI version could not be determined from output: ${(stdout || '').trim()}. ` +
            `Continuing without failing; for reliable reviews use tested version ${TESTED_OPENCODE_VERSION}. ` +
            `See https://opencode.ai/docs/cli.`,
        );
      }
      return {
        available: true,
        version: null,
        compatible: false,
        message: `OpenCode binary found at ${binPath} but version could not be determined from output: ${(stdout || '').trim()}`,
      };
    }
    const compatible = isVersionCompatible(version, minimumVersion);
    if (compatible) {
      validatedOpenCodePath = binPath;
      if (!isVersionWarnDisabled() && isBelowWarnFloor(version.raw) === true) {
        core.warning(buildUntestedVersionWarning(version.raw));
      }
      return {
        available: true,
        version,
        compatible: true,
        message: `OpenCode ${version.raw} is available and compatible`,
      };
    }
    const hint = options.upgradeHint ?? 'Upgrade with: npm install -g opencode-ai@latest';
    return {
      available: true,
      version,
      compatible: false,
      message: `OpenCode ${version.raw} is installed but version ${minimumVersion}+ is required.\n${hint}`,
    };
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      return {
        available: false,
        version: null,
        compatible: false,
        message: `OpenCode binary at ${binPath} could not be executed (${code}). Reinstall it via: npm install -g opencode-ai, or download from: https://github.com/anomalyco/opencode/releases`,
      };
    }
    return {
      available: true,
      version: null,
      compatible: false,
      message: `OpenCode binary found at ${binPath} but version check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

function detectArch(): string {
  const platform = os.platform();
  const arch = os.arch();

  let osName = '';
  if (platform === 'linux') {
    osName = 'linux';
  } else if (platform === 'darwin') {
    osName = 'darwin';
  } else if (platform === 'win32') {
    osName = 'windows';
  } else {
    throw new Error(
      `Unsupported platform: ${platform}. Only Linux, macOS, and Windows are supported.`,
    );
  }

  let archName = '';
  if (arch === 'x64') {
    archName = 'x64';
  } else if (arch === 'arm64') {
    archName = 'arm64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
  }

  return `${osName}-${archName}`;
}

/** Per-attempt timeout for the GitHub release-metadata lookup (matches OSV 30s). */
export const RELEASE_FETCH_TIMEOUT_MS = 30_000;

async function fetchWithRetry(url: string, retries = 3, token?: string): Promise<Response> {
  return withRetryAndTimeout(
    async (attemptSignal) => {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: attemptSignal,
      });
      if (response.ok) return response;
      const err = new Error(`HTTP ${response.status}: ${response.statusText}`);
      (err as Error & { status: number }).status = response.status;
      throw err;
    },
    RELEASE_FETCH_TIMEOUT_MS,
    {
      maxRetries: retries,
      // 403 is NOT retryable here: on the authenticated attempt a rejected
      // repo-scoped token deterministically returns 403, and burning three
      // backoff retries (~7-10s) before the anonymous fallback is wasteful. A
      // 403 also never becomes transiently successful, so failing fast is safe.
      retryableStatuses: [429, 500, 502, 503, 504],
    },
  );
}

/**
 * Build an actionable, user-facing error message for a failed OpenCode binary
 * download, classifying the underlying cause (network, HTTP status, checksum
 * mismatch, or unknown) so users get guidance on how to recover instead of a
 * raw stack trace.
 * @param error - The error thrown during download (network, HTTP, or checksum).
 * @param version - The semver tag of the OpenCode release being downloaded.
 * @param downloadUrl - The asset URL that failed to download.
 * @returns A human-friendly message explaining the failure and next steps.
 */
function classifyDownloadError(error: unknown, version: string, downloadUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    /checksum mismatch|does not match|integrity check|hash.*(mismatch|does not match)/i.test(
      message,
    )
  ) {
    return (
      `The downloaded OpenCode binary (${version}) failed checksum verification.\n` +
      `Details: ${message}\n` +
      `This usually indicates a corrupted download or an intercepted network transfer. ` +
      `Re-run the workflow to retry with a fresh download; if the error persists, ` +
      `contact support or verify the release assets at:\n${downloadUrl}`
    );
  }

  if (/no checksum available|require_opencode_checksum/i.test(message)) {
    // Fail-closed integrity error under strict enforcement: re-running the
    // workflow without changes deterministically fails again, so point at the
    // pin-or-disable recovery steps instead of a blind retry. The Details line
    // preserves the pin-plus-sha256 remediation from buildMissingChecksumError
    // verbatim.
    return (
      `The downloaded OpenCode binary (${version}) could not be checksum-verified and require_opencode_checksum is enabled.\n` +
      `Details: ${message}\n` +
      `Download URL: ${downloadUrl}\n` +
      `Pin opencode_version to a pinned version in docs/opencode-checksums.md or to a release that publishes a checksum asset, or re-run ` +
      `with require_opencode_checksum disabled (the default warn-and-continue behavior, at your own risk) ` +
      `while you obtain the expected sha256 out-of-band. See docs/opencode-checksums.md.`
    );
  }

  if (
    /timed out|timeout|fetch failed|network|econnrefused|econnreset|enotfound|etimedout|eai_again|socket/i.test(
      lower,
    )
  ) {
    return (
      `Failed to download the OpenCode binary (${version}) — network error.\n` +
      `Details: ${message}\n` +
      `Download URL: ${downloadUrl}\n` +
      `Check your network connectivity and firewall/proxy settings, then re-run the workflow.`
    );
  }

  const http4xx = message.match(/HTTP (4\d\d)/i);
  if (http4xx) {
    return (
      `Failed to download the OpenCode binary (${version}) — HTTP ${http4xx[1]}.\n` +
      `Details: ${message}\n` +
      `Download URL: ${downloadUrl}\n` +
      `Verify that the requested version tag exists and that the release assets are ` +
      `publicly accessible, then re-run the workflow.`
    );
  }

  const http5xx = message.match(/HTTP (5\d\d)/i);
  if (http5xx) {
    return (
      `Failed to download the OpenCode binary (${version}) — HTTP ${http5xx[1]}.\n` +
      `Details: ${message}\n` +
      `Download URL: ${downloadUrl}\n` +
      `This looks like a transient server error on GitHub's side — re-run the workflow to retry.`
    );
  }

  return (
    `Failed to download the OpenCode binary (${version}).\n` +
    `Details: ${message}\n` +
    `Download URL: ${downloadUrl}\n` +
    `Please re-run the workflow to retry; if the issue persists, contact support.`
  );
}

/**
 * Options for {@link setupOpenCode}.
 * @since NEXT
 */
export interface SetupOpenCodeOptions {
  /**
   * Fail closed when no checksum is available for the downloaded archive.
   * Maps to the `require_opencode_checksum` action input (surfaced as the
   * `INPUT_REQUIRE_OPENCODE_CHECKSUM` env var). Defaults to false
   * (warn-and-continue). Note: strict mode also fails closed for a binary
   * already present on PATH or restored from the tool cache, because no
   * archive was downloaded to verify (see {@link setupOpenCode}).
   */
  requireChecksum?: boolean;
}

/**
 * Resolve whether checksum enforcement is on. An explicit option wins;
 * otherwise the `INPUT_REQUIRE_OPENCODE_CHECKSUM` env var (set by the
 * `require_opencode_checksum` action input) applies. Defaults to false so
 * existing workflows keep the warn-and-continue behavior.
 * @param options - Optional setup options.
 * @returns True when missing-checksum downloads must fail closed.
 * @since NEXT
 */
export function resolveRequireChecksum(options?: SetupOpenCodeOptions): boolean {
  if (options?.requireChecksum !== undefined) return options.requireChecksum;
  return process.env.INPUT_REQUIRE_OPENCODE_CHECKSUM?.trim().toLowerCase() === 'true';
}

/**
 * Download with a timeout (single source of truth for the archive + checksum
 * download paths, which previously duplicated the Promise.race + clearTimeout
 * pattern and could drift).
 * @param download - The download promise factory.
 * @param ms - Timeout in milliseconds.
 * @param message - Timeout error message.
 * @returns The downloaded file path.
 */
export async function downloadWithTimeout(
  download: () => Promise<string>,
  ms = 120_000,
  message = 'Download timed out after 120s',
): Promise<string> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      download(),
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/**
 * Ensure the OpenCode CLI binary is available.
 * Checks PATH first; if not found, downloads and caches the specified version.
 *
 * When `options.requireChecksum` is on, a binary already on PATH or restored
 * from the tool cache fails closed: no archive was downloaded, so there is
 * nothing to checksum and an unverified pre-installed/cached binary must not
 * silently pass the gate. Remove the PATH binary (or clear the tool cache)
 * so a fresh verified download runs, or re-run with enforcement off at your
 * own risk.
 * @param version - Version tag to download (defaults to 'latest').
 * @param token - Optional GitHub token used for the authenticated release lookup.
 * @param minimumVersion - Minimum acceptable installed version (default: {@link MINIMUM_OPENCODE_VERSION}).
 * @param options - Optional setup options (see {@link SetupOpenCodeOptions}).
 * @returns A Promise resolving to the path of the OpenCode binary.
 * @since NEXT - Added `options.requireChecksum` fail-closed integrity gate.
 */
export async function setupOpenCode(
  version = 'latest',
  token?: string,
  minimumVersion: string = MINIMUM_OPENCODE_VERSION,
  options: SetupOpenCodeOptions = {},
): Promise<string> {
  const existingPath = await io.which('opencode', false);
  if (existingPath) {
    if (resolveRequireChecksum(options)) {
      // Strict mode cannot verify a pre-installed binary (no archive was
      // downloaded, so there is nothing to checksum): fail closed instead of
      // silently passing the gate, so a poisoned PATH entry cannot bypass
      // enforcement.
      throw markIntegrityError(
        new Error(
          `OpenCode integrity verification failed: require_opencode_checksum is enabled but opencode was already on PATH at ${existingPath} — ` +
            `no archive was downloaded to verify. ` +
            `Remove the pre-installed binary (or clear it from PATH) so a fresh verified download runs, ` +
            `or re-run with require_opencode_checksum disabled at your own risk (this disables integrity protection).`,
        ),
      );
    }
    core.info(`OpenCode already available at: ${existingPath}`);
    opencodePath = existingPath;
    const health = await checkHealth({ binPath: existingPath, minimumVersion });
    if (!health.compatible) {
      throw new Error(health.message);
    }
    return existingPath;
  }

  // Fail fast for explicitly pinned versions below the minimum: the downloaded
  // binary would immediately fail the post-install health check, so surface a
  // clear error before spending time and bandwidth on a doomed download.
  const requestedVersion = version !== 'latest' ? parseVersion(version) : null;
  if (requestedVersion) {
    const cmp = compareVersions(formatVersion(requestedVersion), minimumVersion);
    if (cmp === UNPARSEABLE_VERSION) {
      throw new Error(
        `minimumOpenCodeVersion "${minimumVersion}" is not a valid semantic version — set it to a value like "${MINIMUM_OPENCODE_VERSION}"`,
      );
    }
    if (cmp < 0) {
      throw new Error(
        `Requested OpenCode version ${version} is below the minimum supported version ${minimumVersion}. ` +
          `Set opencode_version to a tag >= ${minimumVersion} and re-run.`,
      );
    }
  }

  const arch = detectArch();
  core.info(`Setting up OpenCode ${version} (${arch})...`);
  const requireChecksum = resolveRequireChecksum(options);

  let releaseUrl: string;
  if (version === 'latest') {
    releaseUrl = 'https://api.github.com/repos/anomalyco/opencode/releases/latest';
  } else {
    const tag = version.startsWith('v') ? version : `v${version}`;
    releaseUrl = `https://api.github.com/repos/anomalyco/opencode/releases/tags/${tag}`;
  }

  let response: Response;
  const ambientToken =
    token ||
    (process.env.GITHUB_ACTIONS === 'true'
      ? process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || undefined
      : undefined);
  try {
    response = await fetchWithRetry(releaseUrl, 3, ambientToken);
  } catch (err) {
    const status =
      err instanceof Error && 'status' in err ? (err as Error & { status: number }).status : 0;
    if (status === 401 || status === 403 || status === 404) {
      core.warning(`Authenticated release lookup failed (HTTP ${status}) — retrying anonymously`);
      response = await fetchWithRetry(releaseUrl, 3);
    } else {
      throw err;
    }
  }
  const status = response.status;
  const release = (await response.json()) as {
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };

  if (!Array.isArray(release.assets)) {
    // A 404 from the (possibly anonymous) lookup means the requested tag does
    // not exist rather than an auth failure — surface a clear error naming the
    // tag so setup failures are diagnosable instead of a confusing TypeError
    // from release.assets.find below.
    const requested =
      version === 'latest' ? 'latest' : version.startsWith('v') ? version : `v${version}`;
    throw new Error(
      `Release${version === 'latest' ? '' : ` ${requested}`} not found on anomalyco/opencode (HTTP ${status}) — cannot download opencode`,
    );
  }
  const releaseAssets = release.assets;

  const semver = (release.tag_name || version).replace(/^v/, '');
  const platform = os.platform();
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const assetName = `opencode-${arch}.${extension}`;

  const cachedToolDir = tc.find('opencode', semver);
  if (cachedToolDir) {
    const binName = platform === 'win32' ? 'opencode.exe' : 'opencode';
    const cachedBinPath = path.join(cachedToolDir, binName);
    const checksumFile = path.join(cachedToolDir, '.checksum');
    if (fs.existsSync(cachedBinPath) && fs.existsSync(checksumFile)) {
      const storedChecksum = fs.readFileSync(checksumFile, 'utf-8').trim();
      const actualChecksum = await computeSha256(cachedBinPath);
      if (actualChecksum === storedChecksum) {
        if (requireChecksum) {
          // The cached .checksum is self-written by this same installer after
          // any download (verified or warn-and-continue), so a cache entry
          // created in default mode cannot prove integrity: fail closed so a
          // poisoned cache entry cannot bypass enforcement. Clear the tool
          // cache (or re-run with enforcement off at your own risk) to force
          // a fresh verified download.
          throw markIntegrityError(
            new Error(
              `OpenCode integrity verification failed: require_opencode_checksum is enabled but using cached OpenCode ${semver} from ${cachedBinPath} — ` +
                `the cached checksum is self-recorded, not an independent verification. ` +
                `Clear the tool cache so a fresh verified download runs, ` +
                `or re-run with require_opencode_checksum disabled at your own risk (this disables integrity protection).`,
            ),
          );
        }
        core.info(`Using cached OpenCode ${semver} from ${cachedBinPath}`);
        if (platform !== 'win32') fs.chmodSync(cachedBinPath, 0o755);
        core.addPath(cachedToolDir);
        opencodePath = cachedBinPath;
        const health = await checkHealth({
          binPath: cachedBinPath,
          minimumVersion,
          upgradeHint: `The cached binary for requested tag ${version} is below the minimum. Set opencode_version to a tag >= ${minimumVersion} and re-run, or install the CLI via: npm install -g opencode-ai`,
        });
        if (!health.compatible) {
          throw new Error(health.message);
        }
        return cachedBinPath;
      }
      core.info('Cached binary checksum mismatch, re-downloading...');
    } else {
      core.info('Cached binary lacks checksum verification file, re-downloading...');
    }
  }

  const asset = releaseAssets.find((a) => a.name === assetName);
  if (!asset) {
    const message = `Could not find asset "${assetName}" in release ${release.tag_name || version}`;
    core.error(message);
    throw new Error(message);
  }

  core.info(`Downloading from: ${asset.browser_download_url}`);
  let cachedPath: string;
  try {
    const result = await withRetry(
      async () => {
        const dlPath = await downloadWithTimeout(
          () => tc.downloadTool(asset.browser_download_url),
          120_000,
          'Download timed out after 120s',
        );

        await verifyDownloadedArchive(
          dlPath,
          releaseAssets,
          assetName,
          release.tag_name || version,
          arch,
          requireChecksum,
        );

        let extPath: string;
        if (extension === 'zip') {
          extPath = await tc.extractZip(dlPath);
        } else {
          extPath = await tc.extractTar(dlPath);
        }
        const cachePath = await tc.cacheDir(extPath, 'opencode', semver);
        return { cachedPath: cachePath };
      },
      { maxRetries: 3, baseDelayMs: 2000 },
    );
    cachedPath = result.cachedPath;
  } catch (error) {
    const message = classifyDownloadError(error, semver, asset.browser_download_url);
    core.error(message);
    throw new Error(message);
  }

  const binName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binPath = path.join(cachedPath, binName);

  if (platform !== 'win32') {
    fs.chmodSync(binPath, 0o755);
  }

  const binChecksum = await computeSha256(binPath);
  fs.writeFileSync(path.join(cachedPath, '.checksum'), `${binChecksum}\n`, 'utf-8');

  core.addPath(cachedPath);

  opencodePath = binPath;
  const health = await checkHealth({
    binPath,
    minimumVersion,
    upgradeHint: `The downloaded binary for requested tag ${version} reports a version below the minimum. Set opencode_version to a tag >= ${minimumVersion} and re-run, or install the CLI via: npm install -g opencode-ai`,
  });
  if (!health.compatible) {
    throw new Error(health.message);
  }
  core.info(`OpenCode installed: ${health.version?.raw ?? binPath}`);
  return binPath;
}

async function verifyDownloadedArchive(
  dlPath: string,
  assets: Array<{ name: string; browser_download_url: string }>,
  assetName: string,
  version: string,
  arch: string,
  requireChecksum = false,
): Promise<void> {
  const checksumAsset = findChecksumAsset(assets, assetName);

  if (checksumAsset) {
    let expectedHash: string | null = null;
    let fetchFailed = false;
    try {
      core.info(`Downloading checksum file: ${checksumAsset.name}`);
      const checksumPath = await downloadWithTimeout(
        () => tc.downloadTool(checksumAsset.browser_download_url),
        120_000,
        'Checksum file download timed out after 120s',
      );
      const checksumContent = fs.readFileSync(checksumPath, 'utf-8');
      expectedHash = parseChecksumFile(checksumContent, assetName);
    } catch (err) {
      // Download/read failure: fall through to the KNOWN_CHECKSUMS pinned
      // lookup below (warn-and-continue unless strict mode and no pinned hit).
      fetchFailed = true;
      core.warning(
        `Failed to fetch checksum file ${checksumAsset.name}: ${err instanceof Error ? err.message : String(err)} — falling back to pinned checksums`,
      );
    }

    if (expectedHash) {
      // verifyChecksum throws `Checksum mismatch ... expected ..., got ...`
      // and classifyDownloadError() surfaces it — never swallowed here, in
      // either mode. The mismatch is deterministic, so it is tagged
      // non-retryable: withRetry fails fast instead of re-downloading an
      // archive whose bytes are already known to be wrong.
      try {
        await verifyChecksum(dlPath, expectedHash);
      } catch (err) {
        throw markIntegrityError(err instanceof Error ? err : new Error(String(err)));
      }
      core.info(`Checksum verified for ${assetName}`);
      return;
    }
    if (!fetchFailed) {
      // Parse-miss: fall through to the KNOWN_CHECKSUMS pinned lookup below
      // before failing closed, so a pinned entry can still verify the archive.
      core.warning(`Could not extract checksum for ${assetName} from ${checksumAsset.name}`);
    }
  }

  const knownChecksum = getKnownChecksum(version, arch);
  if (knownChecksum) {
    // Same fail-fast treatment as the release-asset path above: a mismatch
    // against the pinned known-good hash can never succeed on retry.
    try {
      await verifyChecksum(dlPath, knownChecksum);
    } catch (err) {
      throw markIntegrityError(err instanceof Error ? err : new Error(String(err)));
    }
    core.info(`Checksum verified using known-good checksum for ${version}`);
    return;
  }

  if (requireChecksum) {
    throw buildMissingChecksumError(version, assetName, arch);
  }
  core.warning(
    `No checksum file found for ${assetName} and no known-good checksum for ${version}. ` +
      `Skipping integrity verification — this could be a security concern. ` +
      `Pin an opencode_version and add its sha256 to KNOWN_CHECKSUMS to enable verification.`,
  );
}

/**
 * Resolve the path to the OpenCode CLI binary, installing it if necessary.
 * Prefers an existing PATH binary; otherwise downloads the requested version
 * via `setupOpenCode`.
 *
 * Like {@link setupOpenCode}, strict mode fails closed for a binary already
 * on PATH (no archive was downloaded to verify), so a poisoned PATH entry
 * cannot bypass enforcement.
 * @param version - Version to install when opencode is missing (defaults to 'latest').
 * @param minimumVersion - Minimum acceptable installed version (default: {@link MINIMUM_OPENCODE_VERSION}).
 * @param options - Optional setup options (see {@link SetupOpenCodeOptions}).
 * @returns The absolute path to the opencode binary.
 * @since NEXT - Added `options` passthrough for the checksum integrity gate.
 */
export async function resolveOpenCodePath(
  version = 'latest',
  minimumVersion: string = MINIMUM_OPENCODE_VERSION,
  options: SetupOpenCodeOptions = {},
): Promise<string> {
  const existingPath = await io.which('opencode', false);
  if (existingPath) {
    if (resolveRequireChecksum(options)) {
      throw markIntegrityError(
        new Error(
          `OpenCode integrity verification failed: require_opencode_checksum is enabled but opencode was already on PATH at ${existingPath} — ` +
            `no archive was downloaded to verify. ` +
            `Remove the pre-installed binary (or clear it from PATH) so a fresh verified download runs, ` +
            `or re-run with require_opencode_checksum disabled at your own risk (this disables integrity protection).`,
        ),
      );
    }
    opencodePath = existingPath;
    return existingPath;
  }
  return setupOpenCode(version, undefined, minimumVersion, options);
}

/**
 * Build the OpenCode CI config object.
 *
 * Based on https://opencode.ai/docs/permissions and https://opencode.ai/docs/config:
 *
 * - "permission": "allow"  →  shorthand that sets ALL tools to allow at once
 * - external_directory     →  gates access to paths outside the working dir;
 *                             defaults to "ask" which blocks CI sub-agents that
 *                             read files in /tmp or other external locations
 * - doom_loop              →  triggered when the same tool call repeats 3×;
 *                             defaults to "ask" which would hang CI
 * - task                   →  controls sub-agent invocation (task tool)
 *
 * The old `tools: { bash: true, ... }` block is deprecated since v1.1.1 —
 * the permission system now controls tool access entirely.
 *
 * We inject this as OPENCODE_CONFIG_CONTENT (highest-precedence env var,
 * overrides even a project-level opencode.json) so no file needs to be written
 * and the config can never be overridden by a repo's own config.
 *
 * SECURITY: `permission: "allow"` + `--auto` runs the primary agent with full
 * tool access over untrusted PR content (prompt-injection surface) while
 * GITHUB_TOKEN is in the subprocess env (needed for git-push fix flows), so a
 * crafted diff could instruct tool use leading to token exfiltration or a
 * malicious push. The default stays `allow` for backward compatibility (CI
 * reviews need non-interactive tool use), but least-privilege operation is
 * available without code changes: set `OPENCODE_LEAST_PRIVILEGE=true` (or pass
 * a custom `opencodeConfig`/`runModeOverride` with `autoApprove: false`) to
 * require approval-gated tools, and prefer a repo-scoped fine-grained PAT for
 * GITHUB_TOKEN. Subagents remain read-only regardless of this setting (see
 * `buildReviewSubagent`).
 * @returns A JSON string of the CI config.
 */
function buildCIConfig(): string {
  if (cachedCIConfig) return cachedCIConfig;
  const leastPrivilege = process.env.OPENCODE_LEAST_PRIVILEGE?.trim().toLowerCase() === 'true';
  const config = leastPrivilege
    ? {
        $schema: 'https://opencode.ai/config.json',
        permission: { edit: 'ask', bash: 'ask', task: 'allow' },
        autoupdate: false,
        share: 'disabled',
        mcp: {},
        plugin: [],
      }
    : {
        $schema: 'https://opencode.ai/config.json',
        // "allow" as a string is the shorthand that enables every tool without
        // prompting. Docs: https://opencode.ai/docs/permissions#configuration
        permission: 'allow',
        // Disable auto-update and sharing — irrelevant in CI and slow things down.
        autoupdate: false,
        share: 'disabled',
        // Clear MCP and plugins to prevent downloading external dependencies in CI
        mcp: {},
        plugin: [],
      };
  cachedCIConfig = JSON.stringify(config);
  return cachedCIConfig;
}

/** AI SDK adapter used for any OpenAI-compatible endpoint (incl. Ollama). */
const LLM_OPENAI_COMPATIBLE_ADAPTER = '@ai-sdk/openai-compatible';

/** Default base URL for Ollama's OpenAI-compatible endpoint. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/**
 * Allowlist of environment variable names that may be referenced from an LLM
 * provider config via the OpenCode `{env:VAR}` substitution syntax and
 * forwarded into the sandboxed OpenCode subprocess.
 *
 * The `llm:` block is repo-controlled, so without this allowlist a
 * compromised/third-party config could reference and exfiltrate an arbitrary
 * parent env var (e.g. `{env:GITHUB_TOKEN}`) into a subprocess that renders
 * repo content into prompts/logs. Only credential names relevant to the
 * supported LLM providers are forwarded; any other reference is skipped (with
 * a warning) and the CLI's `{env:VAR}` expansion would then yield an empty
 * value for that variable.
 *
 * NOTE: AWS_* names are intentionally excluded here. Bedrock credentials flow
 * via ambient forwarding in applyLLMEnvOverrides (Bedrock runs only), not via
 * `{env:}` references, so a `{env:AWS_REGION}` reference warns-and-skips by
 * design — Bedrock auth still works through the ambient path.
 */
const LLM_REF_ALLOWLIST = new Set([
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
]);

/**
 * Hoisted (module-level) allowlist of env vars forwarded into the sandboxed
 * `opencode run` subprocess. Hoisted out of `runOpenCodeInner` so the 40+
 * entry array is not rebuilt on every run (hot path).
 */
const SAFE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_ACTOR',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_OWNER',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_BASE_REF',
  'GITHUB_HEAD_REF',
  'GITHUB_WORKSPACE',
  'GITHUB_ACTION',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_OUTPUT',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_ENV',
  'GITHUB_PATH',
  'RUNNER_OS',
  'RUNNER_ARCH',
  'RUNNER_TEMP',
  'RUNNER_TOOL_CACHE',
  'NODE_PATH',
  'GIT_ASKPASS',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'OPENCODE_CREDENTIAL_TOKEN',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
];

/**
 * Normalize an optional provider timeout (milliseconds) for emission as an
 * upstream opencode `provider.options` timeout key. Returns the rounded
 * positive int, or `undefined` when absent/invalid (fail open: the key is
 * omitted and default CLI timeouts apply).
 * @param value - The raw timeout value in milliseconds.
 * @returns The rounded timeout, or `undefined` to omit the key.
 */
function normalizeProviderTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    if (value !== undefined)
      core.debug(`Ignoring invalid provider timeout value: ${String(value)}.`);
    return undefined;
  }
  const rounded = Math.round(value);
  // Sub-millisecond fractions (e.g. 0.4) round to 0, which is not a usable
  // timeout — drop them so the key is omitted instead of stored/emitted as 0.
  if (rounded < 1) {
    core.debug(`Ignoring invalid provider timeout value: ${String(value)}.`);
    return undefined;
  }
  return rounded;
}

/**
 * Build an `@ai-sdk/openai-compatible` provider entry for the OpenCode CLI
 * `provider` map. Returns `undefined` when no usable base URL is configured.
 * @param provider - The OpenAI-compatible / Ollama provider configuration.
 * @returns The CLI provider entry, or `undefined` when it cannot be built.
 */
function buildCompatibleProviderEntry(
  provider: LLMProviderConfig,
): Record<string, unknown> | undefined {
  const baseURL = provider.baseUrl?.trim();
  if (!baseURL) return undefined;
  const options: Record<string, string | number> = { baseURL };
  if (provider.apiKey?.trim()) {
    // Keep the apiKey verbatim (including any "{env:VAR}" reference) so a raw
    // secret is never baked into the injected OPENCODE_CONFIG_CONTENT. The CLI
    // performs its own "{env:...}" substitution at runtime; runOpenCode forwards
    // the referenced variables into the subprocess environment via
    // applyLLMEnvVarReferences so the reference always resolves.
    const apiKey = provider.apiKey.trim();
    options.apiKey = apiKey;
    // A literal (non-{env:...}) key is serialized into OPENCODE_CONFIG_CONTENT
    // itself, which leaks the secret into the injected config. Warn so authors
    // move to the "{env:VAR}" reference form (or an env-var-provided key).
    if (!/^\{env:[^}]+\}$/.test(apiKey)) {
      core.warning(
        'LLM provider apiKey is a literal value and will be embedded in OPENCODE_CONFIG_CONTENT. ' +
          'Prefer the "{env:VAR_NAME}" reference syntax so the secret is forwarded via the ' +
          'subprocess environment instead of the injected config.',
      );
    }
  }
  const modelNames = [...(provider.models ?? []), provider.model ?? '']
    .map((m) => m.trim())
    .filter(Boolean);
  // Optional upstream timeout tuning (provider.options.headerTimeout /
  // provider.options.chunkTimeout). Fail open: omit keys entirely unless the
  // value is a finite positive number, so unset/invalid input yields config
  // output identical to before.
  const headerTimeout = normalizeProviderTimeout(provider.headerTimeoutMs);
  if (headerTimeout !== undefined) options.headerTimeout = headerTimeout;
  const chunkTimeout = normalizeProviderTimeout(provider.chunkTimeoutMs);
  if (chunkTimeout !== undefined) options.chunkTimeout = chunkTimeout;
  const models: Record<string, Record<string, never>> = {};
  for (const name of modelNames) models[name] = {};
  return { npm: LLM_OPENAI_COMPATIBLE_ADAPTER, options, models };
}

/**
 * Build the OpenCode CLI `provider` map from the configured custom LLM
 * providers and the `LLM_*` / `OLLAMA_*` environment variables.
 *
 * OpenAI-compatible and Ollama providers become `provider` map entries backed
 * by the `@ai-sdk/openai-compatible` adapter. Azure and Bedrock are handled via
 * the standard `AZURE_*` / `AWS_*` env vars (see {@link applyLLMEnvOverrides})
 * and do not produce a provider entry.
 * @param llm - The custom LLM provider configuration (may be `undefined`).
 * @returns A CLI `provider` map, or `undefined` when nothing is configured.
 */
export function buildLLMProviderMap(
  llm: LLMConfig | undefined,
): Record<string, unknown> | undefined {
  const providers: Record<string, unknown> = {};

  for (const [id, provider] of Object.entries(llm?.providers ?? {})) {
    if (!provider || (provider.type !== 'openai-compatible' && provider.type !== 'ollama')) {
      continue;
    }
    const entry = buildCompatibleProviderEntry({
      ...provider,
      baseUrl:
        provider.baseUrl?.trim() || (provider.type === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : ''),
    });
    if (entry) providers[id] = entry;
  }

  // Env-var path for an arbitrary OpenAI-compatible gateway (e.g. an internal
  // LLM proxy). Model selection uses the "custom-openai/<model>" model id.
  const llmBaseUrl = process.env.LLM_BASE_URL?.trim();
  if (llmBaseUrl) {
    const options: Record<string, string> = { baseURL: llmBaseUrl };
    if (process.env.LLM_API_KEY?.trim()) options.apiKey = '{env:LLM_API_KEY}';
    const models: Record<string, Record<string, never>> = {};
    if (process.env.LLM_MODEL?.trim()) models[process.env.LLM_MODEL.trim()] = {};
    providers['custom-openai'] = mergeEnvProviderEntry(
      providers['custom-openai'] as Record<string, unknown> | undefined,
      {
        npm: LLM_OPENAI_COMPATIBLE_ADAPTER,
        options,
        models,
      },
    );
  }

  // Env-var path for Ollama local models (OLLAMA_MODEL selects the model).
  const ollamaModel = process.env.OLLAMA_MODEL?.trim();
  if (ollamaModel) {
    providers.ollama = mergeEnvProviderEntry(
      providers.ollama as Record<string, unknown> | undefined,
      {
        npm: LLM_OPENAI_COMPATIBLE_ADAPTER,
        options: { baseURL: process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL },
        models: { [ollamaModel]: {} },
      },
    );
  }

  if (Object.keys(providers).length === 0) return undefined;
  return providers;
}

/**
 * Merge an env-var-derived provider entry into an existing config-file entry
 * with the same id, filling only unset fields instead of replacing the whole
 * entry. This prevents the env path from silently dropping a config-declared
 * `baseUrl` / model list (e.g. a repo config `ollama` block with a custom
 * base URL re-pointed at localhost just because `OLLAMA_MODEL` is set).
 * @param existing - The config-file provider entry, or `undefined`.
 * @param envEntry - The provider entry built from environment variables.
 * @returns The merged provider entry.
 */
function mergeEnvProviderEntry(
  existing: Record<string, unknown> | undefined,
  envEntry: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) return envEntry;
  const existingOptions =
    existing.options && typeof existing.options === 'object'
      ? (existing.options as Record<string, string | number>)
      : {};
  const envOptions =
    envEntry.options && typeof envEntry.options === 'object'
      ? (envEntry.options as Record<string, string | number>)
      : {};
  const mergedOptions: Record<string, string | number> = { ...existingOptions };
  for (const [key, value] of Object.entries(envOptions)) {
    if (mergedOptions[key] === undefined) mergedOptions[key] = value;
  }
  const existingModels =
    existing.models && typeof existing.models === 'object'
      ? (existing.models as Record<string, unknown>)
      : {};
  const envModels =
    envEntry.models && typeof envEntry.models === 'object'
      ? (envEntry.models as Record<string, unknown>)
      : {};
  return {
    npm: envEntry.npm,
    options: mergedOptions,
    models: { ...existingModels, ...envModels },
  };
}

/**
 * AWS keys the Bedrock SDK actually reads (credentials + region + shared-config
 * / IRSA resolution inputs). Ambient forwarding and the options.env Bedrock
 * exception are both restricted to this list so a Bedrock run can never receive
 * an arbitrary AWS_* key that the ambient path would not forward.
 */
const BEDROCK_AWS_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
] as const;

/**
 * Translate Azure / Bedrock LLM provider config blocks into the standard
 * environment variables the OpenCode CLI and its AI SDK providers read.
 * Explicit environment variables always win; config-file values only fill gaps.
 * @param safeEnv - The environment being built for the OpenCode subprocess.
 * @param llm - The custom LLM provider configuration (may be `undefined`).
 */
function applyLLMEnvOverrides(safeEnv: Record<string, string>, llm: LLMConfig | undefined): void {
  for (const provider of Object.values(llm?.providers ?? {})) {
    if (!provider) continue;
    if (provider.type === 'azure') {
      if (provider.endpoint?.trim() && !safeEnv.AZURE_OPENAI_ENDPOINT) {
        safeEnv.AZURE_OPENAI_ENDPOINT = provider.endpoint.trim();
      }
      if (provider.resourceName?.trim() && !safeEnv.AZURE_RESOURCE_NAME) {
        safeEnv.AZURE_RESOURCE_NAME = provider.resourceName.trim();
      }
      if (provider.apiKey?.trim() && !safeEnv.AZURE_OPENAI_API_KEY) {
        // Resolve {env:VAR} references against the parent process env before
        // injecting into the env var. Env vars are read directly by the CLI
        // (no {env:...} substitution), so an unresolved reference must not be
        // copied verbatim — that would make AZURE_OPENAI_API_KEY self-reference
        // the literal placeholder and never yield a real key.
        const apiKey = provider.apiKey
          .trim()
          .replace(/^\{env:([^}]+)\}$/, (_, name: string) => process.env[name] ?? '');
        if (apiKey) safeEnv.AZURE_OPENAI_API_KEY = apiKey;
      }
      if (provider.apiVersion?.trim() && !safeEnv.AZURE_OPENAI_API_VERSION) {
        safeEnv.AZURE_OPENAI_API_VERSION = provider.apiVersion.trim();
      }
    } else if (provider.type === 'bedrock') {
      if (provider.region?.trim() && !safeEnv.AWS_REGION) {
        safeEnv.AWS_REGION = provider.region.trim();
      }
      // Bedrock runs are the only subprocess invocations that need AWS
      // credentials. Forward ambient parent-process AWS_* vars only here so a
      // non-Bedrock run (over untrusted repo content with --auto) never carries
      // ambient AWS credentials into the agent subprocess (audit authz).
      // NOTE: AWS_PROFILE and AWS_WEB_IDENTITY_TOKEN_FILE are indirect
      // references (a named profile / a token-file path), not raw secrets, but
      // they are still forwarded only here because the SDK resolves them into
      // live credentials (SSO / role assumption) — needed for Bedrock auth via
      // shared-config and IRSA-style setups, harmless to omit elsewhere.
      for (const key of BEDROCK_AWS_KEYS) {
        const val = process.env[key];
        if (val !== undefined && safeEnv[key] === undefined) safeEnv[key] = val;
      }
    }
  }
}

/**
 * Forward any environment variables referenced via the OpenCode `{env:VAR}`
 * substitution syntax in the LLM provider configuration to the OpenCode
 * subprocess environment.
 *
 * Provider entries keep `{env:VAR}` references verbatim (never expanding them
 * against the parent process env), so the secret never appears in the injected
 * `OPENCODE_CONFIG_CONTENT`. The CLI expands the reference at runtime, which
 * only works when the referenced variable is present in the subprocess
 * environment — a sandboxed safeEnv forwards just a small allowlist, so any
 * variable a config file references must be forwarded explicitly.
 *
 * Forwarding is restricted to {@link LLM_REF_ALLOWLIST}: the `llm:` block is
 * repo-controlled, and referencing an arbitrary parent env var (e.g.
 * `{env:GITHUB_TOKEN}`) would widen the exfiltration surface beyond the fixed
 * `WHITELISTED_KEYS`. References outside the allowlist are skipped and warn, so
 * the author knows the referenced variable will not resolve in the subprocess.
 * @param safeEnv - The environment being built for the OpenCode subprocess.
 * @param llm - The custom LLM provider configuration (may be `undefined`).
 */
function applyLLMEnvVarReferences(
  safeEnv: Record<string, string>,
  llm: LLMConfig | undefined,
): void {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = /^\{env:([^}]+)\}$/.exec(value.trim());
      if (match) references.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(llm);
  for (const name of references) {
    if (!LLM_REF_ALLOWLIST.has(name)) {
      core.warning(
        `Skipping LLM {env:${name}} reference: "${name}" is not on the allowlist of ` +
          `forwarded variables (${[...LLM_REF_ALLOWLIST].join(', ')}). The referenced value ` +
          `will be empty inside the OpenCode subprocess.`,
      );
      continue;
    }
    const value = process.env[name];
    if (value !== undefined) safeEnv[name] = value;
  }
}

/**
 * Merge the built LLM provider map into a base OpenCode config JSON string,
 * preserving any existing `provider` keys (e.g. a caller-supplied custom config).
 * @param baseConfig - The base OpenCode config JSON (CI or custom).
 * @param llm - The custom LLM provider configuration (may be `undefined`).
 * @returns The config JSON with the provider map merged in.
 */
function mergeLLMProviderConfig(baseConfig: string, llm: LLMConfig | undefined): string {
  const providerMap = buildLLMProviderMap(llm);
  if (!providerMap) return baseConfig;
  try {
    const parsed = JSON.parse(baseConfig) as Record<string, unknown>;
    const existing =
      parsed.provider && typeof parsed.provider === 'object' && !Array.isArray(parsed.provider)
        ? (parsed.provider as Record<string, unknown>)
        : {};
    parsed.provider = { ...existing, ...providerMap };
    return JSON.stringify(parsed);
  } catch {
    return baseConfig;
  }
}

/**
 * Whether any configured provider carries timeout tuning that would be
 * emitted into the injected OpenCode config.
 * @param llm - The custom LLM provider configuration (may be `undefined`).
 * @returns True when at least one provider has a valid timeout value.
 */
function llmHasTimeoutOptions(llm: LLMConfig | undefined): boolean {
  // Side-effect-free predicate: do not reuse normalizeProviderTimeout here
  // (it emits core.debug for invalid values on every invocation).
  const isValidTimeout = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && Math.round(v) >= 1;
  return Object.values(llm?.providers ?? {}).some(
    (p) => isValidTimeout(p?.headerTimeoutMs) || isValidTimeout(p?.chunkTimeoutMs),
  );
}

/**
 * Return a copy of the LLM config with provider timeout tuning removed, so a
 * retry against an older CLI that rejects unknown provider option keys runs
 * with default timeouts.
 * @param llm - The custom LLM provider configuration (may be `undefined`).
 * @returns The config without timeout fields (same reference when nothing to strip).
 */
function stripLLMTimeoutOptions(llm: LLMConfig | undefined): LLMConfig | undefined {
  if (!llm?.providers || !llmHasTimeoutOptions(llm)) return llm;
  const providers: Record<string, LLMProviderConfig> = {};
  for (const [id, provider] of Object.entries(llm.providers)) {
    if (!provider) continue;
    const { headerTimeoutMs: _header, chunkTimeoutMs: _chunk, ...rest } = provider;
    providers[id] = rest;
  }
  return { ...llm, providers };
}

/**
 * Strip upstream provider timeout keys (`headerTimeout` / `chunkTimeout`)
 * from every `provider.*.options` block in an OpenCode config JSON string.
 * Fail-open helper for older CLI versions that reject unknown provider
 * option keys: retrying with the stripped config lets the review proceed
 * with default timeouts.
 * @param configJson - The OpenCode config JSON (e.g. `OPENCODE_CONFIG_CONTENT`).
 * @returns The config JSON without timeout keys (input unchanged on parse failure).
 */
export function stripProviderTimeoutOptions(configJson: string): string {
  try {
    const parsed = JSON.parse(configJson) as Record<string, unknown>;
    const providerMap =
      parsed.provider && typeof parsed.provider === 'object' && !Array.isArray(parsed.provider)
        ? (parsed.provider as Record<string, unknown>)
        : undefined;
    if (!providerMap) return configJson;
    let changed = false;
    for (const entry of Object.values(providerMap)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const options = (entry as Record<string, unknown>).options;
      if (!options || typeof options !== 'object' || Array.isArray(options)) continue;
      const opts = options as Record<string, unknown>;
      for (const key of ['headerTimeout', 'chunkTimeout'] as const) {
        if (key in opts) {
          delete opts[key];
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(parsed) : configJson;
  } catch {
    return configJson;
  }
}

/**
 * Merge a subagent `agent` block into a base OpenCode config JSON string,
 * preserving any existing `agent` keys (e.g. a caller-supplied custom config
 * that already defines built-in agents).
 *
 * Subagents are injected via the `agent` top-level key as `mode: "subagent"`
 * read-only reviewers. They are dispatched by the primary agent through the
 * OpenCode `task` tool during a single `opencode run` session, so a review that
 * previously spawned one process per category now runs as one process whose
 * primary agent delegates to these focused subagents.
 *
 * @param baseConfig - The base OpenCode config JSON (CI or custom).
 * @param subagents - Map of subagent name → definition to merge.
 * @returns The config JSON with the `agent` block merged in.
 */
export function mergeSubagentConfig(
  baseConfig: string,
  subagents: Record<string, Record<string, unknown>>,
): string {
  if (!subagents || Object.keys(subagents).length === 0) return baseConfig;
  try {
    const parsed = JSON.parse(baseConfig) as Record<string, unknown>;
    const existing =
      parsed.agent && typeof parsed.agent === 'object' && !Array.isArray(parsed.agent)
        ? (parsed.agent as Record<string, unknown>)
        : {};
    parsed.agent = { ...existing, ...subagents };
    return JSON.stringify(parsed);
  } catch {
    return baseConfig;
  }
}

/**
 * CLI version at or above which the injected subagent deny block uses the V2
 * permissions-array shape (`permissions: [{ action, resource, effect }]`,
 * with `bash` renamed to `shell`). Older or unknown versions keep the legacy
 * object shape (`permission: { edit: 'deny', bash: 'deny' }`).
 *
 * The V2 config schema belongs to the OpenCode 2.x line (`opencode2`) only.
 * The entire 1.x line — including the forks the action installs — is
 * V1-config-only and strictly rejects any config containing the V2
 * `permissions` key (`Error: Configuration is invalid at
 * OPENCODE_CONFIG_CONTENT — V2 permissions are not supported by OpenCode V1`,
 * CLI exit 1, observed in production with 1.18.30). Dual-emitting the V2
 * array to a 1.x CLI therefore breaks subagent review dispatch, so the
 * cutoff must stay on the 2.x major — never on {@link MINIMUM_OPENCODE_VERSION}.
 *
 * Docs: https://v2.opencode.ai/docs/permissions ("Do not use `permission`,
 * `bash`, or `task` in V2 configuration; use `permissions`, `shell`, and
 * `subagent`") and https://opencode.ai/docs/permissions (V1 object syntax).
 */
export const SUBAGENT_V2_PERMISSIONS_CUTOFF = '2.0.0';

/** Legacy (V1) read-only deny block, emitted byte-for-byte for old/unknown CLIs. */
export const LEGACY_SUBAGENT_PERMISSION: Record<string, string> = {
  edit: 'deny',
  bash: 'deny',
};

const V2_DENY_EFFECTS = new Set(['allow', 'ask', 'deny']);

/**
 * Map a V1 permission key to its V2 action name (`bash` → `shell`, `task` → `subagent`).
 * @param key - The V1 permission key to translate.
 * @returns The equivalent V2 action name, or the original key when no mapping exists.
 */
function mapV1PermissionKeyToV2Action(key: string): string {
  if (key === 'bash') return 'shell';
  if (key === 'task') return 'subagent';
  return key;
}

/**
 * Decide whether the subagent deny block should use the V2 permissions-array
 * shape for a given detected CLI version. Fail-open: unknown, missing, or
 * unparseable versions return false (legacy shape) so subagent dispatch never
 * fails because of this gate. Results are cached per version string.
 * @param cliVersion - Raw detected CLI version (e.g. "v1.2.3"), or null/undefined when unknown.
 * @returns True when the CLI is at or above {@link SUBAGENT_V2_PERMISSIONS_CUTOFF}.
 */
export function shouldUseV2SubagentPermissions(cliVersion?: string | null): boolean {
  try {
    if (typeof cliVersion !== 'string') return false;
    const key = cliVersion.trim();
    if (!key) return false;
    const cached = subagentV2DecisionCache.get(key);
    if (cached !== undefined) return cached;
    const cmp = compareVersions(key, SUBAGENT_V2_PERMISSIONS_CUTOFF);
    if (cmp === UNPARSEABLE_VERSION) {
      core.warning(
        `OpenCode version "${key}" could not be parsed for the subagent permission gate — using the legacy permission shape.`,
      );
      subagentV2DecisionCache.set(key, false);
      return false;
    }
    const result = cmp >= 0;
    subagentV2DecisionCache.set(key, result);
    return result;
  } catch (err) {
    core.warning(
      `Subagent permission version gate failed (${err instanceof Error ? err.message : String(err)}) — using the legacy permission shape.`,
    );
    return false;
  }
}

/**
 * Build the V2 permissions-array deny block equivalent to the legacy
 * `{ edit: 'deny', bash: 'deny' }` object. `bash` is renamed to `shell` per
 * the V2 schema; `resource: '*'` denies all targets for that action.
 * Docs: https://v2.opencode.ai/docs/permissions (rule schema + agent overrides).
 * @returns The V2 deny rules for a read-only review subagent.
 */
export function buildV2SubagentDenyPermissions(): Array<Record<string, string>> {
  return [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '*', effect: 'deny' },
  ];
}

/**
 * Convert a legacy V1 `permission` value to its V2 `permissions`-array
 * equivalent, preserving each rule's effect. String shorthands map to a
 * single wildcard rule; object entries map per key (`bash` → `shell`,
 * `task` → `subagent`), with granular pattern objects expanded per pattern.
 * Entries with unrecognized effects are skipped rather than mis-emitted.
 * @param permission - The legacy V1 `permission` value.
 * @returns The equivalent V2 rules, or null when nothing convertible remains.
 */
function convertV1PermissionToV2Array(permission: unknown): Array<Record<string, string>> | null {
  if (typeof permission === 'string') {
    const effect = permission.trim();
    if (!V2_DENY_EFFECTS.has(effect)) return null;
    return [{ action: '*', resource: '*', effect }];
  }
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return null;
  const rules: Array<Record<string, string>> = [];
  for (const [tool, value] of Object.entries(permission as Record<string, unknown>)) {
    const action = mapV1PermissionKeyToV2Action(tool);
    if (typeof value === 'string') {
      if (!V2_DENY_EFFECTS.has(value)) continue;
      rules.push({ action, resource: '*', effect: value });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [pattern, effect] of Object.entries(value as Record<string, unknown>)) {
        if (typeof effect !== 'string' || !V2_DENY_EFFECTS.has(effect)) continue;
        rules.push({ action, resource: pattern, effect });
      }
    }
  }
  return rules.length > 0 ? rules : null;
}

/**
 * Normalize subagent definitions for the detected CLI version.
 *
 * When the CLI is at or above {@link SUBAGENT_V2_PERMISSIONS_CUTOFF} and
 * dual-emit is enabled (the default — see {@link resolveDualEmitSubagentPermissions}),
 * a V2 `permissions` array converted from the legacy `permission` value is ADDED
 * while the original `permission` key is PRESERVED byte-for-byte, so both newer
 * CLIs (which prefer `permissions`) and older CLIs (which require `permission`)
 * accept the same config. When dual-emit is disabled the legacy key is replaced
 * by the converted array (gated single-shape behavior). Definitions already
 * carrying a `permissions` array pass through untouched; when the gate is off
 * (older/unknown version) the input is returned unchanged.
 * Fail-open: any error returns the input unchanged so dispatch never fails.
 * @param subagents - Map of subagent name → definition.
 * @param cliVersion - Raw detected CLI version; defaults to the last probed version.
 * @param dualEmit - Optional dual-emit override; env/module default applies when omitted.
 * @returns The (possibly upgraded) subagent map.
 */
export function normalizeSubagentPermissionsForVersion(
  subagents: Record<string, Record<string, unknown>>,
  cliVersion?: string | null,
  dualEmit?: boolean,
): Record<string, Record<string, unknown>> {
  try {
    const version = cliVersion ?? cachedOpenCodeVersionRaw;
    if (!shouldUseV2SubagentPermissions(version)) return subagents;
    const dual = resolveDualEmitSubagentPermissions(dualEmit);
    const upgraded: Record<string, Record<string, unknown>> = {};
    for (const [name, def] of Object.entries(subagents ?? {})) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) {
        upgraded[name] = def;
        continue;
      }
      const rec = def as Record<string, unknown>;
      if (Array.isArray(rec.permissions)) {
        upgraded[name] = rec;
        continue;
      }
      const converted =
        rec.permission !== undefined ? convertV1PermissionToV2Array(rec.permission) : null;
      if (!converted) {
        upgraded[name] = rec;
        continue;
      }
      if (dual) {
        upgraded[name] = { ...rec, permissions: converted };
        continue;
      }
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rec)) {
        if (key !== 'permission') rest[key] = value;
      }
      upgraded[name] = { ...rest, permissions: converted };
    }
    return upgraded;
  } catch (err) {
    core.warning(
      `Subagent permission normalization failed (${err instanceof Error ? err.message : String(err)}) — using the legacy permission shape.`,
    );
    return subagents;
  }
}

/**
 * Build a read-only review subagent definition for the OpenCode config.
 * Subagents run with edit and bash/shell denied so they can only inspect code
 * and report findings; they are dispatched by the primary agent via the task tool.
 *
 * The deny-block shape is version-gated: CLI >= {@link SUBAGENT_V2_PERMISSIONS_CUTOFF}
 * with dual-emit enabled (the default) gets BOTH the legacy `permission` object
 * (byte-for-byte) AND the V2 `permissions` array with equivalent deny semantics,
 * so the same config works on newer and older CLIs. With dual-emit disabled the
 * gate falls back to single-shape behavior (V2-only on new CLIs, legacy-only on
 * old/unknown versions). Fail-open: gating errors fall back to legacy.
 * Strict-schema note: dual-emit assumes V2 CLIs tolerate the extra legacy
 * `permission` key (the V2 docs say "Do not use `permission`..."). If a V2 CLI
 * strictly validates and rejects it, pass `dualEmit: false` (or use the
 * `dualEmitSubagentPermissions` run option, `setDualEmitSubagentPermissions`,
 * or `OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS=false`) for V2-only output.
 * @param description - The subagent's role description (shown to the primary agent).
 * @param model - Optional per-subagent model override (defaults to the primary's model).
 * @param cliVersion - Optional detected CLI version; defaults to the last probed version.
 * @param dualEmit - Optional dual-emit override; env/module default applies when omitted.
 * @returns A subagent config object for the `agent` block.
 */
export function buildReviewSubagent(
  description: string,
  model?: string,
  cliVersion?: string | null,
  dualEmit?: boolean,
): Record<string, unknown> {
  const def: Record<string, unknown> = {
    description,
    mode: 'subagent',
  };
  try {
    const version = cliVersion ?? cachedOpenCodeVersionRaw;
    if (shouldUseV2SubagentPermissions(version)) {
      if (resolveDualEmitSubagentPermissions(dualEmit)) {
        // Dual-emit assumes V2 CLIs tolerate the legacy key alongside
        // `permissions` (see module-default docs for the strict-schema opt-out).
        def.permission = { ...LEGACY_SUBAGENT_PERMISSION };
        def.permissions = buildV2SubagentDenyPermissions();
      } else {
        def.permissions = buildV2SubagentDenyPermissions();
      }
    } else {
      def.permission = { ...LEGACY_SUBAGENT_PERMISSION };
    }
  } catch {
    // biome-ignore lint/performance/noDelete: fail-open must remove a half-written key
    delete def.permissions;
    def.permission = { ...LEGACY_SUBAGENT_PERMISSION };
  }
  if (model) def.model = model;
  return def;
}

/**
 * CLI version at or above which MCP servers use the V2 `mcp.servers` map
 * shape (`mcp: { servers: { <name>: {..., disabled: false} } }`). Older
 * versions keep the legacy V1 map shape (`mcp: { <name>: {...} }`).
 *
 * The V2 config schema belongs to the OpenCode 2.x line only, mirroring the
 * {@link SUBAGENT_V2_PERMISSIONS_CUTOFF} precedent — so the cutoff stays on
 * the 2.x major. Unknown or unparseable versions fail open to dual-emit (both
 * shapes) rather than to either single shape, so reviews keep working on both
 * old and new CLIs until the version is known.
 *
 * Docs: https://opencode.ai/docs/mcp/servers/ (V2 `mcp.servers` map +
 * `disabled` flag) and https://opencode.ai/docs/config/ (V1 vs V2 migration).
 * @since NEXT
 */
export const MCP_V2_SERVERS_CUTOFF = '2.0.0';

/**
 * Decide whether an MCP config should carry the V2 `mcp.servers` map shape
 * for a given detected CLI version. Fail-open: unknown, missing, or
 * unparseable versions return false (legacy shape only, unless the caller
 * dual-emits) so config generation never fails because of this gate. Results
 * are cached per version string.
 * @param cliVersion - Raw detected CLI version (e.g. "v2.0.0"), or null/undefined when unknown.
 * @returns True when the CLI is at or above {@link MCP_V2_SERVERS_CUTOFF}.
 * @since NEXT
 */
export function shouldUseV2MCPServers(cliVersion?: string | null): boolean {
  try {
    if (typeof cliVersion !== 'string') return false;
    const key = cliVersion.trim();
    if (!key) return false;
    const cached = mcpV2DecisionCache.get(key);
    if (cached !== undefined) return cached;
    const cmp = compareVersions(key, MCP_V2_SERVERS_CUTOFF);
    if (cmp === UNPARSEABLE_VERSION) {
      core.warning(
        `OpenCode version "${key}" could not be parsed for the MCP servers gate — using the legacy mcp shape.`,
      );
      mcpV2DecisionCache.set(key, false);
      return false;
    }
    const result = cmp >= 0;
    mcpV2DecisionCache.set(key, result);
    return result;
  } catch (err) {
    core.warning(
      `MCP servers version gate failed (${err instanceof Error ? err.message : String(err)}) — using the legacy mcp shape.`,
    );
    return false;
  }
}

/**
 * Build the value for the `mcp` config key from a server list, selecting the
 * wire shape by CLI version.
 *
 * - Unknown version (or unparseable): dual-emit — legacy V1 named entries
 *   PLUS the V2 `servers` map (when dual-emit is enabled, the default);
 *   legacy-only when dual-emit is disabled.
 * - V1-only CLI (below {@link MCP_V2_SERVERS_CUTOFF}): legacy V1 named
 *   entries only (dual-emit is still accepted by old CLIs, but a strict V1
 *   reader may reject the unknown `servers` key, so single-shape is safer).
 * - V2-only CLI: V2 `servers` map; legacy named entries are ADDED alongside
 *   when dual-emit is enabled (the default) and omitted when disabled.
 *
 * V1 readers ignore the `servers` key; V2 readers ignore the legacy sibling
 * keys — so the dual shape works on both. Fail-open: any error returns the
 * legacy V1 map so config generation never throws.
 * @param servers - The internal server configs to serialize.
 * @param cliVersion - Raw detected CLI version; defaults to the last probed version.
 * @param dualEmit - Optional dual-emit override; env/module default applies when omitted.
 * @returns The `mcp` config value.
 * @since NEXT
 */
export function buildMCPConfigBlock(
  servers: MCPServerConfig[],
  cliVersion?: string | null,
  dualEmit?: boolean,
): Record<string, unknown> {
  try {
    const list = Array.isArray(servers) ? servers : [];
    const version = cliVersion ?? cachedOpenCodeVersionRaw;
    const dual = resolveDualEmitMCP(dualEmit);
    const v1 = toV1ServersMap(list);
    if (!shouldUseV2MCPServers(version)) {
      // Known-old CLI → legacy only. Unknown version → dual (fail-open) so
      // new CLIs still pick up their servers via `mcp.servers`.
      const known = typeof version === 'string' && version.trim() !== '';
      if (known) return { ...v1 };
      if (!dual) return { ...v1 };
      return { ...v1, servers: toV2ServersMap(list) };
    }
    if (dual) return { ...v1, servers: toV2ServersMap(list) };
    return { servers: toV2ServersMap(list) };
  } catch (err) {
    core.warning(
      `MCP config block build failed (${err instanceof Error ? err.message : String(err)}) — using the legacy mcp shape.`,
    );
    try {
      return { ...toV1ServersMap(Array.isArray(servers) ? servers : []) };
    } catch {
      return {};
    }
  }
}

/**
 * Merge an MCP server list into a base OpenCode config JSON string under the
 * `mcp` key, selecting the wire shape via {@link buildMCPConfigBlock}.
 * Pre-existing `mcp` entries in the base config are preserved (the built
 * block wins on key conflicts; `servers` maps are merged when both sides
 * carry one) so custom MCP entries are not silently dropped.
 * Fail-open: unparseable base configs are returned unchanged.
 * @param baseConfig - The base OpenCode config JSON (CI or custom).
 * @param servers - The internal server configs to inject.
 * @param cliVersion - Optional detected CLI version; defaults to the last probed version.
 * @param dualEmit - Optional dual-emit override; env/module default applies when omitted.
 * @returns The config JSON with the `mcp` block merged in.
 * @since NEXT
 */
export function mergeMCPConfig(
  baseConfig: string,
  servers: MCPServerConfig[],
  cliVersion?: string | null,
  dualEmit?: boolean,
): string {
  if (!Array.isArray(servers) || servers.length === 0) return baseConfig;
  try {
    const parsed = JSON.parse(baseConfig) as Record<string, unknown>;
    const existing =
      parsed.mcp && typeof parsed.mcp === 'object' && !Array.isArray(parsed.mcp)
        ? (parsed.mcp as Record<string, unknown>)
        : {};
    const built = buildMCPConfigBlock(servers, cliVersion, dualEmit);
    const existingServers =
      existing.servers && typeof existing.servers === 'object' && !Array.isArray(existing.servers)
        ? (existing.servers as Record<string, unknown>)
        : undefined;
    const builtServers =
      built.servers && typeof built.servers === 'object' && !Array.isArray(built.servers)
        ? (built.servers as Record<string, unknown>)
        : undefined;
    parsed.mcp = {
      ...existing,
      ...built,
      ...(existingServers && builtServers
        ? { servers: { ...existingServers, ...builtServers } }
        : {}),
    };
    return JSON.stringify(parsed);
  } catch {
    return baseConfig;
  }
}

/**
 * Normalize the `mcp` block of an existing config JSON string for the
 * detected CLI version, upgrading legacy named entries with the V2 `servers`
 * map (each entry gaining `disabled: false` unless already set).
 *
 * - Empty/missing/non-object `mcp` blocks pass through untouched (the CI
 *   config intentionally clears MCP with `mcp: {}`).
 * - Blocks that already carry a `servers` map pass through untouched, except
 *   with dual-emit disabled on a V2 CLI they are downgraded to servers-only,
 *   on a known V1 CLI the `servers` key is stripped (legacy-only), and on an
 *   unknown CLI with dual-emit disabled the `servers` key is stripped
 *   (legacy-only per {@link buildMCPConfigBlock} semantics).
 * - Legacy-only blocks on an unknown or V2 CLI gain the `servers` map when
 *   dual-emit is enabled (the default); with dual-emit disabled they stay
 *   legacy-only on unknown/V1 CLIs and become servers-only on a V2 CLI.
 * - Legacy-only blocks on a known V1 CLI are returned unchanged.
 *
 * Fail-open: any error returns the input unchanged.
 * @param configJson - The OpenCode config JSON to normalize.
 * @param cliVersion - Optional detected CLI version; defaults to the last probed version.
 * @param dualEmit - Optional dual-emit override; env/module default applies when omitted.
 * @returns The (possibly upgraded) config JSON.
 * @since NEXT
 */
export function normalizeMCPConfigForVersion(
  configJson: string,
  cliVersion?: string | null,
  dualEmit?: boolean,
): string {
  try {
    const parsed = JSON.parse(configJson) as Record<string, unknown>;
    const mcp = parsed.mcp;
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return configJson;
    const block = mcp as Record<string, unknown>;
    const keys = Object.keys(block);
    if (keys.length === 0) return configJson;
    const version = cliVersion ?? cachedOpenCodeVersionRaw;
    const dual = resolveDualEmitMCP(dualEmit);
    const onV2 = shouldUseV2MCPServers(version);
    const known = typeof version === 'string' && version.trim() !== '';
    if (block.servers && typeof block.servers === 'object' && !Array.isArray(block.servers)) {
      // Already carries the V2 shape. Normalize symmetrically:
      // - Known V1 reader: strip the `servers` key (legacy-only), since a
      //   strict V1 CLI may reject the unknown key.
      // - Unknown version with dual-emit disabled: strip the `servers` key
      //   (legacy-only per buildMCPConfigBlock semantics).
      // - V2 CLI with dual-emit disabled: downgrade to servers-only.
      if (!onV2 && (known || !dual)) return stripV2ServersKey(configJson);
      if (!dual && onV2) return stripLegacyMCPKeys(configJson);
      return configJson;
    }
    if (!onV2 && known) return configJson;
    const servers: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(block)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      servers[name] =
        typeof (rec as { disabled?: unknown }).disabled === 'boolean'
          ? { ...rec }
          : { ...rec, disabled: false };
    }
    if (Object.keys(servers).length === 0) return configJson;
    if (dual) {
      parsed.mcp = { ...block, servers };
    } else if (onV2) {
      parsed.mcp = { servers };
    } else {
      return configJson;
    }
    return JSON.stringify(parsed);
  } catch {
    return configJson;
  }
}

/**
 * Detect a strict-schema config rejection of the dual-emitted MCP block in
 * CLI output (a V2 CLI refusing the legacy sibling keys, or a V1 CLI refusing
 * the V2 `servers` key). Matching is substring-based and case-insensitive;
 * non-string or empty input never matches. Only the `mcp` signal counts
 * (which also covers `mcp.servers`); bare `disabled`/`servers`/`permissions`
 * mentions without `mcp` (e.g. subagent permission rejections or unrelated
 * "tool disabled" errors) must not trigger an MCP retry.
 * @param output - Combined stdout/stderr of the failed CLI run.
 * @returns True when the output looks like a strict MCP config rejection.
 * @since NEXT
 */
export function isMCPConfigRejection(output: unknown): boolean {
  if (typeof output !== 'string' || !output) return false;
  const text = output.toLowerCase();
  const mentionsConfigProblem =
    text.includes('configuration is invalid') ||
    text.includes('invalid configuration') ||
    text.includes('config validation') ||
    text.includes('failed to parse config') ||
    text.includes('unknown field') ||
    text.includes('unexpected field') ||
    text.includes('strict') ||
    text.includes('not supported by opencode');
  if (!mentionsConfigProblem) return false;
  return text.includes('mcp');
}

/**
 * Strip the legacy V1 sibling keys from a dual-emitted `mcp` block, keeping
 * only the V2 `servers` map — the single-shape payload for the retry after a
 * strict-schema rejection. Configs without an `mcp.servers` map are returned
 * unchanged. Fail-open: any error returns the input unchanged.
 * @param configJson - The OpenCode config JSON that was rejected.
 * @returns The config JSON with only `mcp: { servers: {...} }`.
 * @since NEXT
 */
export function stripLegacyMCPKeys(configJson: string): string {
  try {
    const parsed = JSON.parse(configJson) as Record<string, unknown>;
    const mcp = parsed.mcp;
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return configJson;
    const block = mcp as Record<string, unknown>;
    const servers = block.servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return configJson;
    parsed.mcp = { servers };
    return JSON.stringify(parsed);
  } catch {
    return configJson;
  }
}

/**
 * Strip the V2 `servers` key from a dual-emitted `mcp` block, keeping only
 * the legacy V1 sibling keys — the single-shape payload for the retry after a
 * strict V1 reader rejects the unknown `servers` key. Configs without a
 * `servers` key are returned unchanged. Fail-open: any error returns the
 * input unchanged.
 * @param configJson - The OpenCode config JSON that was rejected.
 * @returns The config JSON with only the legacy V1 `mcp` entries.
 * @since NEXT
 */
export function stripV2ServersKey(configJson: string): string {
  try {
    const parsed = JSON.parse(configJson) as Record<string, unknown>;
    const mcp = parsed.mcp;
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return configJson;
    const block = mcp as Record<string, unknown>;
    if (!('servers' in block)) return configJson;
    const { servers: _removed, ...legacy } = block;
    parsed.mcp = legacy;
    return JSON.stringify(parsed);
  } catch {
    return configJson;
  }
}

/**
 * Record a strict-schema MCP config rejection: auto-disable MCP dual-emit
 * for the rest of the process so subsequent runs emit the gated single shape.
 * Called automatically by {@link runOpenCode} before its one retry-without-
 * legacy; exported so custom runners can share the same fail-open behavior.
 * @since NEXT
 */
export function noteMCPConfigRejection(): void {
  dualEmitMCPDefault = false;
  core.warning(
    'OpenCode CLI rejected the dual-emitted MCP config — dual-emit disabled for subsequent runs ' +
      '(set OPENCODE_DUAL_EMIT_MCP=true to re-enable).',
  );
}

/**
 * Resolve a model string, prefixing a configured default provider when the
 * model is bare (has no "provider/" prefix).
 *
 * When the default provider is Azure or AWS Bedrock and the matching provider
 * block declares a `deployment` / `modelId`, a bare model resolves to
 * "azure/<deployment>" / "amazon-bedrock/<model-id>" so a single config change
 * (endpoint + key + deployment) selects the hosted model. Otherwise a bare
 * model is prefixed with the default provider (e.g. "ollama/llama3").
 * @param model - The raw model string.
 * @param llm - The custom LLM provider configuration (may be `undefined`).
 * @returns The resolved "provider/model" model string.
 */
function resolveModel(model: string, llm: LLMConfig | undefined): string {
  const trimmed = model.trim();
  if (!trimmed || trimmed.includes('/')) return trimmed;
  const defaultProvider = llm?.defaultProvider?.trim();
  if (!defaultProvider) return trimmed;
  if (defaultProvider === 'azure') {
    const deployment = Object.values(llm?.providers ?? {})
      .find((p) => p?.type === 'azure' && p.deployment?.trim())
      ?.deployment?.trim();
    if (deployment) return `azure/${deployment}`;
  }
  if (defaultProvider === 'amazon-bedrock') {
    const modelId = Object.values(llm?.providers ?? {})
      .find((p) => p?.type === 'bedrock' && p.modelId?.trim())
      ?.modelId?.trim();
    if (modelId) return `amazon-bedrock/${modelId}`;
  }
  return `${defaultProvider}/${trimmed}`;
}

/**
 * Map of OpenCode provider prefixes (the part before `/` in a resolved
 * `provider/model` string) to the single API-key env var that provider
 * authenticates with.
 */
const PROVIDER_API_KEY: Readonly<Record<string, string>> = {
  opencode: 'OPENCODE_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GEMINI_API_KEY',
};

/**
 * Names the LLM API-key env vars that must be forwarded into the sandboxed
 * `opencode run` subprocess for a given resolved model.
 *
 * SECURITY (issue #544): the subprocess runs with `--auto` over untrusted
 * repo content (prompt-injection surface), so it receives only the active
 * provider's key instead of every configured key — a harvested `env` dump
 * then yields one credential, not four. Models whose provider is unknown
 * (custom/bedrock/azure/ollama setups carry their own auth) return an empty
 * list and callers fall back to forwarding all configured keys with a
 * warning, so no working configuration breaks.
 * @param model - The resolved `provider/model` string (see {@link resolveModel}).
 * @returns The env var name(s) to forward, or an empty array when the provider is unknown.
 */
export function llmApiKeysForModel(model: string): string[] {
  const prefix = model.split('/')[0]?.trim().toLowerCase() ?? '';
  const key = PROVIDER_API_KEY[prefix];
  return key ? [key] : [];
}

/**
 * Breakdown of token usage parsed from OpenCode CLI output.
 */
export interface TokenUsageBreakdown {
  /** Total tokens consumed, or 0 if no pattern matched. */
  totalTokens: number;
  /** Prompt (input) tokens when explicitly reported. */
  promptTokens?: number;
  /** Completion (output) tokens when explicitly reported. */
  completionTokens?: number;
}

function extractSingleToken(output: string, pattern: RegExp): number | undefined {
  const match = output.match(pattern);
  if (!match) return undefined;
  // Strip thousands separators so localized numbers like "12,345" parse fully.
  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  return undefined;
}

/**
 * Parse token usage from OpenCode CLI output, capturing the prompt/completion
 * breakdown in addition to the total.
 * Looks for common LLM token patterns (total_tokens, total tokens, the
 * Anthropic/Gemini input_tokens + output_tokens pair, and the OpenAI-style
 * prompt_tokens + completion_tokens pair).
 * @param output - The CLI output string to parse for token usage.
 * @returns An object with the total token count (0 if no pattern matches) and
 * optional prompt/completion token counts.
 */
export function parseTokenUsageDetailed(output: string): TokenUsageBreakdown {
  // Prioritize total_tokens patterns to avoid matching prompt_tokens or completion_tokens.
  // Use word-bounded key matches so suffixes like prompt_total_tokens are not accepted.
  const totalPatterns = [
    /\btotal_tokens\b["\s]*[:=]\s*([\d,]+)/i,
    /\btotal\s+tokens\b["\s]*[:=]\s*([\d,]+)/i,
  ];
  for (const pattern of totalPatterns) {
    const match = output.match(pattern);
    if (match) {
      const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        // Prefer the OpenAI-style prompt/completion pair, but some providers
        // (e.g. proxies/OpenRouter) report total_tokens together with the
        // Anthropic/Gemini input/output pair. Fall back to that pair so the
        // breakdown is not silently dropped for cost estimation.
        let promptTokens = extractSingleToken(output, /\bprompt_tokens\b["\s]*[:=]\s*([\d,]+)/i);
        if (promptTokens === undefined) {
          promptTokens = extractSingleToken(output, /\binput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
        }
        let completionTokens = extractSingleToken(
          output,
          /\bcompletion_tokens\b["\s]*[:=]\s*([\d,]+)/i,
        );
        if (completionTokens === undefined) {
          completionTokens = extractSingleToken(output, /\boutput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
        }
        return { totalTokens: parsed, promptTokens, completionTokens };
      }
    }
  }
  // Fallback 1: sum input_tokens + output_tokens (used by Anthropic, Gemini)
  const inputTokens = extractSingleToken(output, /\binput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
  const outputTokens = extractSingleToken(output, /\boutput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
  if (inputTokens !== undefined || outputTokens !== undefined) {
    return {
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    };
  }
  // Fallback 2: sum prompt_tokens + completion_tokens (OpenAI-style JSON that
  // omits total_tokens). Without this, such usage blocks would be lost entirely.
  const promptTokens = extractSingleToken(output, /\bprompt_tokens\b["\s]*[:=]\s*([\d,]+)/i);
  const completionTokens = extractSingleToken(
    output,
    /\bcompletion_tokens\b["\s]*[:=]\s*([\d,]+)/i,
  );
  if (promptTokens !== undefined || completionTokens !== undefined) {
    return {
      totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      promptTokens,
      completionTokens,
    };
  }
  return { totalTokens: 0 };
}

/**
 * Parse token usage from OpenCode CLI output.
 * Looks for common LLM token patterns. Returns 0 if no pattern matches.
 * @param output - The CLI output string to parse for token usage.
 * @returns The number of tokens used, or 0 if no pattern matches.
 */
export function parseTokenUsage(output: string): number {
  return parseTokenUsageDetailed(output).totalTokens;
}

export {
  KNOWN_PROVIDERS,
  MODEL_STRING_REGEX,
  validateModelString,
} from './utils/model-string.js';

/**
 * Execute the OpenCode CLI with a given prompt.
 * Spawns the binary with a sandboxed environment (only whitelisted env vars are forwarded)
 * and enforces a timeout via SIGTERM/SIGKILL.
 *
 * @param prompt - The prompt text to pass to OpenCode.
 * @param options - Execution options for the OpenCode process.
 * @param options.model - Model identifier (e.g. "openai/gpt-4", "anthropic/claude-sonnet-4").
 * @param options.workingDirectory - Working directory for the subprocess (default: cwd).
 * @param options.timeoutMinutes - Max runtime before forced termination (default: 20).
 * @param options.signal - Optional AbortSignal to cancel the OpenCode process externally.
 * @param options.env - Additional environment variables to forward.
 * @param options.quiet - When true, suppress forwarding the process transcript to
 * stdout/stderr (output is still captured for parsing/returning).
 * @param options.opencodeConfig - Custom OpenCode config JSON injected as
 * OPENCODE_CONFIG_CONTENT. When set, replaces the CI config for this run.
 * @param options.subagents - Optional map of subagent name → definition merged
 * into the injected OpenCode config under the `agent` key. The primary agent
 * can dispatch these read-only subagents via the task tool within this run.
 * @param options.autoApprove - When true (default), pass `--auto` to auto-approve
 * tool permissions. Set to false for interactive local use.
 * @param options.dualEmitSubagentPermissions - When true (default), V2-capable
 * subagent configs carry both the legacy `permission` object and the V2
 * `permissions` array. Set to false for gated single-shape behavior. When
 * omitted, the `OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS` env var or the module
 * default (see {@link setDualEmitSubagentPermissions}) applies.
 * Strict-schema note: dual-emit assumes V2 CLIs tolerate the extra legacy key
 * (V2 docs say "Do not use `permission`..."). If a V2 CLI strictly validates
 * and rejects it, pass `false` here or set the env var to `false`.
 * @param options.dualEmitMCP - When true (default), a custom `opencodeConfig`
 * carrying legacy `mcp` entries gains the V2 `mcp.servers` map (each entry
 * with `disabled: false`) on unknown/V2 CLIs. Set to `false` for gated
 * single-shape behavior, or set `OPENCODE_DUAL_EMIT_MCP=false`. A
 * strict-schema MCP rejection retries once without the legacy keys.
 * @param options.opencodeVariant - Optional model variant passed as
 * `opencode run --variant <value>` (string passthrough, off by default).
 * @param options.llm - Custom LLM provider configuration for this run. When
 * provided, it is used instead of the module-level config set via
 * {@link setLLMProviderConfig}, so long-lived processes can dispatch concurrent
 * runs with per-engine provider configs without racing a shared global.
 * @returns Object indicating success, output text, wall-clock duration in ms, and tokens used.
 */
export async function runOpenCode(
  prompt: string,
  options: {
    model: string;
    workingDirectory?: string;
    /** Timeout in minutes before killing OpenCode. Default: 10. */
    timeoutMinutes?: number;
    /** Optional AbortSignal to cancel the OpenCode process externally. */
    signal?: AbortSignal;
    env?: Record<string, string>;
    /** When true, do not stream the transcript to the CI logs. */
    quiet?: boolean;
    /** Custom OpenCode config JSON to inject as OPENCODE_CONFIG_CONTENT. */
    opencodeConfig?: string;
    /** Optional subagent definitions merged into the injected OpenCode config.
     * When provided, the primary agent can dispatch these subagents via the
     * task tool within a single `opencode run` session. */
    subagents?: Record<string, Record<string, unknown>>;
    /** Pass `--auto` to auto-approve tool permissions (default: true). */
    autoApprove?: boolean;
    /** Dual-emit V2 `permissions` alongside legacy `permission` (default: true). */
    dualEmitSubagentPermissions?: boolean;
    /** Dual-emit V2 `mcp.servers` alongside legacy `mcp` entries (default: true).
     * On a strict-schema rejection the run retries once without the legacy
     * keys and dual-emit is auto-disabled for the rest of the process. */
    dualEmitMCP?: boolean;
    /** Optional model variant passed as `opencode run --variant <value>`.
     * String passthrough only (`[A-Za-z0-9_-]`, max 64 chars); off by default.
     * Falls back to the run-mode override and `OPENCODE_VARIANT` env.
     * @since NEXT */
    opencodeVariant?: string;
    /** Resume a failed `network_error` run via `opencode run --session <id>`
     * instead of a full rerun. Guarded, default off; falls back to
     * `INPUT_RESUME_ON_NETWORK_ERROR` env. Fail-open: missing id or resume
     * errors fall back to the normal full-run result.
     * @since NEXT */
    resumeOnNetworkError?: boolean;
    /** Known opencode session id used as the resume key (`--session <id>`).
     * Falls back to parsing the failed run output via `extractTaskId()`.
     * @since NEXT */
    taskId?: string;
    /** Custom LLM provider configuration for this run (see JSDoc above). */
    llm?: LLMConfig;
  },
): Promise<{
  success: boolean;
  output: string;
  durationMs: number;
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
}> {
  return runOpenCodeInner(prompt, options);
}

async function runOpenCodeInner(
  prompt: string,
  options: {
    model: string;
    workingDirectory?: string;
    /** Timeout in minutes before killing OpenCode. Default: 10. */
    timeoutMinutes?: number;
    /** Optional AbortSignal to cancel the OpenCode process externally. */
    signal?: AbortSignal;
    env?: Record<string, string>;
    /** When true, do not stream the transcript to the CI logs. */
    quiet?: boolean;
    /** Custom OpenCode config JSON to inject as OPENCODE_CONFIG_CONTENT. */
    opencodeConfig?: string;
    /** Optional subagent definitions merged into the injected OpenCode config.
     * When provided, the primary agent can dispatch these subagents via the
     * task tool within a single `opencode run` session. */
    subagents?: Record<string, Record<string, unknown>>;
    /** Pass `--auto` to auto-approve tool permissions (default: true). */
    autoApprove?: boolean;
    /** Dual-emit V2 `permissions` alongside legacy `permission` (default: true). */
    dualEmitSubagentPermissions?: boolean;
    /** Dual-emit V2 `mcp.servers` alongside legacy `mcp` entries (default: true).
     * On a strict-schema rejection the run retries once without the legacy
     * keys and dual-emit is auto-disabled for the rest of the process. */
    dualEmitMCP?: boolean;
    /** Optional model variant passed as `opencode run --variant <value>`.
     * String passthrough only (`[A-Za-z0-9_-]`, max 64 chars); off by default.
     * Falls back to the run-mode override and `OPENCODE_VARIANT` env.
     * @since NEXT */
    opencodeVariant?: string;
    /** Resume a failed `network_error` run via `opencode run --session <id>`
     * instead of a full rerun. Guarded, default off; falls back to
     * `INPUT_RESUME_ON_NETWORK_ERROR` env. Fail-open: missing id or resume
     * errors fall back to the normal full-run result.
     * @since NEXT */
    resumeOnNetworkError?: boolean;
    /** Known opencode session id used as the resume key (`--session <id>`).
     * Falls back to parsing the failed run output via `extractTaskId()`.
     * @since NEXT */
    taskId?: string;
    /** Custom LLM provider configuration for this run (see JSDoc above). */
    llm?: LLMConfig;
  },
): Promise<{
  success: boolean;
  output: string;
  durationMs: number;
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
}> {
  // Explicit per-run config wins; the module global is only a fallback for
  // legacy callers that never pass `llm`. Engines always pass their own config
  // so concurrent runs never observe another engine's providers.
  const llm = options.llm ?? llmProviderConfig;
  validateModelString(resolveModel(options.model, llm));
  // Normalize whitespace-padded model values before they reach the CLI. A bare
  // model name is prefixed with the configured default LLM provider so
  // "llama3" + defaultProvider "ollama" resolves to "ollama/llama3".
  const model = resolveModel(options.model, llm);
  const binaryPath = opencodePath || (await setupOpenCode());
  // setupOpenCode() already validates (and throws on) an incompatible binary in
  // the same call, so only probe again when the binary was pre-set without
  // validation (e.g. a PATH binary resolved by resolveOpenCodePath, or an
  // externally pre-set opencodePath in a long-lived process). This avoids a
  // redundant `opencode --version` spawn on the fresh-setup hot path.
  if (binaryPath !== validatedOpenCodePath) {
    const health = await checkHealth({ binPath: binaryPath });
    if (!health.compatible) {
      throw new Error(health.message);
    }
  }
  const startTime = Date.now();
  const cwd = options.workingDirectory || process.cwd();
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }
  const timeoutMs = (options.timeoutMinutes ?? 20) * 60 * 1000;

  // --auto  → auto-approves any permission that is not explicitly "deny".
  //           This is the documented CI mechanism for opencode run.
  //           Docs: https://opencode.ai/docs/permissions#auto-mode
  // The local CLI disables auto-approval so interactive permission prompts work.
  const autoApprove = options.autoApprove ?? runModeOverride?.autoApprove ?? true;
  const args = ['run'];
  if (autoApprove) {
    args.push('--auto');
  }
  args.push('--model', model);
  // Optional `--variant` passthrough for reasoning-effort models (off by
  // default). Fail-open: absent/empty/invalid values and CLIs below the
  // variant cutoff run exactly as today (debug log, no flag, zero extra
  // spawns — the version comes from the already-completed health probe).
  let variantSent: string | undefined;
  const resolvedVariant = resolveOpenCodeVariant(options.opencodeVariant);
  if (resolvedVariant !== undefined) {
    if (!supportsOpenCodeVariant()) {
      core.debug(
        `Skipping opencode --variant "${resolvedVariant}": CLI version does not support it.`,
      );
    } else {
      variantSent = resolvedVariant;
      args.push('--variant', resolvedVariant);
    }
  }

  // Linux MAX_ARG_STRLEN is ~128 KiB (131 072 bytes).  The entire execve()
  // argv — binary path, flags, model string, and prompt — must stay below that
  // limit or the kernel throws E2BIG and child_process.spawn fails.  We allow
  // 96 KiB for the prompt alone, leaving ~32 KiB of headroom for the other
  // argv elements.  When the prompt exceeds this threshold we pipe it via
  // stdin instead of passing it as an argv element (gated on size alone, not
  // on autoApprove, so large interactive-local prompts also avoid E2BIG).
  // The opencode CLI reads ALL of stdin to EOF as the message when stdin is
  // not a TTY (see packages/opencode/src/cli/cmd/run.ts).
  const MAX_ARG_BYTES = 96 * 1024;
  const useStdinForPrompt = Buffer.byteLength(prompt, 'utf8') > MAX_ARG_BYTES;
  if (useStdinForPrompt) {
    core.info(
      `Prompt is ${Buffer.byteLength(prompt, 'utf8')} bytes (threshold ${MAX_ARG_BYTES}) — ` +
        'piping via stdin to avoid E2BIG.',
    );
  } else {
    args.push(prompt);
  }

  core.info(`Running OpenCode (model: ${model}, timeout: ${options.timeoutMinutes ?? 20}m)...`);

  // Forward configured API keys to OpenCode process environment.
  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
  const openaiApiKey = process.env.OPENAI_API_KEY || process.env.INPUT_OPENAI_API_KEY || '';
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY || process.env.INPUT_ANTHROPIC_API_KEY || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.INPUT_GEMINI_API_KEY || '';
  const opencodeApiKey = process.env.OPENCODE_API_KEY || process.env.INPUT_OPENCODE_API_KEY || '';

  const safeEnv: Record<string, string> = {};
  // NOTE: DATABASE_URL is intentionally NOT forwarded — it is consumed by the
  // reviewer's own learning store in the parent process only. AWS_* ambient
  // credentials are intentionally NOT in the allowlist either; they are
  // forwarded only for Bedrock provider runs (see applyLLMEnvOverrides).
  for (const key of SAFE_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) safeEnv[key] = val;
  }
  // Only forward GitHub tokens when non-empty so the child never inherits
  // an empty-string credential (fail-closed: no auth header is sent rather
  // than an invalid empty one).
  // SECURITY: GITHUB_TOKEN/GH_TOKEN and the LLM API keys below are required by
  // the CLI subprocess (git-push fix flows, provider access), but the
  // subprocess runs with `--auto` over untrusted repo content (prompt-injection
  // surface). Prefer a repo-scoped fine-grained PAT for GITHUB_TOKEN and keep
  // tool permissions least-privilege.
  if (githubToken) {
    safeEnv.GITHUB_TOKEN = githubToken;
    safeEnv.GH_TOKEN = githubToken;
  }
  // Least-exposure forwarding (issue #544): only the active provider's key
  // reaches the `--auto` subprocess running over untrusted repo content.
  // Unknown providers (custom/bedrock/azure/ollama carry their own auth, see
  // applyLLMEnvOverrides) or a missing scoped key fall back to forwarding all
  // configured keys with a warning, so no working setup breaks.
  const scopedKeys = llmApiKeysForModel(model);
  const keyValues: Record<string, string> = {
    OPENAI_API_KEY: openaiApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey,
    GEMINI_API_KEY: geminiApiKey,
    OPENCODE_API_KEY: opencodeApiKey,
  };
  if (scopedKeys.length === 1 && keyValues[scopedKeys[0]]) {
    safeEnv[scopedKeys[0]] = keyValues[scopedKeys[0]];
  } else {
    if (scopedKeys.length === 1) {
      core.warning(
        `Active provider key ${scopedKeys[0]} is unset for model ${model}; forwarding all configured LLM keys (status quo).`,
      );
    } else {
      core.warning(
        `Unknown model provider for ${model}; forwarding all configured LLM keys (status quo).`,
      );
    }
    if (openaiApiKey) safeEnv.OPENAI_API_KEY = openaiApiKey;
    if (anthropicApiKey) safeEnv.ANTHROPIC_API_KEY = anthropicApiKey;
    if (geminiApiKey) safeEnv.GEMINI_API_KEY = geminiApiKey;
    if (opencodeApiKey) safeEnv.OPENCODE_API_KEY = opencodeApiKey;
  }
  // NOTE: options.env is a trusted-caller escape hatch (programmatic API only,
  // never repo-controlled input) and merges after the allowlist above. To keep
  // the subprocess hardening (audit authz) from being silently bypassed by a
  // future caller, DATABASE_URL is never accepted here and AWS_* keys are only
  // accepted when a Bedrock provider is configured — both cases warn and skip.
  // The Bedrock exception is restricted to BEDROCK_AWS_KEYS (same list as
  // ambient forwarding) so arbitrary AWS_* cannot slip in via options.env.
  if (options.env) {
    const hasBedrockProvider = Object.values(llm?.providers ?? {}).some(
      (p) => p?.type === 'bedrock',
    );
    const bedrockAwsKeys = new Set<string>(BEDROCK_AWS_KEYS);
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined || key === 'OPENCODE_CONFIG_CONTENT') continue;
      if (key === 'DATABASE_URL') {
        core.warning('options.env DATABASE_URL is never forwarded to the subprocess; skipping.');
        continue;
      }
      // options.env is a trusted-caller escape hatch (programmatic API only,
      // never repo-controlled input), so generic keys still pass through.
      // Only subprocess-hijack keys are denied even from trusted callers:
      // dynamic-loader / runtime keys (LD_*, NODE_OPTIONS), PATH/HOME, and
      // GIT_* overrides would otherwise bypass the sandbox (LD_PRELOAD code
      // execution, binary shadowing, GIT_ASKPASS hijack).
      if (
        key.startsWith('LD_') ||
        key === 'NODE_OPTIONS' ||
        key === 'NODE_PRELOAD' ||
        key === 'PATH' ||
        key === 'HOME' ||
        key.startsWith('GIT_')
      ) {
        core.warning(`options.env ${key} is never forwarded to the subprocess; skipping.`);
        continue;
      }
      if (key.startsWith('AWS_') && !(hasBedrockProvider && bedrockAwsKeys.has(key))) {
        core.warning(`options.env ${key} skipped: AWS_* is only forwarded for Bedrock runs.`);
        continue;
      }
      safeEnv[key] = value;
    }
  }
  // Azure / Bedrock config blocks provide the standard AZURE_* / AWS_* vars
  // when they are not already present in the environment.
  applyLLMEnvOverrides(safeEnv, llm);
  // Provider entries reference secrets via "{env:VAR}" without expanding them
  // into OPENCODE_CONFIG_CONTENT; forward the referenced variables so the CLI's
  // own substitution resolves them inside the sandboxed subprocess environment.
  applyLLMEnvVarReferences(safeEnv, llm);
  // Isolate the embedded opencode store per run: every spawn gets a fresh
  // HOME (plus XDG dirs beneath it) so concurrent runs — in this process,
  // in other Node processes, or on other runners sharing a HOME — never race
  // the store migrations. This is what fixes the shared-store crash while
  // keeping batch fan-out concurrent. A caller-supplied HOME via options.env
  // is intentionally overridden (with a warning) because sharing a store is
  // exactly the crash being fixed. The temp dir is removed before return;
  // leftovers from abnormal throws are swept on process exit.
  if (options.env?.HOME !== undefined) {
    core.warning('options.env HOME is ignored: each opencode run uses an isolated store.');
  }
  const isolatedHome = createIsolatedOpenCodeHome();
  safeEnv.HOME = isolatedHome;
  safeEnv.XDG_DATA_HOME = path.join(isolatedHome, '.local', 'share');
  safeEnv.XDG_CONFIG_HOME = path.join(isolatedHome, '.config');
  safeEnv.XDG_CACHE_HOME = path.join(isolatedHome, '.cache');
  // Upgrade legacy subagent deny blocks to the V2 permissions array when the
  // probed binary is new enough. The version comes from the already-completed
  // checkHealth()/setupOpenCode() probe (cachedOpenCodeVersionRaw), so this
  // adds zero extra spawns. Unknown versions fail open to the legacy shape.
  // Dual-emit (default) preserves the legacy `permission` key alongside the V2
  // `permissions` array for maximum CLI compatibility.
  // Likewise, legacy `mcp` map entries gain the V2 `mcp.servers` map (with
  // `disabled: false`) when the version is unknown or V2-capable; the CI
  // config's intentionally-empty `mcp: {}` passes through untouched.
  safeEnv.OPENCODE_CONFIG_CONTENT = mergeLLMProviderConfig(
    normalizeMCPConfigForVersion(
      mergeSubagentConfig(
        options.opencodeConfig ?? runModeOverride?.opencodeConfig ?? buildCIConfig(),
        normalizeSubagentPermissionsForVersion(
          options.subagents ?? {},
          undefined,
          options.dualEmitSubagentPermissions,
        ),
      ),
      undefined,
      options.dualEmitMCP,
    ),
    llm,
  );
  safeEnv.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  const initialConfigContent = safeEnv.OPENCODE_CONFIG_CONTENT;

  const stdio: cp.StdioOptions = useStdinForPrompt
    ? ['pipe', 'pipe', 'pipe'] // pipe stdin so we can send the large prompt
    : autoApprove
      ? ['ignore', 'pipe', 'pipe'] // small prompt via argv, stdin ignored
      : ['inherit', 'pipe', 'pipe']; // interactive: forward terminal stdin

  // A single `opencode run` attempt with the given injected config. Extracted
  // so a strict-schema MCP rejection can retry once without the legacy keys
  // (see below) instead of failing the review outright.
  async function executeOnce(
    configContent: string,
    argv: readonly string[] = args,
  ): Promise<{
    success: boolean;
    output: string;
    tokensUsed: number;
    promptTokens?: number;
    completionTokens?: number;
  }> {
    const runEnv: Record<string, string> = {
      ...safeEnv,
      OPENCODE_CONFIG_CONTENT: configContent,
    };
    const childProcess = cp.spawn(binaryPath, [...argv], {
      cwd,
      stdio,
      env: runEnv,
      detached: true,
    });

    // When the prompt was too large for argv, pipe the full payload through stdin
    // and close the stream immediately so the CLI receives EOF and starts work.
    // The stdin 'error' listener prevents an uncaught EPIPE if the child exits
    // before consuming all of stdin.
    if (useStdinForPrompt) {
      childProcess.stdin!.on('error', () => {});
      childProcess.stdin!.end(prompt, 'utf8');
    }

    // Cap retained output to prevent memory exhaustion on verbose or stuck runs.
    // We keep only the last 50 KB which is sufficient for token parsing while
    // still forwarding all output to CI logs.
    const MAX_CAPTURED_BYTES = 50 * 1024;
    let capturedOutput = '';
    let tokenUsageResult = 0;
    let promptTokensResult = 0;
    let completionTokensResult = 0;

    function appendCaptured(text: string): void {
      capturedOutput += text;
      if (capturedOutput.length > MAX_CAPTURED_BYTES) {
        capturedOutput = capturedOutput.slice(-MAX_CAPTURED_BYTES);
      }
      const parsed = parseTokenUsageDetailed(text);
      if (parsed.totalTokens > 0) {
        tokenUsageResult = parsed.totalTokens;
      }
      if (parsed.promptTokens !== undefined && parsed.promptTokens > 0) {
        promptTokensResult = parsed.promptTokens;
      }
      if (parsed.completionTokens !== undefined && parsed.completionTokens > 0) {
        completionTokensResult = parsed.completionTokens;
      }
    }

    let timedOut = false;
    let childExited = false;
    let forceKillHandle: ReturnType<typeof setTimeout> | undefined;

    function killProcessGroup(signal: 'SIGTERM' | 'SIGKILL'): void {
      if (!childProcess.pid) return;
      try {
        if (os.platform() === 'win32') {
          cp.execFileSync('taskkill', ['/PID', String(childProcess.pid), '/T', '/F'], {
            stdio: 'ignore',
          });
        } else {
          process.kill(-childProcess.pid, signal);
        }
      } catch (err) {
        core.debug(`Failed to send ${signal} to process group: ${err}`);
      }
    }

    // Listen for external abort signal (e.g. from EventBus subscriber timeout)
    if (options.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          if (!childExited) {
            killProcessGroup('SIGTERM');
          }
        },
        { once: true },
      );
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      core.warning(
        `OpenCode timeout of ${options.timeoutMinutes ?? 20}m exceeded — sending SIGTERM.`,
      );
      killProcessGroup('SIGTERM');
      // If SIGTERM is ignored or too slow, force-kill after 5 seconds
      forceKillHandle = setTimeout(() => {
        if (!childExited) {
          core.warning('OpenCode did not exit after SIGTERM — sending SIGKILL.');
          killProcessGroup('SIGKILL');
        }
      }, 5_000);
    }, timeoutMs);

    childProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendCaptured(text);
      if (!options.quiet) {
        try {
          process.stdout.write(data);
        } catch {
          // Stream closed
        }
      }
    });
    childProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendCaptured(text);
      if (!options.quiet) {
        try {
          process.stderr.write(data);
        } catch {
          // Stream closed
        }
      }
    });

    let exitCode: number | null = null;
    let processError: string | undefined;

    try {
      await new Promise<void>((resolve) => {
        childProcess.on('close', (code) => {
          childExited = true;
          exitCode = code;
          resolve();
        });
        childProcess.on('error', (err) => {
          childExited = true;
          processError = err.message;
          resolve();
        });
      });

      const finalBreakdown = resolveTokenBreakdown(
        capturedOutput,
        tokenUsageResult,
        promptTokensResult,
        completionTokensResult,
      );

      if (exitCode === 0 && !processError) {
        core.info(`OpenCode finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        return {
          success: true,
          output: capturedOutput,
          tokensUsed: finalBreakdown.tokensUsed,
          promptTokens: finalBreakdown.promptTokens,
          completionTokens: finalBreakdown.completionTokens,
        };
      }

      core.warning(
        `OpenCode did not complete successfully (timedOut: ${timedOut}, exitCode: ${exitCode}, error: ${processError ?? 'none'})`,
      );
      // Fail open for older CLI versions that reject unknown provider option
      // keys: when timeout tuning was emitted and the CLI output names the
      // rejected keys, retry once without them (default timeouts). Bounded —
      // the stripped config carries no timeout options, so this cannot recurse.
      if (
        !timedOut &&
        !processError &&
        llmHasTimeoutOptions(llm) &&
        /\b(unknown|invalid|unexpected|unrecognized)[\w\s'".:-]{0,80}(headerTimeout|chunkTimeout)|(headerTimeout|chunkTimeout)[\w\s'".:-]{0,80}\b(unknown|invalid|unexpected|unrecognized|not supported|not allowed)/i.test(
          capturedOutput,
        )
      ) {
        core.warning(
          'OpenCode CLI appears to reject provider timeout keys (headerTimeout/chunkTimeout) — retrying once without them.',
        );
        return runOpenCodeInner(prompt, {
          ...options,
          opencodeConfig: options.opencodeConfig
            ? stripProviderTimeoutOptions(options.opencodeConfig)
            : undefined,
          llm: stripLLMTimeoutOptions(llm),
        });
      }
      // Fail open for older CLIs that reject the unknown `--variant` flag:
      // retry once without it. Bounded — the stripped call passes an explicit
      // empty variant which suppresses the env fallback in
      // resolveOpenCodeVariant(), so the retry sends no flag and cannot recurse.
      if (
        !timedOut &&
        !processError &&
        variantSent !== undefined &&
        isVariantFlagRejection(capturedOutput)
      ) {
        core.warning(
          'OpenCode CLI appears to reject the --variant flag — retrying once without it.',
        );
        return runOpenCodeInner(prompt, {
          ...options,
          opencodeVariant: '',
        });
      }
      return {
        success: false,
        output: capturedOutput,
        tokensUsed: finalBreakdown.tokensUsed,
        promptTokens: finalBreakdown.promptTokens,
        completionTokens: finalBreakdown.completionTokens,
      };
    } catch (err) {
      const finalBreakdown = resolveTokenBreakdown(
        capturedOutput,
        tokenUsageResult,
        promptTokensResult,
        completionTokensResult,
      );
      core.error(`OpenCode execution failed: ${String(err)}`);
      return {
        success: false,
        output: capturedOutput,
        tokensUsed: finalBreakdown.tokensUsed,
        promptTokens: finalBreakdown.promptTokens,
        completionTokens: finalBreakdown.completionTokens,
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (forceKillHandle !== undefined) {
        clearTimeout(forceKillHandle);
      }
    }
  }

  let attempt: Awaited<ReturnType<typeof executeOnce>>;
  try {
    attempt = await executeOnce(initialConfigContent);
    // Fail-open for strict-schema CLIs: when the run fails with a config
    // rejection and the injected config carried a dual-emitted `mcp` block,
    // retry exactly once with the offending side removed. A V1 reader rejects
    // the unknown `servers` key (output names `servers`) → retry legacy-only;
    // otherwise a V2 reader rejected the legacy siblings → retry servers-only.
    // MCP stays non-blocking throughout — the worst case is a review without
    // MCP enrichment, never a hard failure from dual-emit.
    if (!attempt.success && isMCPConfigRejection(attempt.output)) {
      // Direction-aware: only a V1 unknown-field rejection naming the V2
      // `servers` key retries legacy-only; any other MCP rejection (e.g. a V2
      // CLI refusing the legacy siblings, even when the message quotes
      // `mcp.servers`) retries servers-only. A bare `servers` substring (help
      // text, config dumps) must not flip the direction on its own.
      const outputText = attempt.output.toLowerCase();
      const v1RejectsServersKey = /(unknown|unexpected) field[^\n]*servers/.test(outputText);
      const stripped = v1RejectsServersKey
        ? stripV2ServersKey(initialConfigContent)
        : stripLegacyMCPKeys(initialConfigContent);
      if (stripped !== initialConfigContent) {
        noteMCPConfigRejection();
        core.warning(
          v1RejectsServersKey
            ? 'Retrying OpenCode run once without the V2 servers key (legacy-only).'
            : 'Retrying OpenCode run once without legacy MCP keys.',
        );
        attempt = await executeOnce(stripped);
      }
    }
    // Resumable retry on transient network failures (guarded, default off):
    // when the run failed with a `network_error` signature, retry once — via
    // `opencode run --session <id>` when a task/session id is known (explicit
    // `taskId` option wins, else parsed from the failed output), otherwise a
    // normal full rerun. Fail-open: missing/invalid id, resume-spawn errors,
    // and variant/MCP-style rejections of `--session` keep the original
    // attempt; the resume path never throws and never recurses.
    if (!attempt.success && resolveResumeOnNetworkError(options.resumeOnNetworkError)) {
      if (isNetworkErrorOutput(attempt.output)) {
        try {
          const candidate = options.taskId ?? extractTaskId(attempt.output);
          if (candidate !== undefined && !isValidResumeTaskId(candidate)) {
            core.debug('Ignoring invalid resume task id; falling back to full rerun.');
          }
          const resumeId =
            candidate !== undefined && isValidResumeTaskId(candidate) ? candidate : undefined;
          if (resumeId !== undefined) {
            core.warning(`OpenCode run hit a network error — resuming session ${resumeId}.`);
            const resumeArgs = buildResumeArgs(args, resumeId);
            const resumed = await executeOnce(initialConfigContent, resumeArgs);
            if (resumed.success) {
              attempt = resumed;
            } else {
              // Resume did not recover (unknown --session flag, expired
              // session, or another network blip): fail open to one normal
              // full rerun instead of surfacing the resume error.
              core.warning(
                'Resume attempt did not complete — falling back to a full run (fail-open).',
              );
              attempt = await executeOnce(initialConfigContent);
            }
          } else {
            core.warning('OpenCode run hit a network error — retrying once as a full run.');
            attempt = await executeOnce(initialConfigContent);
          }
        } catch (err) {
          try {
            new Logger('opencode').warn(
              `Resume-on-network-error failed open to full run: ${err instanceof Error ? err.message : String(err)}`,
            );
          } catch {
            // Logger must never break the fail-open path.
          }
        }
      }
    }
  } finally {
    // Async removal keeps the recursive rm off the event-loop critical path;
    // the sync variant remains for process-exit handlers where async is unavailable.
    await cleanupIsolatedOpenCodeHomeAsync(isolatedHome);
  }
  const durationMs = Date.now() - startTime;
  return { ...attempt, durationMs };
}

/**
 * Compute the final token breakdown, preferring a full parse of the retained
 * output and falling back to the incremental per-chunk totals.
 * @param capturedOutput - The retained CLI output string.
 * @param incrementalTotal - Total token count accumulated from chunk parsing.
 * @param incrementalPrompt - Prompt token count accumulated from chunk parsing.
 * @param incrementalCompletion - Completion token count accumulated from chunk parsing.
 * @returns The merged token breakdown.
 */
function resolveTokenBreakdown(
  capturedOutput: string,
  incrementalTotal: number,
  incrementalPrompt: number,
  incrementalCompletion: number,
): {
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
} {
  const parsed = parseTokenUsageDetailed(capturedOutput);
  return {
    tokensUsed: parsed.totalTokens || incrementalTotal,
    promptTokens: parsed.promptTokens ?? (incrementalPrompt || undefined),
    completionTokens: parsed.completionTokens ?? (incrementalCompletion || undefined),
  };
}

/**
 * Configure git user name, email, and authentication for the CI environment.
 * Strips any existing http.extraheader entries to avoid duplicate auth headers,
 * and sets up GIT_ASKPASS for token-based authentication without leaking
 * credentials into git config.
 *
 * When `cwd` is provided (app tempDir context), env vars are returned instead of
 * setting global process.env, avoiding cross-contamination between concurrent
 * webhook events. The caller should pass the returned env to execFileSync.
 *
 * @param userName - Git user name (defaults to GITHUB_ACTOR or "opencode-ai-reviewer[bot]").
 * @param userEmail - Git user email (defaults to user name @ users.noreply.github.com).
 * @param token - GitHub token for authentication via GIT_ASKPASS.
 * @param cwd - Optional working directory. When set, env vars are returned (not set globally).
 * @returns Process env vars when cwd is provided; empty object otherwise.
 */
export function configureGit(
  userName?: string,
  userEmail?: string,
  token?: string,
  cwd?: string,
): Record<string, string> {
  const name = userName || process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]';
  const email = userEmail || `${name}@users.noreply.github.com`;

  const execOptions: cp.ExecFileSyncOptions = cwd ? { cwd } : {};

  try {
    cp.execFileSync('git', ['config', '--local', 'user.name', name], execOptions);
    cp.execFileSync('git', ['config', '--local', 'user.email', email], execOptions);

    if (cwd) {
      // Isolation mode: return env vars for the caller to pass explicitly,
      // avoiding global process.env mutation that would conflict between
      // concurrent webhook events.
      if (token) {
        // Write the askpass helper to a temp dir, never into the workspace, so
        // an autofix `git add -A` cannot accidentally commit it to the repo.
        const askPassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-askpass-'));
        askPassDirs.push(askPassDir);
        const askPassPath = path.join(askPassDir, 'credential.sh');
        fs.writeFileSync(
          askPassPath,
          [
            '#!/bin/sh',
            'case "$1" in',
            '  *Username*) echo "x-access-token" ;;',
            '  *Password*) echo "${OPENCODE_CREDENTIAL_TOKEN}" ;;',
            'esac',
          ].join('\n'),
          { encoding: 'utf-8', mode: 0o700 },
        );
        const gitEnv: Record<string, string> = {
          GIT_ASKPASS: askPassPath,
          OPENCODE_CREDENTIAL_TOKEN: token,
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
        };
        core.info(`Git configured (isolated): ${name} <${email}>`);
        return gitEnv;
      }
      core.info(`Git configured (isolated): ${name} <${email}>`);
      return {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      };
    }

    // Legacy global mode (action package, no cwd)
    process.env.GIT_AUTHOR_NAME = name;
    process.env.GIT_AUTHOR_EMAIL = email;
    process.env.GIT_COMMITTER_NAME = name;
    process.env.GIT_COMMITTER_EMAIL = email;

    if (token) {
      // Remove ALL http.extraheader entries from every git config file
      // (including those from actions/checkout@v6+ stored via includeIf).
      // Without this, git sends duplicate Authorization headers on push.
      let origins = '';
      try {
        origins = cp.execFileSync('git', ['config', '--list', '--show-origin'], {
          ...execOptions,
          encoding: 'utf-8',
        });
      } catch {
        /* git config --list failed entirely */
      }
      const cwdForCheck = cwd || process.cwd();
      for (const line of origins.split('\n')) {
        if (!line.includes('http.') || !line.includes('.extraheader')) continue;
        const tabIdx = line.indexOf('\t');
        if (tabIdx <= 0) continue;
        const prefix = line.substring(0, tabIdx);
        if (!prefix.startsWith('file:')) continue;
        const cfg = prefix.substring(5);
        let resolvedCfg: string;
        try {
          resolvedCfg = fs.realpathSync(cfg);
        } catch {
          resolvedCfg = path.resolve(cfg);
        }
        // Only modify config files in trusted locations
        const relHome = path.relative(os.homedir(), resolvedCfg);
        const relCwd = path.relative(cwdForCheck, resolvedCfg);
        if (relHome.startsWith('..') && relCwd.startsWith('..')) {
          continue;
        }
        try {
          cp.execFileSync('git', [
            'config',
            '--file',
            resolvedCfg,
            '--unset-all',
            'http.https://github.com/.extraheader',
          ]);
        } catch {
          /* key not in this file */
        }
      }

      // Use GIT_ASKPASS instead of a shell-function credential helper so the token
      // is never embedded in git config output (visible via git config --list).
      // The token is read from an env var by the askpass script at credential time.
      try {
        cp.execFileSync(
          'git',
          ['config', '--local', '--unset-all', 'credential.https://github.com/.helper'],
          execOptions,
        );
      } catch {
        /* no previous helper to clear */
      }
      const askPassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-askpass-'));
      askPassDirs.push(askPassDir);
      const askPassPath = path.join(askPassDir, 'credential.sh');
      fs.writeFileSync(
        askPassPath,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  *Username*) echo "x-access-token" ;;',
          '  *Password*) echo "${OPENCODE_CREDENTIAL_TOKEN}" ;;',
          'esac',
        ].join('\n'),
        { encoding: 'utf-8', mode: 0o700 },
      );
      process.env.GIT_ASKPASS = askPassPath;
      process.env.OPENCODE_CREDENTIAL_TOKEN = token;
    }
  } catch (err) {
    core.warning(`configureGit failed: ${String(err)}`);
    return {};
  }

  core.info(`Git configured: ${name} <${email}>`);
  return {};
}

/**
 * Get the current git working-tree status as a porcelain string.
 *
 * @param cwd - Optional working directory to run git status in.
 * @returns Porcelain git status output, or empty string if git is not available.
 */
export function getGitStatus(cwd?: string): string {
  try {
    return cp.execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {}),
    });
  } catch {
    return '';
  }
}

/**
 * Detect the workspace package manager (pnpm/yarn/npm) and install dependencies
 * if node_modules is missing. Installs the package manager binary itself if not found.
 *
 * @param cwd - Workspace root directory.
 */
export async function setupWorkspaceDependencies(cwd: string): Promise<void> {
  core.info('Checking workspace package manager and dependencies...');

  const hasPnpmLock = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'));
  const hasYarnLock = fs.existsSync(path.join(cwd, 'yarn.lock'));
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));

  if (!hasPackageJson) {
    core.info('No package.json found in workspace root. Skipping package manager setup.');
    return;
  }

  // 1. Install package manager if needed
  if (hasPnpmLock) {
    try {
      cp.execFileSync('pnpm', ['--version'], { stdio: 'ignore' });
      core.info('pnpm is already installed.');
    } catch {
      core.info('pnpm not found. Installing pnpm globally...');
      try {
        cp.execFileSync('corepack', ['enable'], { stdio: 'inherit' });
        cp.execFileSync('corepack', ['prepare', 'pnpm@latest', '--activate'], { stdio: 'inherit' });
        core.info('pnpm enabled successfully via corepack.');
      } catch (err) {
        core.info(`Corepack failed: ${String(err)}. Installing pnpm globally without sudo...`);
        try {
          cp.execFileSync('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' });
          core.info('pnpm installed successfully.');
        } catch (npmErr) {
          core.error(
            `Failed to install pnpm globally: ${String(npmErr)}. Checks using pnpm might fail.`,
          );
        }
      }
    }
  } else if (hasYarnLock) {
    try {
      cp.execFileSync('yarn', ['--version'], { stdio: 'ignore' });
      core.info('yarn is already installed.');
    } catch {
      core.info('yarn not found. Installing yarn globally...');
      try {
        cp.execFileSync('npm', ['install', '-g', 'yarn'], { stdio: 'inherit' });
        core.info('yarn installed successfully.');
      } catch (err) {
        core.warning(`Failed to install yarn globally: ${String(err)}`);
      }
    }
  }

  // 2. Install workspace dependencies if node_modules does not exist.
  // The workspace is PR-controlled (untrusted): always pass --ignore-scripts
  // so attacker-controlled preinstall/postinstall hooks never execute with
  // runner credentials. Run `pnpm approve-builds` / explicit build steps
  // separately when scripts are actually needed.
  const hasNodeModules = fs.existsSync(path.join(cwd, 'node_modules'));
  if (!hasNodeModules) {
    core.info('node_modules not found. Installing dependencies...');
    try {
      if (hasPnpmLock) {
        core.info('Running pnpm install...');
        cp.execFileSync('pnpm', ['install', '--ignore-scripts'], { cwd, stdio: 'inherit' });
      } else if (hasYarnLock) {
        core.info('Running yarn install...');
        cp.execFileSync('yarn', ['install', '--ignore-scripts'], { cwd, stdio: 'inherit' });
      } else {
        core.info('Running npm install...');
        cp.execFileSync('npm', ['install', '--ignore-scripts'], { cwd, stdio: 'inherit' });
      }
      core.info('Workspace dependencies installed successfully.');
    } catch (err) {
      core.error(`Failed to install workspace dependencies: ${String(err)}`);
    }
  } else {
    core.info('node_modules directory already exists. Skipping dependency installation.');
  }
}

/**
 * Ensure the parent directory of a file path exists, creating it recursively if needed.
 *
 * @param outputFile - Path to a file whose parent directory should exist.
 */
export function ensureOutputDir(outputFile: string): void {
  const dir = path.dirname(path.resolve(outputFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
