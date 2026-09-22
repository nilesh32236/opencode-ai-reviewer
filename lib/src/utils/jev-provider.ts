/**
 * Jev pluggable provider module (SDK provider seam).
 *
 * Unified transport seam over the three per-concern Jev providers introduced
 * by Modules 1-3 (`JevValidityProvider`, `JevRelevanceProvider`,
 * `JevDiffRiskProvider` in `jev-client.ts`): validity pre-filter scoring,
 * relevance (context-rank) scoring, and diff-risk assessment. REST
 * (`RestJevProvider`, composing the three `Rest*` transports) stays the only
 * real transport and the default — zero new dependencies, zero behavior
 * change. A future SDK-backed provider (`SdkJevProvider` stub below) plugs
 * into the same `JevProvider` interface without touching Module 1-3 call
 * sites: every existing options bag already accepts its per-concern slice,
 * and a unified `JevProvider` satisfies all three structurally.
 *
 * Transport contract (both providers):
 * - REST path keeps the Zen gateway wire shape exactly: `POST`
 *   `https://opencode.ai/zen/v1/systemone` with
 *   `{ model, state, questions }` (shared state string + questions map keyed
 *   by caller id, with the documented `criteria` shapes). The `criteria`
 *   shape is untouched on the REST path — never renamed to `options`,
 *   never translated.
 * - Fail-open for genuine failures (per-assessment `unavailable` /
 *   `unknown`); caller cancellation (`AbortSignal`) rejects so aborts
 *   propagate. `JEV_ENABLED=false` remains the default; nothing here reads
 *   or changes the enable gate.
 *
 * Environment:
 * - `JEV_PROVIDER` — transport selection; `rest` (default) or `sdk`.
 *   Unset, blank, or unrecognized values resolve to `rest` (fail-safe), so
 *   existing deployments keep current behavior. `sdk` selects the
 *   `SdkJevProvider` stub, which fails open until the real SDK transport
 *   lands (see `SDK_JEV_PROVIDER_TODO`).
 * - `JEV_MODEL`, `JEV_TIMEOUT_MS`, `OPENCODE_API_KEY` /
 *   `INPUT_OPENCODE_API_KEY` / `TYPESAFE_API_KEY` keep their Module 1
 *   meanings; the SDK translation of the model pin is documented on the
 *   stub, not implemented here.
 */

import {
  JEV_ENDPOINT,
  JEV_UNAVAILABLE_REASON,
  type JevCallOptions,
  type JevDiffRiskAssessment,
  type JevDiffRiskInput,
  type JevDiffRiskProvider,
  type JevPrefilterFinding,
  type JevRelevanceAssessment,
  type JevRelevanceProvider,
  type JevValidityAssessment,
  type JevValidityProvider,
  RestJevDiffRiskProvider,
  RestJevRelevanceProvider,
  RestJevValidityProvider,
} from './jev-client.js';
import { Logger } from './logger.js';

/** Env var selecting the Jev transport (`rest` default, `sdk` future). */
export const JEV_PROVIDER_ENV_VAR = 'JEV_PROVIDER';

/**
 * Native TypeSafe endpoint the future SDK transport must target (vs the REST
 * gateway `https://opencode.ai/zen/v1/systemone` used by `RestJevProvider`).
 */
export const JEV_SDK_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Transport selector for {@link createJevProvider} / {@link resolveJevProvider}. */
export type JevProviderKind = 'rest' | 'sdk';

/**
 * Implementing checklist for the future SDK-backed provider. Kept as an
 * exported constant (not just a comment) so tests pin the translation
 * contract without importing the SDK — do NOT add the `@typesafe-ai/sdk`
 * dependency until the real transport lands.
 */
export const SDK_JEV_PROVIDER_TODO = [
  'TODO(SDK): implement SdkJevProvider on the official @typesafe-ai/sdk.',
  `1. BaseURL override: point the SDK client at ${JEV_SDK_ENDPOINT}`,
  `   (native TypeSafe) instead of the REST Zen gateway ${JEV_ENDPOINT}.`,
  '2. No shape translation: the REST path already posts the native',
  '   { model, state, questions-map } shape with the documented criteria',
  '   shapes — reuse the shared builders and map answers back by question',
  '   id. The criteria shape stays untouched on the REST path — translate',
  '   only inside the SDK provider if the SDK needs it, never in shared builders.',
  '3. Model id: translate the JEV_MODEL pin (default jev-1.13-free, paid jev-1.13)',
  '   into the versioned SDK model id the native endpoint expects.',
  'Until then the stub below fails open (unavailable/unknown, no HTTP) so',
  'JEV_PROVIDER=sdk is safe but inert. Do NOT add the @typesafe-ai/sdk dependency',
  'until this stub is replaced with the real transport.',
].join('\n');

const moduleLogger = new Logger('jev-provider');

/**
 * Unified Jev transport: validity + relevance + diff-risk scoring behind one
 * interface so REST (current, default) and a future SDK-backed provider are
 * interchangeable. Structurally satisfies each per-concern provider, so a
 * unified instance drops into any existing Module 1-3 options bag
 * (`JevCallOptions.provider`, `RankContextOptions.provider`,
 * `DiffRiskGateOptions.provider`) with no call-site churn.
 */
export interface JevProvider
  extends JevValidityProvider,
    JevRelevanceProvider,
    JevDiffRiskProvider {
  /** Transport discriminator (`rest` real, `sdk` stub until implemented). */
  readonly kind: JevProviderKind;
}

/**
 * Optional collaborators for {@link RestJevProvider} (tests inject fakes;
 * production uses the shared REST transports).
 */
export interface RestJevProviderDeps {
  /** Validity transport override (defaults to `RestJevValidityProvider`). */
  validity?: JevValidityProvider;
  /** Relevance transport override (defaults to `RestJevRelevanceProvider`). */
  relevance?: JevRelevanceProvider;
  /** Diff-risk transport override (defaults to `RestJevDiffRiskProvider`). */
  risk?: JevDiffRiskProvider;
}

/**
 * Optional collaborators for {@link createJevProvider} /
 * {@link resolveJevProvider} (logger plus per-concern REST overrides).
 *
 * `logger` only applies to the SDK stub (`SdkJevProvider` constructor);
 * the REST path forwards only the per-concern overrides to
 * `RestJevProvider` — REST delegates resolve their logger per call from
 * `JevCallOptions.logger`, not from this field.
 */
export interface CreateJevProviderOptions extends RestJevProviderDeps {
  /**
   * Logger for the SDK stub only (defaults to a module logger). Ignored on
   * the REST path — pass `logger` per call via `JevCallOptions` instead.
   */
  logger?: Logger;
}

/**
 * Resolve the Jev transport from the environment. Only the literal `'sdk'`
 * (case-insensitive, trimmed) selects the SDK stub; anything else —
 * including unset, blank, or unrecognized — resolves to `'rest'` (fail-safe)
 * so existing deployments keep current behavior.
 *
 * @param env - Environment record (defaults to `process.env`).
 *   Non-string runtime values fail safe to `'rest'` (never throws).
 * @returns The selected transport kind (default `rest`).
 */
export function resolveJevProviderKind(
  env: Record<string, string | undefined> = process.env,
): JevProviderKind {
  const raw = String(env[JEV_PROVIDER_ENV_VAR] ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'sdk') return 'sdk';
  return 'rest';
}

/**
 * Throw an `AbortError` when the caller's signal already aborted. Shared by
 * the stub so cancellation rejects (never fail-open resolves), mirroring the
 * REST transports' fail-open-except-cancellation contract.
 *
 * @param signal - Optional caller signal to inspect.
 * @param message - Abort message for the thrown error.
 */
function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException(message, 'AbortError');
  }
}

/**
 * REST transport for all three Jev concerns — the default `JevProvider`.
 * Thin composition over the Module 1-3 `Rest*` providers: same Zen gateway
 * endpoint, same `{ model, state, questions-map }` + `criteria` wire shape,
 * same thresholds and fail-open policy. Zero new dependencies.
 */
export class RestJevProvider implements JevProvider {
  /** Transport discriminator (always `rest`). */
  readonly kind: JevProviderKind = 'rest';

  /** Validity transport delegate. */
  private readonly validity: JevValidityProvider;

  /** Relevance transport delegate. */
  private readonly relevance: JevRelevanceProvider;

  /** Diff-risk transport delegate. */
  private readonly risk: JevDiffRiskProvider;

  /**
   * Create a REST-backed unified provider.
   *
   * @param deps - Optional per-concern transport overrides (tests/fakes).
   */
  constructor(deps: RestJevProviderDeps = {}) {
    this.validity = deps.validity ?? new RestJevValidityProvider();
    this.relevance = deps.relevance ?? new RestJevRelevanceProvider();
    this.risk = deps.risk ?? new RestJevDiffRiskProvider();
  }

  /**
   * Score a batch of findings for validity via the REST transport, aligned
   * positionally to the input. Fail-open except caller cancellation.
   *
   * @param findings - Findings to score, in order.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns Assessments aligned to the input order.
   */
  scoreBatch(
    findings: JevPrefilterFinding[],
    options?: JevCallOptions,
  ): Promise<JevValidityAssessment[]> {
    return this.validity.scoreBatch(findings, options);
  }

  /**
   * Score context contents for relevance via the REST transport, aligned
   * positionally to the input. Fail-open except caller cancellation.
   *
   * @param contents - Context entry contents to score, in order.
   * @param query - Review-task query the relevance is judged against.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns Assessments aligned to the input order.
   */
  scoreRelevance(
    contents: string[],
    query: string,
    options?: JevCallOptions,
  ): Promise<JevRelevanceAssessment[]> {
    return this.relevance.scoreRelevance(contents, query, options);
  }

  /**
   * Assess PR diff risk via the REST transport. Fail-open except caller
   * cancellation.
   *
   * @param input - Diff stat, file paths, and PR description.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns The risk assessment (rejects only on caller cancellation).
   */
  assessRisk(input: JevDiffRiskInput, options?: JevCallOptions): Promise<JevDiffRiskAssessment> {
    return this.risk.assessRisk(input, options);
  }
}

/**
 * Future SDK-backed Jev transport — STUB ONLY (fails open, no HTTP, no SDK
 * dependency). Exists so callers can select `JEV_PROVIDER=sdk` and prove the
 * seam swaps without landing the real transport yet.
 *
 * TODO(SDK): replace each stub method with a real `@typesafe-ai/sdk` call:
 * 1. BaseURL override — target `https://api.typesafe.ai/v1/systemone`
 *    (see `JEV_SDK_ENDPOINT`), not the REST Zen gateway.
 * 2. No shape translation — the REST path already posts the native
 *    `{ model, state, questions-map }` shape with the documented `criteria`
 *    shapes; reuse the shared builders and map answers back by question id.
 *    Keep the `criteria` shape untouched on the REST path; translate only here
 *    if the SDK needs it.
 * 3. Model id — translate the `JEV_MODEL` pin (`jev-1.13-free` default,
 *    `jev-1.13` paid) into the versioned SDK model id. Do NOT add the
 *    `@typesafe-ai/sdk` dependency until this stub is replaced.
 */
export class SdkJevProvider implements JevProvider {
  /** Transport discriminator (always `sdk`). */
  readonly kind: JevProviderKind = 'sdk';

  /** Logger for stub diagnostics. */
  private readonly logger: Logger;

  /**
   * Create the SDK stub (no client constructed — the SDK is not a
   * dependency yet; see `SDK_JEV_PROVIDER_TODO`).
   *
   * @param logger - Logger for stub diagnostics (defaults to a module logger).
   */
  constructor(logger?: Logger) {
    this.logger = logger ?? moduleLogger;
  }

  /**
   * Stub validity scoring: fail-open `unavailable` per finding (no HTTP).
   * Rejects when the caller's signal aborted.
   *
   * TODO(SDK): post the shared validity batch ({ model, state,
   * questions-map } + `criteria`) via the SDK at
   * `https://api.typesafe.ai/v1/systemone` with the versioned
   * `JEV_MODEL` id, and map answers back by question id.
   *
   * @param findings - Findings to score, in order.
   * @param options - Call options (signal/logger overrides honored).
   * @returns Fail-open unavailable assessments aligned to the input order.
   */
  async scoreBatch(
    findings: JevPrefilterFinding[],
    options: JevCallOptions = {},
  ): Promise<JevValidityAssessment[]> {
    throwIfAborted(options.signal, 'Jev SDK validity scoring aborted');
    (options.logger ?? this.logger).warn(
      'Jev SDK provider not implemented (validity scoring fails open); see SDK_JEV_PROVIDER_TODO',
    );
    if (!Array.isArray(findings)) {
      (options.logger ?? this.logger).warn(
        'Jev SDK provider expected an array of findings (stub fails open with empty result)',
      );
      return [];
    }
    return findings.map(() => ({
      score: 0,
      confidence: 0,
      unavailable: true,
      reason: JEV_UNAVAILABLE_REASON,
    }));
  }

  /**
   * Stub relevance scoring: fail-open `unavailable` per entry (no HTTP).
   * Rejects when the caller's signal aborted.
   *
   * TODO(SDK): post the shared relevance batch ({ model, state,
   * questions-map } + `criteria`) via the SDK at
   * `https://api.typesafe.ai/v1/systemone` with the versioned
   * `JEV_MODEL` id, and map answers back by question id.
   *
   * @param contents - Context entry contents to score, in order.
   * @param query - Review-task query (unused by the stub).
   * @param options - Call options (signal/logger overrides honored).
   * @returns Fail-open unavailable assessments aligned to the input order.
   */
  async scoreRelevance(
    contents: string[],
    query: string,
    options: JevCallOptions = {},
  ): Promise<JevRelevanceAssessment[]> {
    void query;
    throwIfAborted(options.signal, 'Jev SDK relevance scoring aborted');
    (options.logger ?? this.logger).warn(
      'Jev SDK provider not implemented (relevance scoring fails open); see SDK_JEV_PROVIDER_TODO',
    );
    if (!Array.isArray(contents)) {
      (options.logger ?? this.logger).warn(
        'Jev SDK provider expected an array of contents (stub fails open with empty result)',
      );
      return [];
    }
    return contents.map(() => ({
      score: 0,
      confidence: 0,
      unavailable: true,
      reason: JEV_UNAVAILABLE_REASON,
    }));
  }

  /**
   * Stub diff-risk assessment: fail-open `unknown` (no HTTP). Rejects when
   * the caller's signal aborted.
   *
   * TODO(SDK): post the three diff-risk questions (two `noul` + one
   * `score`, { model, state, questions-map } + `criteria`) via the SDK at
   * `https://api.typesafe.ai/v1/systemone` with the versioned `JEV_MODEL`
   * id, and map answers back by question id.
   *
   * @param input - Diff stat, file paths, and PR description (unused by the stub).
   * @param options - Call options (signal/logger overrides honored).
   * @returns Fail-open unknown risk assessment.
   */
  async assessRisk(
    input: JevDiffRiskInput,
    options: JevCallOptions = {},
  ): Promise<JevDiffRiskAssessment> {
    void input;
    throwIfAborted(options.signal, 'Jev SDK diff-risk assessment aborted');
    (options.logger ?? this.logger).warn(
      'Jev SDK provider not implemented (diff-risk fails open); see SDK_JEV_PROVIDER_TODO',
    );
    return { level: 'unknown', reason: JEV_UNAVAILABLE_REASON, unavailable: true };
  }
}

/**
 * Shared REST provider used when callers do not select a transport.
 *
 * Always REST — unlike `resolveJevProvider()`, this constant never reads the
 * environment. The three delegates are side-effect-free objects (no I/O at
 * construction), so module-level construction is safe. Callers that need
 * environment selection should use `resolveJevProvider()` or
 * `createJevProvider()` instead.
 */
export const defaultJevProvider: JevProvider = new RestJevProvider();

/**
 * Create a Jev provider for an explicit transport kind. `rest` returns the
 * real REST transport; `sdk` returns the fail-open stub (see
 * `SDK_JEV_PROVIDER_TODO`) — never throws, never imports the SDK.
 *
 * `options.logger` only applies to the SDK stub; the REST path forwards
 * only the per-concern overrides (`validity`/`relevance`/`risk`) to
 * `RestJevProvider` — REST delegates resolve their logger per call from
 * `JevCallOptions.logger`.
 *
 * @param kind - Transport kind (defaults to `resolveJevProviderKind()`).
 * @param options - Logger (SDK stub only) plus per-concern REST overrides.
 * @returns The provider for the requested kind.
 */
export function createJevProvider(
  kind: JevProviderKind = resolveJevProviderKind(),
  options: CreateJevProviderOptions = {},
): JevProvider {
  if (kind === 'sdk') return new SdkJevProvider(options.logger);
  return new RestJevProvider(options);
}

/**
 * Resolve the active Jev provider from the environment (`JEV_PROVIDER`,
 * default `rest`). Zero behavior change on existing deployments: unset /
 * blank / unrecognized values yield the REST transport.
 *
 * @param env - Environment record (defaults to `process.env`).
 * @param options - Logger plus per-concern REST overrides.
 * @returns The selected provider (REST by default).
 */
export function resolveJevProvider(
  env: Record<string, string | undefined> = process.env,
  options: CreateJevProviderOptions = {},
): JevProvider {
  return createJevProvider(resolveJevProviderKind(env), options);
}
