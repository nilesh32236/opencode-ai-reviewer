/**
 * Jev (opencode.ai Zen SystemOne) client wrapper + verification pre-filter.
 *
 * Module 1 is an OPT-IN shadow pre-filter for the verification pass: when
 * `JEV_ENABLED=true`, finding-validity Score questions are issued to Jev
 * before the expensive verification LLM call so obvious false positives can
 * be dropped cheaply. When disabled (the default) every helper is a no-op
 * and the existing verification path runs 100% unchanged.
 *
 * API assumptions (verified against https://opencode.ai/docs/zen/ and
 * https://docs.typesafe.ai/api; a live call with the old shape returned
 * HTTP 422, the documented validation-failure status):
 * - `POST {JEV_ENDPOINT}` with `Authorization: Bearer <key>` and a JSON body
 *   of `{ model, state, questions }`, where `state` is the shared content
 *   under judgment and `questions` is a MAP keyed by caller-chosen id. Each
 *   map entry carries a `type` (`choice` | `score` | `noul`), an
 *   `instructions` string, and type-specific `criteria` (never `options`,
 *   never per-question `question`/`context`/`id` fields — those shapes 422).
 * - Criteria per the docs: `choice` criteria is a map of option label to
 *   rubric description (max 255 options); `score` criteria is an ordered
 *   array of level descriptions (2-10 levels); `noul` criteria is optional
 *   (`{ true, false }` descriptions). Score builders below always send
 *   exactly 2 levels so the returned score stays in 0..1 and the existing
 *   0.3/0.7 thresholds keep their meaning (a 3-level score would range
 *   0..2 — probability-weighted across level indices).
 * - Responses echo `response.model` and carry an `answers` MAP keyed by the
 *   same ids (`answers: { <id>: {...} }`); a legacy `results` array and
 *   id-less positional alignment are tolerated only as fallbacks (see
 *   `collectAnswers`/`alignAnswers`). Noul answers are numeric P(yes) in
 *   0..1 and carry NO `confidence` field — decisiveness is derived from
 *   distance-from-ambivalence (see `parseNoulAnswer`).
 * - Choice answers return `{ choice, probabilities, confidence }`, score
 *   answers return `{ score (0..1 with our 2-level rubrics), confidence }`.
 *   Parsing is defensive: unknown shapes degrade to "unavailable" instead
 *   of throwing.
 * - Contract reference: Zen SystemOne wire shape is
 *   `{ model, state, questions: { <id>: { type, instructions, criteria } } }`
 *   (see {JEV_ENDPOINT}). Deterministic 4xx are logged distinctly (see
 *   `logJevFailure`) so silent fail-open stays visible.
 *
 * External-sharing note: finding text sent to Jev leaves the repo boundary
 * (external API call). Question text is passed through `sanitizeString` to
 * redact secret-shaped material first, but finding messages may still contain
 * proprietary code context. Enabling `JEV_ENABLED=true` is therefore an
 * explicit opt-in to external sharing — follow up in action.yml/README docs
 * (workflows intentionally untouched by Module 1).
 *
 * Resilience contract (fail-open for genuine failures; caller cancellation
 * rejects so aborts propagate):
 * - Missing API key, timeout, 429/5xx, circuit-open, and parse errors all
 *   resolve to `{ verdict: 'review', reason: 'jev-unavailable' }` (or the
 *   typed-helper equivalent `undefined` / `unavailable: true`) so review
 *   traffic always falls through to the existing verification path.
 *
 * Environment:
 * - `JEV_ENABLED` — opt-in shadow mode; only the literal `'true'`
 *   (case-insensitive) enables Jev calls. Default: disabled.
 * - `JEV_MODEL` — model pin; defaults to `jev-1.13-free`. Set
 *   `JEV_MODEL=jev-1.13` for paid-threshold runs.
 * - `JEV_TIMEOUT_MS` — per-attempt HTTP timeout in ms. Default: 1500.
 * - `OPENCODE_API_KEY` (fallback `INPUT_OPENCODE_API_KEY`, then
 *   `TYPESAFE_API_KEY` for direct calls) — bearer token. Absent key =
 *   fail-open unavailable, no request is attempted.
 */

import { CircuitBreaker, countHttpError } from './circuit-breaker.js';
import { getErrorStatus } from './errors.js';
import { Logger } from './logger.js';
import { withRetryAndTimeout } from './retry.js';
import { sanitizeString } from './sanitize.js';

/** Jev SystemOne endpoint for question-answering calls. */
export const JEV_ENDPOINT = 'https://opencode.ai/zen/v1/systemone';

/** Default (free-tier) Jev model. Pin `JEV_MODEL=jev-1.13` for paid thresholds. */
export const JEV_DEFAULT_MODEL = 'jev-1.13-free';

/** Default per-attempt HTTP timeout (ms) — keeps the pre-filter cheap. */
export const JEV_DEFAULT_TIMEOUT_MS = 1500;

/**
 * Upper bound for the per-attempt Jev HTTP timeout (ms). `JEV_TIMEOUT_MS`
 * values above this are clamped so a misconfigured env var can never stall
 * the verification pass beyond ~10s per attempt.
 */
export const JEV_MAX_TIMEOUT_MS = 10_000;

/**
 * Maximum questions per Jev call. Larger finding lists are chunked into
 * sequential batches of this size (see `RestJevValidityProvider.scoreBatch`)
 * to bound payload size and keep per-call latency predictable.
 */
export const JEV_MAX_BATCH_QUESTIONS = 20;

/** Score above this (with sufficient confidence) maps to `block`. */
export const JEV_BLOCK_THRESHOLD = 0.7;

/** Score above this (with sufficient confidence) maps to `review`. */
export const JEV_REVIEW_THRESHOLD = 0.3;

/**
 * Minimum confidence required for a decisive verdict. Anything below this
 * degrades to `review` regardless of score — an uncertain model must never
 * block a finding nor silently allow it.
 */
export const JEV_CONFIDENCE_FLOOR = 0.8;

/** Fail-open reason marker used whenever Jev cannot produce an answer. */
export const JEV_UNAVAILABLE_REASON = 'jev-unavailable';

/**
 * Errors rethrown from Jev calls whose caller signal aborted mid-flight.
 * The shared breaker predicate cannot close over a single call's signal, so
 * the exact thrown object is tagged at the call site (race-free: identity is
 * per-call) and excluded from breaker counting there. Weak references: tags
 * vanish with the error itself, so no cleanup is needed.
 */
const callerCancelledErrors = new WeakSet<object>();

/**
 * Check whether a thrown value was tagged as caller-cancelled at the call
 * site (see `postJevCall`).
 *
 * @param err - The thrown value to inspect.
 * @returns True when the value was tagged as caller-cancelled.
 */
function isCallerCancelled(err: unknown): boolean {
  return typeof err === 'object' && err !== null && callerCancelledErrors.has(err);
}

/**
 * Check whether a thrown value signals caller cancellation (an `AbortError`
 * by name, regardless of prototype — Node fetch aborts, retry timeouts, and
 * explicit `signal.reason` throws surface across realms). Cancellation is
 * caller-initiated, never a Jev failure: it must reject (not fail-open
 * resolve) and must not count toward tripping the circuit breaker.
 *
 * @param err - The thrown value to inspect.
 * @returns True when the value is an `AbortError`.
 */
export function isJevCancelError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'AbortError';
  }
  return (err as { name?: unknown }).name === 'AbortError';
}

/** Tri-state verdict produced from a Jev score + confidence pair. */
export type JevVerdict = 'block' | 'review' | 'allow';

/**
 * Criteria for a Jev `choice` question: a map of option label to rubric
 * description (max 255 options per the API docs). Use `null` when an option
 * needs no extra detail.
 */
export type JevChoiceCriteria = Record<string, string | null>;

/**
 * Criteria for a Jev `score` question: an ordered array of level
 * descriptions (2-10 levels per the API docs). Score builders in this module
 * always send exactly 2 levels so the returned score stays in 0..1.
 */
export type JevScoreCriteria = string[];

/**
 * Criteria for a Jev `noul` question: optional descriptions of what a yes
 * (near 1) and a no (near 0) mean. Omit entirely when the instructions are
 * self-explanatory.
 */
export interface JevNoulCriteria {
  /** What a yes (value near 1) means. */
  true?: string;
  /** What a no (value near 0) means. */
  false?: string;
}

/**
 * A single choice candidate in the pre-migration `choice` question
 * `criteria` array shape.
 *
 * @deprecated Removed in the `{ model, state, questions-map }` wire-shape
 * migration: `JevChoiceInput.criteria` is now a `JevChoiceCriteria` option
 * map (`Record<string, string | null>`), not an array. Kept as a
 * backward-compatible alias so external importers of this experimental,
 * Jev-gated surface keep compiling; note also that `JevNoulResult.noul`
 * changed from a string label to numeric P(yes) in 0..1 (same name, new
 * shape — see `parseNoulAnswer`). Will be removed in a future release.
 */
export interface JevChoiceCriterion {
  /** Candidate label returned verbatim in `choice` when selected. */
  choice: string;
  /** Optional description helping the model discriminate candidates. */
  description?: string;
}

/**
 * A single scored dimension in the pre-migration `score` question
 * `criteria` array shape.
 *
 * @deprecated Removed in the `{ model, state, questions-map }` wire-shape
 * migration: `JevScoreInput.criteria` is now a `JevScoreCriteria` string
 * array of level descriptions (2-10 levels), not an array of objects. Kept
 * as a backward-compatible alias so external importers keep compiling. Will
 * be removed in a future release.
 */
export interface JevScoreCriterion {
  /** Dimension name (e.g. `validity`). */
  name: string;
  /** Optional description of what the dimension measures. */
  description?: string;
}

/**
 * A single candidate in the pre-migration `noul` question `criteria` array
 * shape.
 *
 * @deprecated Removed in the `{ model, state, questions-map }` wire-shape
 * migration: `JevNoulInput.criteria` is now an optional `JevNoulCriteria`
 * `{ true, false }` object (or omitted), not an array. Kept as a
 * backward-compatible alias so external importers keep compiling. Will be
 * removed in a future release.
 */
export interface JevNoulCriterion {
  /** Candidate label. */
  name: string;
  /** Optional description helping the model discriminate candidates. */
  description?: string;
}

/** Input for a Jev `choice` question. */
export interface JevChoiceInput {
  /**
   * Question text — sent as the entry's `instructions`. The shared content
   * under judgment goes in `context` (sent as top-level `state`).
   */
  question: string;
  /** Optional supporting context, sent as the request's top-level `state`. */
  context?: string;
  /** Option map — `criteria` shape (never `options`). */
  criteria: JevChoiceCriteria;
}

/** Input for a Jev `score` question. */
export interface JevScoreInput {
  /**
   * Question text — sent as the entry's `instructions`. The shared content
   * under judgment goes in `context` (sent as top-level `state`).
   */
  question: string;
  /** Optional supporting context, sent as the request's top-level `state`. */
  context?: string;
  /** Ordered level descriptions — `criteria` shape (2-10 levels). */
  criteria: JevScoreCriteria;
}

/** Input for a Jev `noul` question. */
export interface JevNoulInput {
  /**
   * Question text — sent as the entry's `instructions`. The shared content
   * under judgment goes in `context` (sent as top-level `state`).
   */
  question: string;
  /** Optional supporting context, sent as the request's top-level `state`. */
  context?: string;
  /** Optional yes/no descriptions — `criteria` shape (may be omitted). */
  criteria?: JevNoulCriteria;
}

/** Typed result of a `choice` question. */
export interface JevChoiceResult {
  /** Selected candidate label. */
  choice: string;
  /** Per-candidate probabilities (may be empty when the model omits them). */
  probabilities: Record<string, number>;
  /** Model-reported confidence in 0..1. */
  confidence: number;
  /** Model version echoed by the API (`response.model`). */
  model?: string;
}

/** Typed result of a `score` question. */
export interface JevScoreResult {
  /** Score in 0..1. */
  score: number;
  /** Model-reported confidence in 0..1. */
  confidence: number;
  /** Model version echoed by the API (`response.model`). */
  model?: string;
}

/** Typed result of a `noul` question. */
export interface JevNoulResult {
  /**
   * P(yes) in 0..1 (near 1 = yes, near 0 = no). Native noul answers are
   * numeric and carry no `confidence` field — see `parseNoulAnswer` for how
   * decisiveness is derived when the response omits it.
   *
   * BREAKING CHANGE (experimental Jev surface, default-off): this field was
   * previously a string label and is now numeric P(yes) in 0..1 under the
   * same field name. External importers will not get a compile error but
   * must treat the value as a number. Callers needing the old label should
   * derive it via `mapNoulToVerdict`-style thresholds instead.
   */
  noul: number;
  /** Model-reported confidence in 0..1 (derived when the response omits it). */
  confidence: number;
  /** Model version echoed by the API (`response.model`). */
  model?: string;
}

/** Fail-open outcome shared by the pre-filter path. */
export interface JevPrefilterOutcome {
  /** Verdict — always `review` when Jev is unavailable. */
  verdict: JevVerdict;
  /** Machine-readable reason (`jev-unavailable`, `jev-disabled`, ...). */
  reason: string;
}

/** Validity assessment for a single finding (never throws). */
export interface JevValidityAssessment {
  /** Validity score in 0..1 (low = likely false positive). */
  score: number;
  /** Model-reported confidence in 0..1. */
  confidence: number;
  /** Model version echoed by the API. */
  model?: string;
  /** True when Jev could not answer (fail-open); caller must keep the finding. */
  unavailable: boolean;
  /** Machine-readable reason. */
  reason: string;
}

/** Minimal finding shape the pre-filter needs (compatible with ReviewIssue). */
export interface JevPrefilterFinding {
  /** File path of the finding. */
  file: string;
  /** Line number of the finding. */
  line: number;
  /** Finding message. */
  message: string;
  /** Severity band, when known. */
  severity?: string;
}

/** Result of filtering a finding list through the Jev validity pre-filter. */
export interface JevPrefilterResult<TFinding extends JevPrefilterFinding> {
  /** Findings to keep (passed the filter or unscored due to fail-open). */
  kept: TFinding[];
  /** Findings dropped as obvious false positives (low validity, high confidence). */
  dropped: TFinding[];
  /** True when Jev was disabled/unavailable and `kept` equals the input. */
  skipped: boolean;
  /** Machine-readable reason (`ok`, `jev-disabled`, `jev-unavailable`). */
  reason: string;
  /** Model version echoed by the API, when a call succeeded. */
  model?: string;
}

/** Options accepted by the Jev helpers (fetch override is for tests). */
export interface JevCallOptions {
  /** Logger for shadow-mode diagnostics (defaults to a module logger). */
  logger?: Logger;
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout override (ms). */
  timeoutMs?: number;
  /** Model override (defaults to `JEV_MODEL` / free tier). */
  model?: string;
  /** Optional AbortSignal to cancel the Jev call mid-flight (e.g. review aborted). */
  signal?: AbortSignal;
  /**
   * Validity provider override (tests / future SDK plug-in). Defaults to the
   * shared REST provider; the engine never passes one today.
   */
  provider?: JevValidityProvider;
}

/**
 * Minimal seam for the keep-forever SDK plan: batch validity scoring behind
 * an interface so a future SDK transport plugs in without touching the
 * engine or the threshold/drop policy. REST (`RestJevValidityProvider`)
 * stays the only transport — zero new dependencies; `JEV_MODEL` pinning
 * (`jev-1.13-free` → `jev-1.13`) covers free/paid selection.
 */
export interface JevValidityProvider {
  /**
   * Score a batch of findings for validity, aligned positionally to the
   * input. Fail-open except caller cancellation: per-finding failures
   * degrade to `{ unavailable: true, reason: 'jev-unavailable' }` so
   * callers keep the finding, but an aborted signal rejects.
   *
   * @param findings - Findings to score, in order.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns Assessments aligned to the input order.
   */
  scoreBatch(
    findings: JevPrefilterFinding[],
    options?: JevCallOptions,
  ): Promise<JevValidityAssessment[]>;
}

/**
 * Relevance assessment for a single context entry (Module 2). Never throws
 * at the provider level: per-entry failures degrade to `unavailable`, and
 * the caller keeps the entry's existing order (fail open).
 */
export interface JevRelevanceAssessment {
  /** Relevance score in 0..1 (higher = more relevant to the review task). */
  score: number;
  /** Model-reported confidence in 0..1. */
  confidence: number;
  /** Model version echoed by the API. */
  model?: string;
  /** True when Jev could not score the entry (fail-open); keep existing order. */
  unavailable: boolean;
  /** Machine-readable reason. */
  reason: string;
}

/**
 * Batch relevance scoring behind an interface (Module 2), mirroring the
 * Module 1 validity seam so a future SDK transport plugs in without
 * touching callers or the fail-open policy. REST
 * (`RestJevRelevanceProvider`) stays the only transport — zero new
 * dependencies.
 */
export interface JevRelevanceProvider {
  /**
   * Score context contents for relevance to `query`, aligned positionally
   * to the input. Fail-open except caller cancellation: per-entry failures
   * degrade to `{ unavailable: true, reason: 'jev-unavailable' }` so
   * callers keep the existing order, but an aborted signal rejects.
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
  ): Promise<JevRelevanceAssessment[]>;
}

const moduleLogger = new Logger('jev-client');

/**
 * Shared circuit breaker for all Jev requests. Repeated API failures trip the
 * circuit so verification passes fail fast instead of burning timeout budget
 * on every finding. Deterministic 4xx (except 429) never trips the circuit.
 */
const jevCircuitBreaker = new CircuitBreaker({
  name: 'jev-client',
  failureThreshold: 5,
  cooldownMs: 30_000,
  // Caller cancellations are excluded: an aborted caller is not a Jev
  // failure, and a burst of review cancellations must never trip the breaker
  // for subsequent reviews — even when the abort reason is a custom Error
  // (tagged per-call via `callerCancelledErrors`, since the shared predicate
  // cannot close over a single call's signal). HTTP/transport failures
  // (including per-attempt TimeoutErrors and status-less network errors)
  // still count.
  shouldCountFailure: (err) =>
    !isJevCancelError(err) && !isCallerCancelled(err) && countHttpError(err),
});

/**
 * Reset the shared Jev circuit breaker. Intended for tests only — production
 * code must let the breaker trip and recover on its own cooldown.
 */
export function resetJevCircuitBreaker(): void {
  jevCircuitBreaker.reset();
}

/**
 * Check whether Jev shadow mode is enabled. Only the literal `'true'`
 * (case-insensitive, trimmed) opts in; anything else — including unset —
 * keeps Jev fully disabled.
 *
 * @param env - Environment record (defaults to `process.env`).
 * @returns True only when `JEV_ENABLED=true`.
 */
export function isJevEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.JEV_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Resolve the Jev model: explicit `JEV_MODEL` pin wins, otherwise the free
 * tier default. Blank values fall back to the default.
 *
 * @param env - Environment record (defaults to `process.env`).
 * @returns The model id to request.
 */
export function resolveJevModel(env: Record<string, string | undefined> = process.env): string {
  const pinned = (env.JEV_MODEL ?? '').trim();
  return pinned.length > 0 ? pinned : JEV_DEFAULT_MODEL;
}

/**
 * Resolve the per-attempt Jev HTTP timeout in ms. Non-finite / non-positive
 * values fall back to the default so a malformed env var can never disable
 * the timeout or hang the verification pass; values above
 * `JEV_MAX_TIMEOUT_MS` are clamped so a misconfigured override can never
 * stall the pass beyond ~10s per attempt.
 *
 * @param env - Environment record (defaults to `process.env`).
 * @returns Timeout in milliseconds (default 1500, max 10000).
 */
export function resolveJevTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const text = (env.JEV_TIMEOUT_MS ?? '').trim();
  if (text.length === 0) return JEV_DEFAULT_TIMEOUT_MS;
  const raw = Number(text);
  if (!Number.isInteger(raw) || raw <= 0) return JEV_DEFAULT_TIMEOUT_MS;
  return Math.min(raw, JEV_MAX_TIMEOUT_MS);
}

/**
 * Resolve the Jev bearer token. `OPENCODE_API_KEY` wins, then the Actions
 * input mirror `INPUT_OPENCODE_API_KEY`, then `TYPESAFE_API_KEY` for direct
 * (non-Actions) calls. Returns undefined when no key is configured — callers
 * must fail open without attempting a request.
 *
 * @param env - Environment record (defaults to `process.env`).
 * @returns The API key, or undefined when unconfigured.
 */
export function resolveJevApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const key =
    (env.OPENCODE_API_KEY ?? '').trim() ||
    (env.INPUT_OPENCODE_API_KEY ?? '').trim() ||
    (env.TYPESAFE_API_KEY ?? '').trim();
  return key.length > 0 ? key : undefined;
}

/**
 * Map a (score, confidence) pair to a tri-state verdict using dual
 * thresholds: score `> 0.7` → `block`, `> 0.3` → `review`, else `allow`.
 * Confidence below 0.8 always degrades to `review` — an uncertain model must
 * never decide on its own.
 *
 * @param score - Score in 0..1 (higher = stronger signal).
 * @param confidence - Model-reported confidence in 0..1.
 * @returns The mapped verdict.
 */
export function mapScoreToVerdict(score: number, confidence: number): JevVerdict {
  if (!Number.isFinite(score) || !Number.isFinite(confidence)) return 'review';
  if (confidence < JEV_CONFIDENCE_FLOOR) return 'review';
  if (score > JEV_BLOCK_THRESHOLD) return 'block';
  if (score > JEV_REVIEW_THRESHOLD) return 'review';
  return 'allow';
}

/**
 * Check whether a validity assessment marks a finding as an obvious false
 * positive: low validity score (`<= 0.3`, mirroring the review threshold)
 * reported with high confidence (`>= 0.8`). Only such findings may skip the
 * expensive verification LLM call; everything else proceeds unchanged.
 *
 * Safety invariant (false-drop guard): `critical` findings are NEVER
 * droppable, regardless of score/confidence — a wrong auto-drop on a
 * critical is costlier than any verification-LLM saving. The engine layer
 * re-enforces this (see `verifyReviewResult`), so both layers must agree.
 *
 * @param score - Validity score in 0..1 (low = likely false positive).
 * @param confidence - Model-reported confidence in 0..1.
 * @param severity - Finding severity band (critical always kept).
 * @returns True when the finding can be dropped without LLM verification.
 */
export function isObviousFalsePositive(
  score: number,
  confidence: number,
  severity?: string,
): boolean {
  if (!Number.isFinite(score) || !Number.isFinite(confidence)) return false;
  if ((severity ?? '').trim().toLowerCase() === 'critical') return false;
  return score <= JEV_REVIEW_THRESHOLD && confidence >= JEV_CONFIDENCE_FLOOR;
}

/**
 * Build the fail-open outcome used whenever Jev cannot produce an answer
 * (missing key, timeout, 429/5xx, circuit-open, parse error). Routing to
 * `review` preserves the existing verification path exactly.
 *
 * @param reason - Optional reason override (defaults to `jev-unavailable`).
 * @returns The fail-open outcome. Never throws.
 */
export function jevUnavailable(reason: string = JEV_UNAVAILABLE_REASON): JevPrefilterOutcome {
  return { verdict: 'review', reason };
}

/**
 * Wire shape of a single question inside the Jev request `questions` map.
 * The map KEY (not a field) is the caller-assigned id used to match answers
 * back to questions — entries carry no `id`, `question`, or `context`
 * fields; shared content lives in the top-level `state`.
 */
export interface JevRequestQuestion {
  /** Question kind. */
  type: 'choice' | 'score' | 'noul';
  /** Per-question text. */
  instructions: string;
  /**
   * Type-specific criteria: option map for `choice`, ordered level array
   * for `score`, optional `{ true, false }` descriptions for `noul`.
   */
  criteria?: JevChoiceCriteria | JevScoreCriteria | JevNoulCriteria;
}

/** Wire shape of the Jev request body. */
interface JevRequestBody {
  /** Model id (free default, pinnable via `JEV_MODEL`). */
  model: string;
  /** Shared content under judgment (finding list, query + excerpts, diff summary). */
  state: string;
  /** Questions to answer in one batched call, keyed by caller-chosen id. */
  questions: Record<string, JevRequestQuestion>;
}

/**
 * Type guard for plain records (parsed JSON bodies).
 *
 * @param value - Value to test.
 * @returns True when the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce an unknown value to a finite number, or undefined. String input
 * must be a clean numeric literal — strict `Number()` (not `parseFloat`,
 * which silently accepts trailing garbage like `'0.9xyz'` → `0.9`) so a
 * malformed model response fails open instead of shaping a decision.
 *
 * @param value - Candidate value.
 * @returns The finite number, or undefined.
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Coerce an unknown value to a non-empty string, or undefined.
 *
 * @param value - Candidate value.
 * @returns The trimmed string, or undefined.
 */
function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

/**
 * Parse a probabilities map, keeping only finite numerics in 0..1.
 * Out-of-range entries (negative, >1) indicate a malformed model response
 * and are dropped rather than normalized — fail-open hardening so a corrupt
 * payload can never shape a downstream decision.
 *
 * @param value - Candidate value.
 * @returns The cleaned map (possibly empty).
 */
function toProbabilityMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const num = toFiniteNumber(entry);
    if (num !== undefined && num >= 0 && num <= 1) out[key] = num;
  }
  return out;
}

/**
 * Check whether a record looks like a Jev answer object (carries a known
 * answer field). Used to distinguish an id-keyed answers map
 * (`{ <id>: { score, confidence } }`) from a SINGLE answer object with
 * nested records (`{ choice, probabilities: {...}, confidence }`).
 *
 * @param entry - Candidate answer record.
 * @returns True when the record carries a known answer field.
 */
function isAnswerLike(entry: Record<string, unknown>): boolean {
  return (
    'choice' in entry ||
    'score' in entry ||
    'noul' in entry ||
    'answer' in entry ||
    'value' in entry ||
    'validity' in entry ||
    'selected' in entry
  );
}

/**
 * Collect answers from a Jev response body into an id-keyed map plus an
 * ordered positional list. The documented shape is an `answers` MAP keyed by
 * the request's question ids (`answers: { <id>: {...} }`); a legacy
 * `results` envelope (map or array) is tolerated as a gap-fill only, and
 * `answers` always wins per id — merging both would misassign answers to
 * the wrong findings.
 *
 * @param body - Parsed JSON response body.
 * @returns Id-keyed answers plus the positional fallback list.
 */
function collectAnswers(body: unknown): {
  byId: Map<string, Record<string, unknown>>;
  positional: Record<string, unknown>[];
} {
  const byId = new Map<string, Record<string, unknown>>();
  let positional: Record<string, unknown>[] = [];
  if (!isRecord(body)) return { byId, positional };
  const answers = body.answers;
  const results = body.results;
  const harvestIds = (value: unknown): void => {
    if (isRecord(value)) {
      // Map envelope: the KEY is the question id. Only harvest entries that
      // look like answer records (carry a known answer field) so a SINGLE
      // answer object with nested records (e.g. a choice answer
      // `{ choice, probabilities: {...}, confidence }` nested under
      // `answers`) is not misclassified as an id-map — the nested
      // `probabilities` map would otherwise become a bogus id entry, flip
      // `alignAnswers` onto the map path, and drop the signal (fail-open).
      for (const [key, entry] of Object.entries(value)) {
        if (isRecord(entry) && isAnswerLike(entry) && !byId.has(key)) byId.set(key, entry);
      }
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (!isRecord(entry)) continue;
        const id = toNonEmptyString(entry.id);
        if (id !== undefined && !byId.has(id)) byId.set(id, entry);
      }
    }
  };
  // `answers` wins: `results` only fills ids `answers` did not carry.
  harvestIds(answers);
  harvestIds(results);
  const asList = (value: unknown): Record<string, unknown>[] | undefined =>
    Array.isArray(value) ? value.filter(isRecord) : undefined;
  const answersList = asList(answers);
  const resultsList = asList(results);
  if (answersList !== undefined && answersList.length > 0) {
    positional = answersList;
  } else if (resultsList !== undefined && resultsList.length > 0) {
    positional = resultsList;
  } else if (byId.size === 0) {
    // Single-answer envelope: when `answers` is itself one answer object
    // (e.g. `{ noul: 0.9 }` or a choice `{ choice, probabilities: {...},
    // confidence }`), prefer it over the whole body so the parse functions
    // read the answer instead of the envelope. `harvestIds` above only fills
    // `byId` for answer-like entries, so reaching here with `answers` as a
    // record means it is NOT an id-map — it is the single answer (fail-open
    // either way, but this preserves the signal).
    if (isRecord(answers)) {
      positional = [answers];
    } else {
      positional = [body];
    }
  }
  return { byId, positional };
}

/**
 * Match answers back to request question ids. Map lookup by id is the
 * primary path (the documented `answers`-map shape). Positional fallback
 * applies ONLY when the response carries no answer ids at all: when ids are
 * present but an answer is missing or reordered, the unmatched slot resolves
 * to undefined (fail-open unavailable) instead of misassigning a neighbor's
 * answer — a misassigned low-validity score could otherwise drop the wrong
 * finding.
 *
 * @param ids - Request question ids in sent order.
 * @param body - Parsed JSON response body.
 * @returns Answers aligned to the request order (possibly undefined slots).
 */
function alignAnswers(ids: string[], body: unknown): Array<Record<string, unknown> | undefined> {
  const { byId, positional } = collectAnswers(body);
  if (byId.size > 0) return ids.map((id) => byId.get(id));
  return ids.map((_, index) => positional[index]);
}

/**
 * Parse a `choice` answer record into a typed result. Confidence must be a
 * finite number in 0..1 (mirroring the score path) — missing or
 * out-of-range confidence resolves to undefined (fail-open) instead of
 * defaulting to 0.
 *
 * @param answer - Raw answer record (undefined when missing).
 * @param model - Model version echoed by the API.
 * @returns The typed result, or undefined when unparseable/out-of-range.
 */
function parseChoiceAnswer(
  answer: Record<string, unknown> | undefined,
  model: string | undefined,
): JevChoiceResult | undefined {
  if (!answer) return undefined;
  const choice =
    toNonEmptyString(answer.choice) ??
    toNonEmptyString(answer.answer) ??
    toNonEmptyString(answer.selected);
  if (choice === undefined) return undefined;
  const confidence = toFiniteNumber(answer.confidence);
  if (confidence === undefined || confidence < 0 || confidence > 1) return undefined;
  return {
    choice,
    probabilities: toProbabilityMap(answer.probabilities),
    confidence,
    model,
  };
}

/**
 * Parse a `score` answer record into a typed result. Accepts `score` as well
 * as common aliases (`validity`, `value`) so envelope drift degrades
 * gracefully instead of dropping the signal.
 *
 * Fail-open hardening: score and confidence must both be finite numbers in
 * 0..1. Out-of-range or missing values resolve to undefined (finding kept)
 * — never clamped or defaulted into a decisive drop. E.g. `score: -1,
 * confidence: 1` previously clamped to a 0-score drop; it now fails open.
 *
 * @param answer - Raw answer record (undefined when missing).
 * @param model - Model version echoed by the API.
 * @returns The typed result, or undefined when unparseable/out-of-range.
 */
function parseScoreAnswer(
  answer: Record<string, unknown> | undefined,
  model: string | undefined,
): JevScoreResult | undefined {
  if (!answer) return undefined;
  const score =
    toFiniteNumber(answer.score) ?? toFiniteNumber(answer.validity) ?? toFiniteNumber(answer.value);
  const confidence = toFiniteNumber(answer.confidence);
  if (score === undefined) return undefined;
  if (score < 0 || score > 1 || confidence === undefined || confidence < 0 || confidence > 1) {
    return undefined;
  }
  return { score, confidence, model };
}

/**
 * Parse a `noul` answer record into a typed result. Native noul answers are
 * numeric P(yes) in 0..1 and — unlike choice/score answers — carry NO
 * `confidence` field. When the response omits confidence, decisiveness is
 * derived as distance-from-ambivalence (`|noul * 2 - 1|`): a calibrated
 * P(yes) near 0.5 is maximally uncertain, so ambivalent values degrade to
 * low confidence and fail open through the existing confidence-floor gates
 * instead of driving a decision. An explicitly present but malformed
 * confidence still resolves to undefined (fail-open) — absent data uses the
 * documented shape, corrupt data never shapes a decision.
 *
 * The verdict is read from `noul` first, falling back to numeric
 * `answer`/`value` aliases (mirroring how `parseScoreAnswer` tolerates
 * `validity`/`value`) so envelope drift degrades gracefully instead of
 * dropping the signal. Non-numeric labels (e.g. `"yes"`) fail open via
 * `toFiniteNumber`.
 *
 * @param answer - Raw answer record (undefined when missing).
 * @param model - Model version echoed by the API.
 * @returns The typed result, or undefined when unparseable/out-of-range.
 */
function parseNoulAnswer(
  answer: Record<string, unknown> | undefined,
  model: string | undefined,
): JevNoulResult | undefined {
  if (!answer) return undefined;
  const noul =
    toFiniteNumber(answer.noul) ?? toFiniteNumber(answer.answer) ?? toFiniteNumber(answer.value);
  if (noul === undefined || noul < 0 || noul > 1) return undefined;
  const rawConfidence = toFiniteNumber(answer.confidence);
  if (rawConfidence !== undefined && (rawConfidence < 0 || rawConfidence > 1)) return undefined;
  return {
    noul,
    confidence: rawConfidence ?? Math.abs(noul * 2 - 1),
    model,
  };
}

/**
 * POST one Jev call — `{ model, state, questions }` with `questions` as an
 * id-keyed map — with retry + per-attempt timeout behind the shared circuit
 * breaker. Non-2xx responses throw a status-carrying error so retry only
 * fires on retryable codes (429/5xx); status-less failures (timeouts,
 * network) fail fast without retry.
 *
 * @param state - Shared content under judgment (top-level `state`).
 * @param questions - Questions map keyed by caller-chosen id (must be non-empty).
 * @param apiKey - Bearer token.
 * @param model - Model id to request.
 * @param timeoutMs - Per-attempt HTTP timeout in ms.
 * @param fetchImpl - Fetch implementation.
 * @param signal - Optional AbortSignal to cancel the call mid-flight.
 * @returns The parsed JSON response body.
 */
async function postJevCall(
  state: string,
  questions: Record<string, JevRequestQuestion>,
  apiKey: string,
  model: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  // Already-cancelled work skips the circuit breaker entirely: an abort is
  // caller-initiated, not a Jev failure, and must neither count toward
  // tripping the breaker (status-less errors count via countHttpError) nor
  // burn a retry attempt. Mid-flight aborts propagate as AbortError through
  // the callers' fail-open handlers.
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Jev request aborted', 'AbortError');
  }
  const body: JevRequestBody = { model, state, questions };
  return jevCircuitBreaker.call(async () => {
    try {
      return await withRetryAndTimeout(
        async (attemptSignal) => {
          const res = await fetchImpl(JEV_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: attemptSignal,
          });
          if (!res.ok) {
            const err = new Error(`Jev API ${res.status} ${res.statusText}`) as Error & {
              status: number;
              headers?: Headers;
            };
            err.status = res.status;
            err.headers = res.headers;
            throw err;
          }
          return res.json() as Promise<unknown>;
        },
        timeoutMs,
        {
          operationName: 'jev-systemone',
          // Single attempt: the pre-filter is a best-effort latency saver, so a
          // slow/rate-limited Jev must fail fast into the existing verification
          // path rather than burn retries. maxRetryAfterMs is clamped as well so
          // a future retry-policy change can never stall on a Retry-After hint.
          maxRetries: 1,
          baseDelayMs: 200,
          maxDelayMs: 1000,
          maxRetryAfterMs: 1000,
          retryableStatuses: [429, 500, 502, 503, 504],
          retryUnknownStatus: false,
          signal,
        },
      );
    } catch (err) {
      // Caller cancelled mid-flight: tag the exact thrown object so the
      // shared breaker predicate excludes it. The predicate cannot close
      // over this call's signal (the breaker is shared across calls), so
      // identity-tagging is the race-free equivalent — an aborted caller is
      // not a Jev failure, even when the abort reason is a custom Error
      // that countHttpError would otherwise count.
      if (signal?.aborted && typeof err === 'object' && err !== null) {
        callerCancelledErrors.add(err);
      }
      throw err;
    }
  });
}

/**
 * Resolve common call prerequisites (enabled flag, API key, model, timeout).
 * Returns undefined + logs the skip reason when Jev must not be called.
 *
 * @param options - Call options (logger/fetch/model/timeout overrides).
 * @returns Resolved call context, or undefined when the call must be skipped.
 */
function resolveCallContext(options: JevCallOptions = {}): JevCallContext | undefined {
  const logger = options.logger ?? moduleLogger;
  if (!isJevEnabled()) {
    logger.debug('Jev shadow call skipped: JEV_ENABLED!=true');
    return undefined;
  }
  const apiKey = resolveJevApiKey();
  if (apiKey === undefined) {
    logger.debug('Jev shadow call skipped: no API key (OPENCODE_API_KEY/TYPESAFE_API_KEY)');
    return undefined;
  }
  return {
    apiKey,
    model: options.model ?? resolveJevModel(),
    timeoutMs: options.timeoutMs ?? resolveJevTimeoutMs(),
    logger,
    fetchImpl: options.fetchImpl ?? fetch,
    signal: options.signal,
  };
}

/**
 * Resolved credentials + tuning for one Jev call sequence. Produced by
 * `resolveCallContext` (which already enforces the `JEV_ENABLED` gate and
 * the API-key requirement); threading it through keeps the shared chunk
 * core honest about its preconditions.
 */
export interface JevCallContext {
  /** Bearer token for the Jev endpoint. */
  apiKey: string;
  /** Model id to request. */
  model: string;
  /** Per-attempt HTTP timeout in ms. */
  timeoutMs: number;
  /** Logger for diagnostics. */
  logger: Logger;
  /** Fetch implementation. */
  fetchImpl: typeof fetch;
  /** Optional AbortSignal to cancel the Jev call mid-flight. */
  signal?: AbortSignal;
}

/**
 * Log the model version echoed by the Jev API for release traceability.
 *
 * @param logger - Logger for diagnostics.
 * @param model - Echoed model version (may be undefined).
 */
function logResponseModel(logger: Logger, model: string | undefined): void {
  logger.debug(`Jev response model: ${model ?? 'unknown'}`);
}

/**
 * Deterministic client-error statuses: the request (shape, auth, permission)
 * is wrong and retrying will never help. `countHttpError` already excludes
 * these from tripping the shared circuit breaker; they are logged distinctly
 * here so silent fail-open stays visible in CI logs.
 */
const JEV_DETERMINISTIC_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

/**
 * Log a Jev call failure with a distinct, actionable message for
 * deterministic 4xx (request-shape / key / permission issues) versus
 * transient/unavailable failures. Both paths fail open; only the message
 * differs.
 *
 * @param logger - Logger for diagnostics.
 * @param operation - Short operation label (e.g. `choice question`).
 * @param err - The thrown value.
 */
function logJevFailure(logger: Logger, operation: string, err: unknown): void {
  const status = getErrorStatus(err);
  const detail = err instanceof Error ? err.message : String(err);
  if (status !== undefined && JEV_DETERMINISTIC_STATUSES.has(status)) {
    logger.warn(
      `Jev ${operation} deterministic client error (HTTP ${status}) — likely request-shape or key/permission issue; failing open to existing verification path: ${detail}`,
    );
    return;
  }
  logger.warn(`Jev ${operation} failed (fail-open): ${detail}`);
}

/**
 * Maximum characters per finding summary in the validity chunk state.
 * Each sanitized summary is truncated to this cap (matching
 * `JEV_RANK_MAX_CONTENT_CHARS`) so one huge finding message — or a full
 * batch of them — cannot produce an unbounded POST body and burn the
 * per-attempt latency/timeout budget. Chunking via
 * `JEV_MAX_BATCH_QUESTIONS` bounds the overall state on top of this.
 */
const JEV_VALIDITY_MAX_SUMMARY_CHARS = 2000;

/**
 * Two-level validity rubric shared by the validity builders. Exactly two
 * levels keep the returned score in 0..1 (probability-weighted across level
 * indices 0..1) so the 0.3/0.7 thresholds keep their meaning — more levels
 * would widen the score range (e.g. 0..2 for three levels).
 */
const VALIDITY_SCORE_CRITERIA: JevScoreCriteria = [
  'False positive: the finding is not a genuine, actionable defect.',
  'Genuine defect: the finding is a genuine, actionable defect.',
];

/**
 * Build the per-question instructions for one validity Score question,
 * naming the finding's number in the chunk state (see
 * `buildValidityChunkState`). Question text is static — the finding content
 * lives in the shared `state`, not here.
 *
 * @param number - 1-based finding number within the chunk state.
 * @returns The instructions string for the question entry.
 */
function buildValidityInstructions(number: number): string {
  return (
    `Score the validity of finding #${number} in the state above: ` +
    'is it a genuine, actionable defect (score close to 1) or a false positive (score close to 0)?'
  );
}

/**
 * Build the shared chunk `state` for a validity batch: a numbered list of
 * finding summaries. Batching choice (b): N findings share ONE state per
 * call instead of one call per finding, keeping Jev traffic at one HTTP
 * call per chunk of `JEV_MAX_BATCH_QUESTIONS`.
 *
 * Each summary passes through `sanitizeString` first: finding messages
 * cross the repo boundary to an external API, so secret-shaped material is
 * redacted before send (see the external-sharing note in the module doc;
 * user-facing disclosure lives in the README Configuration Reference).
 *
 * Known limitation: only pattern-shaped secrets are redacted pre-send.
 * Running the entropy-based `detectSecrets` scan over every outbound payload
 * was evaluated and rejected — its findings discard raw values at the final
 * filter step, so re-deriving redaction spans for the request body cannot be
 * done safely in a small change. Treat `JEV_ENABLED=true` as sharing
 * finding summaries (file, line, message) with the Jev endpoint.
 *
 * Each sanitized summary is truncated to `JEV_VALIDITY_MAX_SUMMARY_CHARS`
 * (sanitize first, then truncate) so a single oversized finding message
 * cannot blow up the request payload.
 *
 * Numbering is chunk-relative by design: each call's state lists its own
 * findings as #1..#N and its instructions reference those numbers, so ids
 * only need uniqueness within the call. There is no global numbering.
 *
 * @param findings - Chunk findings, in order.
 * @returns The numbered state string for the chunk call.
 */
function buildValidityChunkState(findings: JevPrefilterFinding[]): string {
  return findings
    .map((finding, index) => {
      const summary = sanitizeString(
        `Finding in ${finding.file} line ${finding.line}: ${finding.message}`,
      ).slice(0, JEV_VALIDITY_MAX_SUMMARY_CHARS);
      return `${index + 1}. ${summary} (severity=${finding.severity ?? 'unknown'})`;
    })
    .join('\n');
}

/**
 * Build one chunk call (shared state + id-keyed score questions) for a
 * slice of findings. Numbering is chunk-relative: each call's state lists
 * its own findings as #1..#N and its instructions reference those numbers,
 * so ids only need uniqueness within the call.
 *
 * @param findings - Chunk findings, in order.
 * @returns The chunk state plus the questions map and its ids in order.
 */
function buildValidityChunk(findings: JevPrefilterFinding[]): {
  state: string;
  ids: string[];
  questions: Record<string, JevRequestQuestion>;
} {
  const state = buildValidityChunkState(findings);
  const ids: string[] = [];
  const questions: Record<string, JevRequestQuestion> = {};
  findings.forEach((_, index) => {
    const id = `validity-${index}`;
    ids.push(id);
    questions[id] = {
      type: 'score',
      instructions: buildValidityInstructions(index + 1),
      criteria: VALIDITY_SCORE_CRITERIA,
    };
  });
  return { state, ids, questions };
}

/**
 * Maximum context-entry characters sent to Jev per relevance question.
 * Entries are excerpts, not full dumps: this bounds request payload size
 * (entries can exceed 10k chars) while giving the ranker enough signal.
 */
export const JEV_RANK_MAX_CONTENT_CHARS = 2000;

/** Maximum review-task query characters sent alongside a relevance question. */
export const JEV_RANK_MAX_QUERY_CHARS = 500;

/**
 * Two-level relevance rubric shared by the relevance builders. Exactly two
 * levels keep the returned score in 0..1 (see `VALIDITY_SCORE_CRITERIA`).
 */
const RELEVANCE_SCORE_CRITERIA: JevScoreCriteria = [
  'Irrelevant: the excerpt has nothing to do with the review task.',
  'Highly relevant: the excerpt is directly useful for the review task.',
];

/**
 * Build the per-question instructions for one relevance Score question,
 * naming the excerpt's number in the chunk state (see
 * `buildRelevanceChunkState`).
 *
 * @param number - 1-based excerpt number within the chunk state.
 * @returns The instructions string for the question entry.
 */
function buildRelevanceInstructions(number: number): string {
  return (
    `How relevant is excerpt #${number} in the state above to the review task stated there? ` +
    '(score close to 1 = highly relevant, score close to 0 = irrelevant)'
  );
}

/**
 * Build the shared chunk `state` for a relevance batch: the review-task
 * query plus a numbered list of entry excerpts.
 *
 * Ordering matters: sanitize FIRST on the full content, then truncate to
 * the excerpt limits. Truncating first could cut a secret pattern at the
 * boundary so the redaction regex no longer matches and raw key fragments
 * leak into the request. A `[REDACTED]` marker split by truncation is inert
 * text and harmless.
 *
 * Both the entry excerpts and the query pass through `sanitizeString`
 * first: context content crosses the repo boundary to an external API, so
 * secret-shaped material is redacted before send (same known limitation as
 * the validity path — see `buildValidityChunkState`; user-facing disclosure
 * lives in the README Configuration Reference).
 *
 * @param contents - Chunk entry contents, in order.
 * @param query - Review-task query the relevance is judged against.
 * @returns The query-plus-excerpts state string for the chunk call.
 */
function buildRelevanceChunkState(contents: string[], query: string): string {
  const task = sanitizeString(query).slice(0, JEV_RANK_MAX_QUERY_CHARS);
  const excerpts = contents.map(
    (content, index) =>
      `${index + 1}. ${sanitizeString(content).slice(0, JEV_RANK_MAX_CONTENT_CHARS)}`,
  );
  return `Review task: "${task}"\n\nContext excerpts:\n${excerpts.join('\n')}`;
}

/**
 * Build one chunk call (shared state + id-keyed score questions) for a
 * slice of contents. Numbering is chunk-relative (see `buildValidityChunk`).
 *
 * @param contents - Chunk entry contents, in order.
 * @param query - Review-task query the relevance is judged against.
 * @returns The chunk state plus the questions map and its ids in order.
 */
function buildRelevanceChunk(
  contents: string[],
  query: string,
): { state: string; ids: string[]; questions: Record<string, JevRequestQuestion> } {
  const state = buildRelevanceChunkState(contents, query);
  const ids: string[] = [];
  const questions: Record<string, JevRequestQuestion> = {};
  contents.forEach((_, index) => {
    const id = `relevance-${index}`;
    ids.push(id);
    questions[id] = {
      type: 'score',
      instructions: buildRelevanceInstructions(index + 1),
      criteria: RELEVANCE_SCORE_CRITERIA,
    };
  });
  return { state, ids, questions };
}

/** One aligned slot from a chunked Score call: the parsed result (if usable) plus the chunk's echoed model. */
interface ChunkedScoreSlot {
  /** Parsed score result, or undefined when the slot is missing/unparseable/out-of-range. */
  parsed: JevScoreResult | undefined;
  /** Model version echoed by the chunk's response (undefined on chunk failure). */
  model: string | undefined;
}

/**
 * Maximum concurrent Jev chunk calls in flight. Bounds wall-clock latency
 * for large finding/context lists (previously sequential, so latency summed
 * across chunks) while keeping per-chunk fail-open semantics and the shared
 * circuit breaker intact.
 */
export const JEV_CHUNK_CONCURRENCY = 3;

/**
 * Shared chunked Score transport core for the validity (Module 1) and
 * relevance (Module 2) providers. Chunks of at most
 * `JEV_MAX_BATCH_QUESTIONS` questions per call (bounded payload) run with
 * bounded concurrency (up to `JEV_CHUNK_CONCURRENCY` in flight), per-chunk
 * fail-open (a chunk failure yields undefined slots for that chunk only),
 * first-chunk `response.model` logging. Strict `parseScoreAnswer` validation
 * applies — malformed slots degrade to undefined, never to a decision.
 *
 * @param chunks - Chunk calls (shared state + id-keyed questions each), in order.
 * @param ctx - Resolved call context (enabled gate + key already checked).
 * @param operation - Short label for failure logs (e.g. `validity batch`).
 * @param unit - Per-question noun for failure logs (e.g. `findings`).
 * @returns Slots aligned to the input order.
 */
async function scoreQuestionChunks(
  chunks: Array<{ state: string; ids: string[]; questions: Record<string, JevRequestQuestion> }>,
  ctx: JevCallContext,
  operation: string,
  unit: string,
): Promise<ChunkedScoreSlot[]> {
  if (chunks.length === 0) return [];
  const perChunk: ChunkedScoreSlot[][] = new Array(chunks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const chunkIndex = cursor++;
      if (chunkIndex >= chunks.length) return;
      const chunk = chunks[chunkIndex];
      try {
        const raw = (await postJevCall(
          chunk.state,
          chunk.questions,
          ctx.apiKey,
          ctx.model,
          ctx.timeoutMs,
          ctx.fetchImpl,
          ctx.signal,
        )) as Record<string, unknown>;
        const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
        const aligned = alignAnswers(chunk.ids, raw);
        perChunk[chunkIndex] = aligned.map((slot) => ({
          parsed: parseScoreAnswer(slot, model),
          model,
        }));
      } catch (err) {
        if (ctx.signal?.aborted) {
          // Caller cancellation is not a Jev failure: reject so the caller
          // observes cancellation instead of a fail-open resolve. The timeout
          // path (caller signal not aborted) still degrades per-chunk below.
          throw err;
        }
        logJevFailure(ctx.logger, `${operation} (${chunk.ids.length} ${unit})`, err);
        perChunk[chunkIndex] = chunk.ids.map(() => ({ parsed: undefined, model: undefined }));
      }
    }
  };
  const workerCount = Math.min(JEV_CHUNK_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  // First-chunk model logging stays deterministic regardless of completion
  // order: chunk 0's echoed model is logged once its (ordered) result lands.
  logResponseModel(ctx.logger, perChunk[0]?.[0]?.model);
  return perChunk.flat();
}

/**
 * Ask a Jev `choice` question. Fail-open: any transport/API/parse failure
 * logs a warning and resolves to undefined (caller keeps current behavior).
 * The question text becomes the entry's `instructions`; the optional context
 * becomes the request's top-level `state` (falling back to the question
 * itself when absent, since `state` is required). Both are sanitized
 * (`sanitizeString`) then truncated to `JEV_RANK_MAX_CONTENT_CHARS`, matching
 * the chunk builders; criteria is validated to 1-255 options before send.
 *
 * @param input - Question, optional context (state), and `criteria` option map.
 * @param options - Call options (logger/fetch/model/timeout overrides).
 * @returns The typed result, or undefined when Jev is unavailable.
 */
export async function askJevChoice(
  input: JevChoiceInput,
  options: JevCallOptions = {},
): Promise<JevChoiceResult | undefined> {
  // Whole body inside try: even malformed caller input (null criteria, null
  // input) fails open to undefined instead of throwing into the caller.
  try {
    const ctx = resolveCallContext(options);
    if (!ctx) return undefined;
    const criteria = input.criteria;
    if (
      !isRecord(criteria) ||
      Object.keys(criteria).length === 0 ||
      Object.keys(criteria).length > 255
    ) {
      (options.logger ?? moduleLogger).debug(
        'Jev choice question skipped: criteria must be a non-empty option map (1-255 options, fail-open)',
      );
      return undefined;
    }
    const id = 'choice-0';
    // Sanitize-before-truncate (chunk-builder convention): question/context
    // cross the repo boundary, so secret-shaped material is redacted on the
    // full text first, then bounded to the rank excerpt cap so one caller
    // context cannot become an unbounded single POST.
    const instructions = sanitizeString(
      typeof input.question === 'string' ? input.question : '',
    ).slice(0, JEV_RANK_MAX_CONTENT_CHARS);
    const rawState = input.context ?? input.question;
    const state = sanitizeString(typeof rawState === 'string' ? rawState : '').slice(
      0,
      JEV_RANK_MAX_CONTENT_CHARS,
    );
    const questions: Record<string, JevRequestQuestion> = {
      [id]: { type: 'choice', instructions, criteria },
    };
    const raw = (await postJevCall(
      state,
      questions,
      ctx.apiKey,
      ctx.model,
      ctx.timeoutMs,
      ctx.fetchImpl,
      ctx.signal,
    )) as Record<string, unknown>;
    const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
    logResponseModel(ctx.logger, model);
    return parseChoiceAnswer(alignAnswers([id], raw)[0], model);
  } catch (err) {
    logJevFailure(options.logger ?? moduleLogger, 'choice question', err);
    return undefined;
  }
}

/**
 * Ask a Jev `score` question. Fail-open: any transport/API/parse failure
 * logs a warning and resolves to undefined (caller keeps current behavior).
 * Question/context are sanitized then truncated to
 * `JEV_RANK_MAX_CONTENT_CHARS`; criteria is validated to 2-10 levels before
 * send (over-long arrays fail open with a skip log instead of a 422).
 *
 * @param input - Question, optional context (state), and `criteria` levels.
 * @param options - Call options (logger/fetch/model/timeout overrides).
 * @returns The typed result, or undefined when Jev is unavailable.
 */
export async function askJevScore(
  input: JevScoreInput,
  options: JevCallOptions = {},
): Promise<JevScoreResult | undefined> {
  // Whole body inside try: even malformed caller input fails open to
  // undefined instead of throwing into the caller.
  try {
    const ctx = resolveCallContext(options);
    if (!ctx) return undefined;
    const criteria = input.criteria;
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
      (options.logger ?? moduleLogger).debug(
        'Jev score question skipped: criteria must be an ordered array of 2-10 levels (fail-open)',
      );
      return undefined;
    }
    const id = 'score-0';
    // Sanitize-before-truncate (see askJevChoice): redact secret-shaped
    // material on the full text first, then bound to the rank excerpt cap.
    const instructions = sanitizeString(
      typeof input.question === 'string' ? input.question : '',
    ).slice(0, JEV_RANK_MAX_CONTENT_CHARS);
    const rawState = input.context ?? input.question;
    const state = sanitizeString(typeof rawState === 'string' ? rawState : '').slice(
      0,
      JEV_RANK_MAX_CONTENT_CHARS,
    );
    const questions: Record<string, JevRequestQuestion> = {
      [id]: { type: 'score', instructions, criteria },
    };
    const raw = (await postJevCall(
      state,
      questions,
      ctx.apiKey,
      ctx.model,
      ctx.timeoutMs,
      ctx.fetchImpl,
      ctx.signal,
    )) as Record<string, unknown>;
    const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
    logResponseModel(ctx.logger, model);
    return parseScoreAnswer(alignAnswers([id], raw)[0], model);
  } catch (err) {
    logJevFailure(options.logger ?? moduleLogger, 'score question', err);
    return undefined;
  }
}

/**
 * Ask a Jev `noul` question. Fail-open: any transport/API/parse failure
 * logs a warning and resolves to undefined (caller keeps current behavior).
 * Question/context are sanitized then truncated to
 * `JEV_RANK_MAX_CONTENT_CHARS`, matching the choice/score helpers.
 *
 * @param input - Question, optional context (state), and optional `criteria`.
 * @param options - Call options (logger/fetch/model/timeout overrides).
 * @returns The typed result, or undefined when Jev is unavailable.
 */
export async function askJevNoul(
  input: JevNoulInput,
  options: JevCallOptions = {},
): Promise<JevNoulResult | undefined> {
  // Whole body inside try: even malformed caller input fails open to
  // undefined instead of throwing into the caller.
  try {
    const ctx = resolveCallContext(options);
    if (!ctx) return undefined;
    const entry: JevRequestQuestion = { type: 'noul', instructions: input.question };
    // Noul criteria is optional: garbage is omitted (fail-open), never sent.
    // Non-string true/false descriptions are dropped (a 422-shaped payload
    // must fail open before send, like the choice/score paths validate
    // shape); when neither survives, criteria is omitted entirely.
    if (input.criteria !== undefined) {
      if (!isRecord(input.criteria)) {
        (options.logger ?? moduleLogger).debug(
          'Jev noul question: ignoring malformed criteria (fail-open)',
        );
      } else {
        const cleaned: JevNoulCriteria = {};
        const rawTrue = input.criteria.true;
        const rawFalse = input.criteria.false;
        if (typeof rawTrue === 'string' && rawTrue.trim().length > 0) cleaned.true = rawTrue.trim();
        else if (rawTrue !== undefined) {
          (options.logger ?? moduleLogger).debug(
            'Jev noul question: ignoring non-string criteria.true (fail-open)',
          );
        }
        if (typeof rawFalse === 'string' && rawFalse.trim().length > 0)
          cleaned.false = rawFalse.trim();
        else if (rawFalse !== undefined) {
          (options.logger ?? moduleLogger).debug(
            'Jev noul question: ignoring non-string criteria.false (fail-open)',
          );
        }
        if (cleaned.true !== undefined || cleaned.false !== undefined) {
          entry.criteria = cleaned;
        }
      }
    }
    const id = 'noul-0';
    // Sanitize-before-truncate (see askJevChoice): redact secret-shaped
    // material on the full text first, then bound to the rank excerpt cap.
    const instructions = sanitizeString(
      typeof input.question === 'string' ? input.question : '',
    ).slice(0, JEV_RANK_MAX_CONTENT_CHARS);
    const rawState = input.context ?? input.question;
    const state = sanitizeString(typeof rawState === 'string' ? rawState : '').slice(
      0,
      JEV_RANK_MAX_CONTENT_CHARS,
    );
    const raw = (await postJevCall(
      state,
      { [id]: { ...entry, instructions } },
      ctx.apiKey,
      ctx.model,
      ctx.timeoutMs,
      ctx.fetchImpl,
      ctx.signal,
    )) as Record<string, unknown>;
    const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
    logResponseModel(ctx.logger, model);
    return parseNoulAnswer(alignAnswers([id], raw)[0], model);
  } catch (err) {
    logJevFailure(options.logger ?? moduleLogger, 'noul question', err);
    return undefined;
  }
}

/**
 * Score the validity of a single finding via a Jev `score` question. Never
 * throws: unavailable Jev resolves to `{ unavailable: true,
 * reason: 'jev-unavailable' }` and the caller must keep the finding (fail
 * open to the existing verification path).
 *
 * @param finding - Finding to assess.
 * @param options - Call options (logger/fetch/model/timeout overrides).
 * @returns The validity assessment (low score = likely false positive).
 */
export async function scoreFindingValidity(
  finding: JevPrefilterFinding,
  options: JevCallOptions = {},
): Promise<JevValidityAssessment> {
  // Whole body inside try: even a malformed finding (null entry) resolves to
  // unavailable instead of throwing into the caller.
  try {
    const state = buildValidityChunkState([finding]);
    const result = await askJevScore(
      {
        question: buildValidityInstructions(1),
        context: state,
        criteria: VALIDITY_SCORE_CRITERIA,
      },
      options,
    );
    if (!result) {
      return { score: 0, confidence: 0, unavailable: true, reason: JEV_UNAVAILABLE_REASON };
    }
    return {
      score: result.score,
      confidence: result.confidence,
      model: result.model,
      unavailable: false,
      reason: 'ok',
    };
  } catch (err) {
    logJevFailure(options.logger ?? moduleLogger, 'validity scoring', err);
    return { score: 0, confidence: 0, unavailable: true, reason: JEV_UNAVAILABLE_REASON };
  }
}

/**
 * REST transport for Jev validity scoring — the current `JevValidityProvider`
 * implementation. Future SDK transports implement the same interface without
 * touching the engine or the threshold/drop policy.
 *
 * Batching: findings are scored in sequential chunks of at most
 * `JEV_MAX_BATCH_QUESTIONS` questions per call. Sequential (not parallel)
 * keeps worst-case added latency predictable — one batch is one HTTP attempt
 * (`maxRetries: 1`, `JEV_TIMEOUT_MS` per attempt) — and typical verification
 * lists fit a single batch. Per-chunk fail-open: a chunk failure keeps that
 * chunk's findings and continues with the next chunk.
 */
export class RestJevValidityProvider implements JevValidityProvider {
  /**
   * Score a batch of findings via chunked Jev Score calls. Fail-open except
   * caller cancellation: chunk failures degrade to per-finding `unavailable`
   * assessments, but an aborted signal rejects.
   *
   * @param findings - Findings to score, in order.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns Assessments aligned to the input order.
   */
  async scoreBatch(
    findings: JevPrefilterFinding[],
    options: JevCallOptions = {},
  ): Promise<JevValidityAssessment[]> {
    if (!Array.isArray(findings)) return [];
    const ctx = resolveCallContext(options);
    if (!ctx) {
      return findings.map(() => ({
        score: 0,
        confidence: 0,
        unavailable: true,
        reason: JEV_UNAVAILABLE_REASON,
      }));
    }
    const chunks: Array<{
      state: string;
      ids: string[];
      questions: Record<string, JevRequestQuestion>;
    }> = [];
    for (let start = 0; start < findings.length; start += JEV_MAX_BATCH_QUESTIONS) {
      chunks.push(buildValidityChunk(findings.slice(start, start + JEV_MAX_BATCH_QUESTIONS)));
    }
    const slots = await scoreQuestionChunks(chunks, ctx, 'validity batch', 'findings');
    return slots.map((slot) =>
      slot.parsed
        ? {
            score: slot.parsed.score,
            confidence: slot.parsed.confidence,
            model: slot.parsed.model,
            unavailable: false,
            reason: 'ok',
          }
        : {
            score: 0,
            confidence: 0,
            model: slot.model,
            unavailable: true,
            reason: JEV_UNAVAILABLE_REASON,
          },
    );
  }
}

/**
 * REST transport for Jev relevance scoring (Module 2) — the current
 * `JevRelevanceProvider` implementation. Shares the chunked Score transport
 * core, timeouts, circuit breaker, and strict parsing with the Module 1
 * validity provider; only the question wording differs.
 */
export class RestJevRelevanceProvider implements JevRelevanceProvider {
  /**
   * Score context contents for relevance via chunked Jev Score calls. Fail-open
   * except caller cancellation: chunk failures degrade to per-entry
   * `unavailable` assessments, but an aborted signal rejects.
   *
   * @param contents - Context entry contents to score, in order.
   * @param query - Review-task query the relevance is judged against.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns Assessments aligned to the input order.
   */
  async scoreRelevance(
    contents: string[],
    query: string,
    options: JevCallOptions = {},
  ): Promise<JevRelevanceAssessment[]> {
    const logger = options.logger ?? moduleLogger;
    if (!Array.isArray(contents)) return [];
    const ctx = resolveCallContext(options);
    if (!ctx) {
      return contents.map(() => ({
        score: 0,
        confidence: 0,
        unavailable: true,
        reason: JEV_UNAVAILABLE_REASON,
      }));
    }
    const safeContents = contents.map((content) => (typeof content === 'string' ? content : ''));
    const safeQuery = typeof query === 'string' ? query : '';
    const chunks: Array<{
      state: string;
      ids: string[];
      questions: Record<string, JevRequestQuestion>;
    }> = [];
    for (let start = 0; start < safeContents.length; start += JEV_MAX_BATCH_QUESTIONS) {
      chunks.push(
        buildRelevanceChunk(safeContents.slice(start, start + JEV_MAX_BATCH_QUESTIONS), safeQuery),
      );
    }
    const slots = await scoreQuestionChunks(chunks, ctx, 'relevance batch', 'entries');
    logger.debug(`Jev relevance batch scored ${contents.length} entries`);
    return slots.map((slot) =>
      slot.parsed
        ? {
            score: slot.parsed.score,
            confidence: slot.parsed.confidence,
            model: slot.parsed.model,
            unavailable: false,
            reason: 'ok',
          }
        : {
            score: 0,
            confidence: 0,
            model: slot.model,
            unavailable: true,
            reason: JEV_UNAVAILABLE_REASON,
          },
    );
  }
}

/** Shared REST provider used when callers do not inject their own. */
const defaultRestProvider = new RestJevValidityProvider();

/** Maximum characters for the diff stat line sent in a diff-risk batch context. */
export const JEV_RISK_MAX_STAT_CHARS = 500;

/**
 * Maximum PR description (title + body) characters sent to Jev with a
 * diff-risk batch (Module 3). The description is sanitized FIRST on the full
 * text, then truncated — truncating first could cut a secret pattern at the
 * boundary so the redaction regex no longer matches (see
 * `buildRelevanceChunkState` for the same ordering rule).
 */
export const JEV_RISK_MAX_DESC_CHARS = 2000;

/**
 * Maximum file paths listed in a diff-risk batch context (Module 3). Paths
 * beyond the cap are dropped from the context (the stat line still counts
 * every file) so one PR costs exactly one Jev batch — no per-file fan-out.
 */
export const JEV_RISK_MAX_FILES = 50;

/** Maximum characters per file path sent in a diff-risk batch context. */
export const JEV_RISK_MAX_PATH_CHARS = 300;

/**
 * Maximum characters for the assembled diff-risk context string shared by
 * the batch's questions. Applied after sanitize + per-part truncation as a
 * final payload bound (a `[REDACTED]` marker split by truncation is inert
 * text and harmless).
 */
export const JEV_RISK_MAX_CONTEXT_CHARS = 6000;

/**
 * Blast-radius score strictly above this (with sufficient confidence) maps
 * to `high` diff risk. Dedicated to the Module 3 diff-risk gate:
 * intentionally decoupled from `JEV_BLOCK_THRESHOLD` (Module 1
 * finding-validity mapping) so tuning validity thresholds can never
 * silently retune risk escalation. Initial default matches the validity
 * block threshold numerically, but the two bindings evolve independently.
 */
export const JEV_RISK_HIGH_THRESHOLD = 0.7;

/**
 * Blast-radius score at or below this (with sufficient confidence, and all
 * sibling signals confidently negative) maps to `low` diff risk. Dedicated
 * to the Module 3 diff-risk gate: intentionally decoupled from
 * `JEV_REVIEW_THRESHOLD` (Module 1 finding-validity mapping) so tuning
 * validity thresholds can never silently retune risk escalation. Initial
 * default matches the validity review threshold numerically, but the two
 * bindings evolve independently.
 */
export const JEV_RISK_LOW_THRESHOLD = 0.3;

/** Diff-risk level produced from a Jev risk batch (Module 3). */
export type JevDiffRiskLevel = 'high' | 'low' | 'unknown';

/** Structured input for a Jev diff-risk assessment (Module 3). */
export interface JevDiffRiskInput {
  /** One-line diff stat (e.g. `5 files changed, ~150 diff lines`). */
  statLine: string;
  /** Repo-relative changed-file paths (capped to `JEV_RISK_MAX_FILES`). */
  filePaths: string[];
  /** PR title + body (sanitized then truncated to `JEV_RISK_MAX_DESC_CHARS`). */
  description: string;
}

/** Outcome of a Jev diff-risk assessment (Module 3). Never throws. */
export interface JevDiffRiskAssessment {
  /** Risk level (`unknown` whenever Jev could not answer — fail-open). */
  level: JevDiffRiskLevel;
  /** Machine-readable reason (`ok`, `jev-unavailable`, ...). */
  reason: string;
  /** Model version echoed by the API, when a call succeeded. */
  model?: string;
  /** True when Jev could not answer; the caller must keep deterministic behavior. */
  unavailable: boolean;
}

/**
 * Minimal seam for the diff-risk gate: risk assessment behind an interface
 * so a future SDK transport plugs in without touching the gate or the
 * escalation-only policy. REST (`RestJevDiffRiskProvider`) stays the only
 * transport — zero new dependencies.
 */
export interface JevDiffRiskProvider {
  /**
   * Assess PR diff risk in a single Jev batch (two `noul` + one `score`
   * question, one HTTP call). Fail-open except caller cancellation: any
   * transport/API/parse failure degrades to `{ level: 'unknown',
   * unavailable: true }`, but an aborted signal rejects.
   *
   * @param input - Diff stat, file paths, and PR description.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns The risk assessment (never throws except on caller cancellation).
   */
  assessRisk(input: JevDiffRiskInput, options?: JevCallOptions): Promise<JevDiffRiskAssessment>;
}

/**
 * Two-level blast-radius rubric. Exactly two levels keep the returned score
 * in 0..1 (see `VALIDITY_SCORE_CRITERIA`).
 */
const BLAST_RADIUS_SCORE_CRITERIA: JevScoreCriteria = [
  'Tiny isolated change with a narrow, non-critical surface.',
  'Broad or critical affected surface.',
];

/**
 * Build the single diff-risk call: the assembled PR summary as the shared
 * `state` plus the three questions as an id-keyed map (two `noul` + one
 * `score`). The context is assembled from already-sanitized parts by the
 * caller (`buildDiffRiskContext` sanitizes FIRST, then truncates).
 *
 * @param context - Assembled PR context (stat + file list + description).
 * @returns The call state plus the questions map and its ids in order.
 */
function buildDiffRiskCall(context: string): {
  state: string;
  ids: string[];
  questions: Record<string, JevRequestQuestion>;
} {
  const ids = ['risk-auth-migration-secrets', 'risk-destructive-migration', 'risk-blast-radius'];
  const questions: Record<string, JevRequestQuestion> = {
    'risk-auth-migration-secrets': {
      type: 'noul',
      instructions:
        'Does this pull request touch authentication/authorization logic, database migrations, or secrets/credentials handling?',
      criteria: {
        true: 'The PR touches auth/authz logic, database migrations, or secrets/credentials handling.',
        false: 'The PR touches none of these areas.',
      },
    },
    'risk-destructive-migration': {
      type: 'noul',
      instructions:
        'Does this pull request include a destructive or irreversible data change (dropped tables/columns, deleted production data, irreversible migration)?',
      criteria: {
        true: 'The PR includes a destructive or irreversible data change.',
        false: 'The PR includes no destructive or irreversible data change.',
      },
    },
    'risk-blast-radius': {
      type: 'score',
      instructions:
        'What is the blast radius of this pull request (how broad and critical is the affected surface)?',
      criteria: BLAST_RADIUS_SCORE_CRITERIA,
    },
  };
  return { state: context, ids, questions };
}

/**
 * Assemble the shared diff-risk context string from raw PR parts.
 * Sanitize-before-truncate (Module 1/2 convention): every part passes
 * through `sanitizeString` on its FULL text first so secret-shaped material
 * is redacted before any truncation boundary can split a pattern, then each
 * part is truncated to its cap. File paths beyond `JEV_RISK_MAX_FILES` are
 * dropped from the listing (the stat line still counts every file).
 *
 * Known limitation: only pattern-based `sanitizeString` redaction applies
 * pre-send (same as the Module 1/2 builders — see `buildValidityChunkState`).
 * PEM keys and high-entropy tokens that match no pattern are NOT redacted,
 * so treat `JEV_ENABLED=true` as sharing PR diff summaries (stat, file
 * list, description) with the Jev endpoint; user-facing disclosure lives in
 * the README Configuration Reference.
 *
 * @param input - Raw diff stat, file paths, and PR description.
 * @returns The assembled context string, bounded to `JEV_RISK_MAX_CONTEXT_CHARS`.
 */
export function buildDiffRiskContext(input: JevDiffRiskInput): string {
  const stat = sanitizeString(typeof input.statLine === 'string' ? input.statLine : '').slice(
    0,
    JEV_RISK_MAX_STAT_CHARS,
  );
  const rawPaths = Array.isArray(input.filePaths) ? input.filePaths : [];
  const validPaths = rawPaths.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  const paths = validPaths
    .slice(0, JEV_RISK_MAX_FILES)
    .map((entry) => sanitizeString(entry).slice(0, JEV_RISK_MAX_PATH_CHARS));
  // The dropped count derives from the valid-entry list: junk entries
  // (non-strings, empties) are filtered above, so they must not inflate the
  // "+N more" tail.
  const dropped = validPaths.length - paths.length;
  const fileList =
    paths.length > 0
      ? paths.join(', ') + (dropped > 0 ? `, ... (+${dropped} more)` : '')
      : '(no files listed)';
  const description = sanitizeString(
    typeof input.description === 'string' ? input.description : '',
  ).slice(0, JEV_RISK_MAX_DESC_CHARS);
  const assembled = `PR diff: ${stat}. Files (${validPaths.length}): ${fileList}. Description: ${description}`;
  return assembled.slice(0, JEV_RISK_MAX_CONTEXT_CHARS);
}

/**
 * Map diff-risk signals to a risk level. Asymmetric by design
 * (escalation-only): a single confident positive (auth/migration/secrets
 * touch, destructive migration, or high blast-radius score) yields `high`
 * even when sibling answers are missing — a critical-risk signal must never
 * be suppressed by a gaps elsewhere. `low` requires ALL THREE signals
 * present, confident (at or above `JEV_CONFIDENCE_FLOOR`, the Module 1
 * floor), and negative; anything else — including any unavailable signal or
 * any low-confidence answer — yields `unknown` (fail-open).
 *
 * Noul signals are numeric P(yes): yes means confidently above the high
 * binding, no means confidently at/below the low binding. The noul verdicts
 * share the Module 3 dedicated risk bindings (decoupled from the Module 1
 * validity thresholds, like the blast-radius score does).
 *
 * Effective-threshold note: native noul answers carry no `confidence` field,
 * so confidence is derived as distance-from-ambivalence (`|noul * 2 - 1|`,
 * see `parseNoulAnswer`). Combined with `JEV_CONFIDENCE_FLOOR=0.8`, the
 * documented 0.7/0.3 bindings are effectively ~0.9/0.1 for server answers
 * without explicit confidence — e.g. noul=0.75 derives confidence 0.5 < 0.8
 * and degrades to `unknown` (fail-open). Only explicit-confidence answers
 * (or extreme P(yes) values) can drive `high`/`low` at the nominal 0.7/0.3
 * lines. This is intentional: ambivalent P(yes) must never escalate risk.
 *
 * @param authTouch - Parsed `risk-auth-migration-secrets` noul answer (undefined when missing/unparseable).
 * @param destructive - Parsed `destructive-migration` noul answer (undefined when missing/unparseable).
 * @param blastRadius - Parsed `blast-radius` score answer (undefined when missing/unparseable/out-of-range).
 * @returns The mapped risk level.
 */
export function mapDiffRiskSignalsToLevel(
  authTouch: JevNoulResult | undefined,
  destructive: JevNoulResult | undefined,
  blastRadius: JevScoreResult | undefined,
): JevDiffRiskLevel {
  const isYes = (answer: JevNoulResult | undefined): boolean =>
    answer !== undefined &&
    answer.confidence >= JEV_CONFIDENCE_FLOOR &&
    answer.noul > JEV_RISK_HIGH_THRESHOLD;
  const isNo = (answer: JevNoulResult | undefined): boolean =>
    answer !== undefined &&
    answer.confidence >= JEV_CONFIDENCE_FLOOR &&
    answer.noul <= JEV_RISK_LOW_THRESHOLD;
  if (isYes(authTouch) || isYes(destructive)) return 'high';
  if (
    blastRadius !== undefined &&
    blastRadius.confidence >= JEV_CONFIDENCE_FLOOR &&
    blastRadius.score > JEV_RISK_HIGH_THRESHOLD
  ) {
    return 'high';
  }
  if (
    isNo(authTouch) &&
    isNo(destructive) &&
    blastRadius !== undefined &&
    blastRadius.confidence >= JEV_CONFIDENCE_FLOOR &&
    blastRadius.score <= JEV_RISK_LOW_THRESHOLD
  ) {
    return 'low';
  }
  return 'unknown';
}

/**
 * REST transport for Jev diff-risk assessment (Module 3) — the current
 * `JevDiffRiskProvider` implementation. One Jev batch per PR (two `noul` +
 * one `score` question in a single `postJevCall` call), reusing Module
 * 1's timeouts, circuit breaker, strict parsing, and AbortSignal conventions.
 */
export class RestJevDiffRiskProvider implements JevDiffRiskProvider {
  /**
   * Assess PR diff risk via a single Jev batch. Fail-open except caller
   * cancellation: transport/API/parse failures degrade to `{ level:
   * 'unknown', unavailable: true }`, but an aborted signal rejects.
   *
   * @param input - Diff stat, file paths, and PR description.
   * @param options - Call options (logger/fetch/model/timeout overrides).
   * @returns The risk assessment. Rejects only on caller cancellation.
   */
  async assessRisk(
    input: JevDiffRiskInput,
    options: JevCallOptions = {},
  ): Promise<JevDiffRiskAssessment> {
    const logger = options.logger ?? moduleLogger;
    try {
      const ctx = resolveCallContext(options);
      if (!ctx) {
        return { level: 'unknown', reason: JEV_UNAVAILABLE_REASON, unavailable: true };
      }
      const safeInput: JevDiffRiskInput = {
        statLine: typeof input?.statLine === 'string' ? input.statLine : '',
        filePaths: Array.isArray(input?.filePaths) ? input.filePaths : [],
        description: typeof input?.description === 'string' ? input.description : '',
      };
      const context = buildDiffRiskContext(safeInput);
      const call = buildDiffRiskCall(context);
      let raw: Record<string, unknown>;
      try {
        raw = (await postJevCall(
          call.state,
          call.questions,
          ctx.apiKey,
          ctx.model,
          ctx.timeoutMs,
          ctx.fetchImpl,
          ctx.signal,
        )) as Record<string, unknown>;
      } catch (err) {
        if (ctx.signal?.aborted || isJevCancelError(err)) {
          // Caller cancellation is not a risk failure: reject so the gate
          // observes cancellation instead of a fail-open resolve.
          throw err;
        }
        logJevFailure(logger, 'diff-risk batch', err);
        return { level: 'unknown', reason: JEV_UNAVAILABLE_REASON, unavailable: true };
      }
      // A swallowing transport may resolve despite cancellation — re-check
      // the signal so a cancelled call rejects instead of resolving fail-open.
      if (ctx.signal?.aborted) {
        throw ctx.signal.reason instanceof Error
          ? ctx.signal.reason
          : new DOMException('Jev diff-risk assessment aborted', 'AbortError');
      }
      const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
      logResponseModel(logger, model);
      const aligned = alignAnswers(call.ids, raw);
      const level = mapDiffRiskSignalsToLevel(
        parseNoulAnswer(aligned[0], model),
        parseNoulAnswer(aligned[1], model),
        parseScoreAnswer(aligned[2], model),
      );
      if (level === 'unknown') {
        logger.debug(
          'Jev diff-risk batch yielded no decisive signal (fail-open to deterministic gate)',
        );
      } else {
        logger.info(`Jev diff-risk batch: level=${level} [model=${model ?? 'unknown'}]`);
      }
      return { level, reason: 'ok', model, unavailable: false };
    } catch (err) {
      if (options.signal?.aborted || isJevCancelError(err)) {
        throw err instanceof Error
          ? err
          : new DOMException('Jev diff-risk assessment aborted', 'AbortError');
      }
      logJevFailure(logger, 'diff-risk assessment', err);
      return { level: 'unknown', reason: JEV_UNAVAILABLE_REASON, unavailable: true };
    }
  }
}

/**
 * Pre-filter verification findings through Jev validity scoring (Module 1
 * shadow pre-filter). Findings with low validity reported with high
 * confidence are dropped as obvious false positives; everything else —
 * including every finding when Jev is disabled or unavailable — is kept so
 * the existing verification path runs unchanged.
 *
 * Behavior:
 * - `JEV_ENABLED!=true` → `{ kept: <input>, dropped: [], skipped: true,
 *   reason: 'jev-disabled' }` (zero behavior change, no HTTP traffic).
 * - No API key / transport / API / parse failure → fail-open with
 *   `reason: 'jev-unavailable'`, all findings kept. Fail-open except caller
 *   cancellation (the whole policy sits inside try, covering even a
 *   misbehaving custom provider; an aborted signal rejects).
 * - Enabled + healthy → chunked Score calls via the validity provider;
 *   findings where {@link isObviousFalsePositive} holds are dropped.
 *   `critical` findings are never dropped (see `isObviousFalsePositive`).
 *
 * Deterministic filters (`filterFindings`, `noiseBudget`) are owned by the
 * caller and intentionally untouched here.
 *
 * @param findings - Findings entering the verification pass.
 * @param options - Call options (logger/fetch/model/timeout/provider overrides).
 * @returns Kept/dropped partition with skip metadata. Rejects only on caller cancellation.
 */
export async function prefilterVerificationIssues<TFinding extends JevPrefilterFinding>(
  findings: TFinding[],
  options: JevCallOptions = {},
): Promise<JevPrefilterResult<TFinding>> {
  const logger = options.logger ?? moduleLogger;
  try {
    if (!isJevEnabled()) {
      return { kept: findings, dropped: [], skipped: true, reason: 'jev-disabled' };
    }
    if (!Array.isArray(findings)) {
      logger.warn('Jev verification pre-filter received non-array findings (fail-open)');
      return { kept: [], dropped: [], skipped: true, reason: JEV_UNAVAILABLE_REASON };
    }
    if (findings.length === 0) {
      return { kept: findings, dropped: [], skipped: false, reason: 'ok' };
    }
    const ctx = resolveCallContext(options);
    if (!ctx) {
      return { kept: findings, dropped: [], skipped: true, reason: JEV_UNAVAILABLE_REASON };
    }
    const provider = options.provider ?? defaultRestProvider;
    const assessments = await provider.scoreBatch(findings, options);
    // A swallowing provider may resolve despite cancellation — re-check the
    // signal so a cancelled call rejects instead of resolving fail-open.
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException('Jev verification pre-filter aborted', 'AbortError');
    }
    const model = assessments.find((assessment) => !assessment.unavailable)?.model;
    // Total failure (no usable assessment from any chunk) degrades to the
    // fail-open contract: keep everything and report `skipped` so callers
    // distinguish "Jev answered" from "Jev contributed nothing". Partial
    // chunk success still applies its drops.
    const anySignal = assessments.some((assessment) => !assessment.unavailable);
    if (!anySignal) {
      return { kept: findings, dropped: [], skipped: true, reason: JEV_UNAVAILABLE_REASON };
    }
    const kept: TFinding[] = [];
    const dropped: TFinding[] = [];
    findings.forEach((finding, index) => {
      const assessment = assessments[index];
      if (
        assessment &&
        !assessment.unavailable &&
        isObviousFalsePositive(assessment.score, assessment.confidence, finding.severity)
      ) {
        logger.debug(
          `Jev pre-filter dropping obvious FP: ${finding.file}:${finding.line} ` +
            `(score=${assessment.score.toFixed(3)}, confidence=${assessment.confidence.toFixed(3)})`,
        );
        dropped.push(finding);
      } else {
        kept.push(finding);
      }
    });
    logger.info(
      `Jev verification pre-filter: kept ${kept.length}/${findings.length}, ` +
        `dropped ${dropped.length} [model=${model ?? 'unknown'}]`,
    );
    return { kept, dropped, skipped: false, reason: 'ok', model };
  } catch (err) {
    if (options.signal?.aborted || isJevCancelError(err)) {
      // Caller cancellation (or a provider abort) is not a verification
      // failure: reject so cancellation propagates instead of resolving
      // fail-open. Genuine Jev/timeout failures still fail open below.
      throw err instanceof Error
        ? err
        : new DOMException('Jev verification pre-filter aborted', 'AbortError');
    }
    logJevFailure(logger, 'verification pre-filter', err);
    return {
      kept: Array.isArray(findings) ? findings : [],
      dropped: [],
      skipped: true,
      reason: JEV_UNAVAILABLE_REASON,
    };
  }
}
