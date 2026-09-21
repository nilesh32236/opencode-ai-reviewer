/**
 * Jev (opencode.ai Zen SystemOne) client wrapper + verification pre-filter.
 *
 * Module 1 is an OPT-IN shadow pre-filter for the verification pass: when
 * `JEV_ENABLED=true`, finding-validity Score questions are issued to Jev
 * before the expensive verification LLM call so obvious false positives can
 * be dropped cheaply. When disabled (the default) every helper is a no-op
 * and the existing verification path runs 100% unchanged.
 *
 * API assumptions (documented because the endpoint has no local schema):
 * - `POST {JEV_ENDPOINT}` with `Authorization: Bearer <key>` and a JSON body
 *   of `{ model, questions }`, where each question carries an `id`, a `type`
 *   (`choice` | `score` | `noul`), a `question` string, optional `context`,
 *   and a `criteria` array (NOT `options`). Responses echo
 *   `response.model` and carry an `answers` (or `results`) array matched to
 *   the request by `id` (falling back to positional order).
 * - Contract reference: Zen SystemOne wire shape is
 *   `{ model, questions: [{ id, type, question, context, criteria }] }`
 *   (see {JEV_ENDPOINT}). NOTE — this deliberately differs from the native
 *   TypeSafe shape (`{ state, questions-map }`); do NOT "normalize" one into
 *   the other. If the endpoint drifts, parsing degrades to fail-open
 *   `jev-unavailable` (see `extractAnswers`) and deterministic 4xx are
 *   logged distinctly (see `logJevFailure`) so silent fail-open stays visible.
 * - Choice answers return `{ choice, probabilities, confidence }`, score
 *   answers return `{ score (0..1), confidence }`, noul answers return
 *   `{ noul, confidence }`. Parsing is defensive: unknown shapes degrade to
 *   "unavailable" instead of throwing.
 *
 * External-sharing note: finding text sent to Jev leaves the repo boundary
 * (external API call). Question text is passed through `sanitizeString` to
 * redact secret-shaped material first, but finding messages may still contain
 * proprietary code context. Enabling `JEV_ENABLED=true` is therefore an
 * explicit opt-in to external sharing — follow up in action.yml/README docs
 * (workflows intentionally untouched by Module 1).
 *
 * Resilience contract (fail-open, never throws into the caller):
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

/** A single choice candidate in a `choice` question's `criteria` array. */
export interface JevChoiceCriterion {
  /** Candidate label returned verbatim in `choice` when selected. */
  choice: string;
  /** Optional description helping the model discriminate candidates. */
  description?: string;
}

/** A single scored dimension in a `score` question's `criteria` array. */
export interface JevScoreCriterion {
  /** Dimension name (e.g. `validity`). */
  name: string;
  /** Optional description of what the dimension measures. */
  description?: string;
}

/** A single candidate in a `noul` question's `criteria` array. */
export interface JevNoulCriterion {
  /** Candidate label. */
  name: string;
  /** Optional description helping the model discriminate candidates. */
  description?: string;
}

/** Input for a Jev `choice` question. */
export interface JevChoiceInput {
  /** Question text. */
  question: string;
  /** Optional supporting context (finding text, diff snippet, ...). */
  context?: string;
  /** Candidate set — note the `criteria` shape (never `options`). */
  criteria: JevChoiceCriterion[];
}

/** Input for a Jev `score` question. */
export interface JevScoreInput {
  /** Question text. */
  question: string;
  /** Optional supporting context. */
  context?: string;
  /** Scored dimensions — `criteria` shape (never `options`). */
  criteria: JevScoreCriterion[];
}

/** Input for a Jev `noul` question. */
export interface JevNoulInput {
  /** Question text. */
  question: string;
  /** Optional supporting context. */
  context?: string;
  /** Candidate set — `criteria` shape (never `options`). */
  criteria: JevNoulCriterion[];
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
  /** Selected candidate label. */
  noul: string;
  /** Model-reported confidence in 0..1. */
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
   * input. Must never throw: per-finding failures degrade to
   * `{ unavailable: true, reason: 'jev-unavailable' }` so callers keep the
   * finding (fail open).
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
   * to the input. Must never throw: per-entry failures degrade to
   * `{ unavailable: true, reason: 'jev-unavailable' }` so callers keep the
   * existing order (fail open).
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
  // Caller cancellations (AbortError) are excluded: an aborted caller is not
  // a Jev failure, and a burst of review cancellations must never trip the
  // breaker for subsequent reviews. HTTP/transport failures (including
  // per-attempt TimeoutErrors and status-less network errors) still count.
  shouldCountFailure: (err) => !isJevCancelError(err) && countHttpError(err),
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
  const raw = Number.parseInt(env.JEV_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return JEV_DEFAULT_TIMEOUT_MS;
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

/** Wire shape of a single question in the Jev request body. */
interface JevRequestQuestion {
  /** Caller-assigned id used to match answers back to questions. */
  id: string;
  /** Question kind. */
  type: 'choice' | 'score' | 'noul';
  /** Question text. */
  question: string;
  /** Optional supporting context. */
  context?: string;
  /** Candidate/dimension set — `criteria` shape (never `options`). */
  criteria: Array<{ choice?: string; name?: string; description?: string }>;
}

/** Wire shape of the Jev request body. */
interface JevRequestBody {
  /** Model id (free default, pinnable via `JEV_MODEL`). */
  model: string;
  /** Questions to answer in one batched call. */
  questions: JevRequestQuestion[];
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
 * Extract the answers array from a Jev response body, tolerating envelope
 * variations (`answers`, `results`, or a single answer object). When both
 * arrays are present, `answers` wins — concatenating both would shift
 * positional alignment and misassign answers to the wrong findings.
 *
 * @param body - Parsed JSON response body.
 * @returns Candidate answer records (possibly empty).
 */
function extractAnswers(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const answers = body.answers;
  const results = body.results;
  const list = Array.isArray(answers) ? answers : Array.isArray(results) ? results : [];
  if (list.length === 0) {
    // Single-answer envelope: treat the body itself as the answer.
    return [body];
  }
  return list.filter(isRecord);
}

/**
 * Match answers back to request questions by `id`. Positional fallback
 * applies ONLY when the response carries no answer ids at all: when ids are
 * present but an answer is missing or reordered, the unmatched slot resolves
 * to undefined (fail-open unavailable) instead of misassigning a neighbor's
 * answer — a misassigned low-validity score could otherwise drop the wrong
 * finding.
 *
 * @param questions - Request questions in sent order.
 * @param answers - Response answer records.
 * @returns Answers aligned to the request order (possibly undefined slots).
 */
function alignAnswers(
  questions: JevRequestQuestion[],
  answers: Record<string, unknown>[],
): Array<Record<string, unknown> | undefined> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const answer of answers) {
    const id = toNonEmptyString(answer.id);
    if (id !== undefined && !byId.has(id)) byId.set(id, answer);
  }
  const hasAnswerIds = byId.size > 0;
  return questions.map(
    (question, index) => byId.get(question.id) ?? (hasAnswerIds ? undefined : answers[index]),
  );
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
 * Parse a `noul` answer record into a typed result. Confidence must be a
 * finite number in 0..1 (mirroring the score path) — missing or
 * out-of-range confidence resolves to undefined (fail-open) instead of
 * defaulting to 0.
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
    toNonEmptyString(answer.noul) ??
    toNonEmptyString(answer.answer) ??
    toNonEmptyString(answer.choice);
  if (noul === undefined) return undefined;
  const confidence = toFiniteNumber(answer.confidence);
  if (confidence === undefined || confidence < 0 || confidence > 1) return undefined;
  return {
    noul,
    confidence,
    model,
  };
}

/**
 * POST a batch of questions to Jev with retry + per-attempt timeout behind
 * the shared circuit breaker. Non-2xx responses throw a status-carrying error
 * so retry only fires on retryable codes (429/5xx); status-less failures
 * (timeouts, network) fail fast without retry.
 *
 * @param questions - Questions to answer in one call (must be non-empty).
 * @param apiKey - Bearer token.
 * @param model - Model id to request.
 * @param timeoutMs - Per-attempt HTTP timeout in ms.
 * @param logger - Logger for diagnostics.
 * @param fetchImpl - Fetch implementation.
 * @param signal - Optional AbortSignal to cancel the call mid-flight.
 * @returns The parsed JSON response body.
 */
async function postJevQuestions(
  questions: JevRequestQuestion[],
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
  const body: JevRequestBody = { model, questions };
  return jevCircuitBreaker.call(() =>
    withRetryAndTimeout(
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
    ),
  );
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
 * Build the validity Score question for a finding, keeping the `criteria`
 * shape exactly (never `options`). Question text is passed through
 * `sanitizeString` first: finding messages cross the repo boundary to an
 * external API, so secret-shaped material is redacted before send (see the
 * external-sharing note in the module doc; user-facing disclosure lives in
 * the README Configuration Reference).
 *
 * Known limitation: only pattern-shaped secrets are redacted pre-send.
 * Running the entropy-based `detectSecrets` scan over every outbound payload
 * was evaluated and rejected — its findings discard raw values at the final
 * filter step, so re-deriving redaction spans for the request body cannot be
 * done safely in a small change. Treat `JEV_ENABLED=true` as sharing
 * finding summaries (file, line, message) with the Jev endpoint.
 *
 * @param finding - Finding to assess.
 * @param id - Caller-assigned question id for answer alignment.
 * @returns The wire-shape Score question.
 */
function buildValidityQuestion(finding: JevPrefilterFinding, id: string): JevRequestQuestion {
  const summary = sanitizeString(
    `Finding in ${finding.file} line ${finding.line}: ${finding.message}`,
  );
  return {
    id,
    type: 'score',
    question: `Is this code review finding a genuine, actionable defect (score close to 1) or a false positive (score close to 0)? ${summary}`,
    context: `severity=${finding.severity ?? 'unknown'}`,
    criteria: [
      {
        name: 'validity',
        description:
          'Likelihood the finding is a genuine actionable defect rather than a false positive, from 0 (false positive) to 1 (genuine defect).',
      },
    ],
  };
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
 * Build a relevance Score question for a context entry (Module 2), keeping
 * the `criteria` shape exactly (never `options`). Both the entry excerpt
 * and the query pass through `sanitizeString` first: context content crosses
 * the repo boundary to an external API, so secret-shaped material is
 * redacted before send (same known limitation as the validity path — see
 * `buildValidityQuestion`; user-facing disclosure lives in the README
 * Configuration Reference).
 *
 * Ordering matters: sanitize FIRST on the full content, then truncate to
 * the excerpt limits. Truncating first could cut a secret pattern at the
 * boundary so the redaction regex no longer matches and raw key fragments
 * leak into the request. A `[REDACTED]` marker split by truncation is inert
 * text and harmless.
 *
 * @param content - Context entry content (truncated to an excerpt).
 * @param query - Review-task query the relevance is judged against.
 * @param id - Caller-assigned question id for answer alignment.
 * @returns The wire-shape Score question.
 */
function buildRelevanceQuestion(content: string, query: string, id: string): JevRequestQuestion {
  const excerpt = sanitizeString(content).slice(0, JEV_RANK_MAX_CONTENT_CHARS);
  const task = sanitizeString(query).slice(0, JEV_RANK_MAX_QUERY_CHARS);
  return {
    id,
    type: 'score',
    question: `How relevant is the following context to this review task: "${task}"? (score close to 1 = highly relevant, score close to 0 = irrelevant) Context: ${excerpt}`,
    context: 'source=jev-context-rank',
    criteria: [
      {
        name: 'relevance',
        description:
          'How relevant the context is to the review task, from 0 (irrelevant) to 1 (highly relevant).',
      },
    ],
  };
}

/** One aligned slot from a chunked Score call: the parsed result (if usable) plus the chunk's echoed model. */
interface ChunkedScoreSlot {
  /** Parsed score result, or undefined when the slot is missing/unparseable/out-of-range. */
  parsed: JevScoreResult | undefined;
  /** Model version echoed by the chunk's response (undefined on chunk failure). */
  model: string | undefined;
}

/**
 * Shared chunked Score transport core for the validity (Module 1) and
 * relevance (Module 2) providers. Sequential chunks of at most
 * `JEV_MAX_BATCH_QUESTIONS` questions per call (bounded latency), per-chunk
 * fail-open (a chunk failure yields undefined slots for that chunk only),
 * first-chunk `response.model` logging. Strict `parseScoreAnswer` validation
 * applies — malformed slots degrade to undefined, never to a decision.
 *
 * @param questions - Wire-shape Score questions, in order.
 * @param ctx - Resolved call context (enabled gate + key already checked).
 * @param operation - Short label for failure logs (e.g. `validity batch`).
 * @param unit - Per-question noun for failure logs (e.g. `findings`).
 * @returns Slots aligned to the input order.
 */
async function scoreQuestionChunks(
  questions: JevRequestQuestion[],
  ctx: JevCallContext,
  operation: string,
  unit: string,
): Promise<ChunkedScoreSlot[]> {
  const slots: ChunkedScoreSlot[] = [];
  for (let start = 0; start < questions.length; start += JEV_MAX_BATCH_QUESTIONS) {
    const chunk = questions.slice(start, start + JEV_MAX_BATCH_QUESTIONS);
    try {
      const raw = (await postJevQuestions(
        chunk,
        ctx.apiKey,
        ctx.model,
        ctx.timeoutMs,
        ctx.fetchImpl,
        ctx.signal,
      )) as Record<string, unknown>;
      const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
      if (start === 0) logResponseModel(ctx.logger, model);
      const aligned = alignAnswers(chunk, extractAnswers(raw));
      for (const slot of aligned) {
        slots.push({ parsed: parseScoreAnswer(slot, model), model });
      }
    } catch (err) {
      if (ctx.signal?.aborted) {
        // Caller cancellation is not a Jev failure: reject so the caller
        // observes cancellation instead of a fail-open resolve. The timeout
        // path (caller signal not aborted) still degrades per-chunk below.
        throw err;
      }
      logJevFailure(ctx.logger, `${operation} (${chunk.length} ${unit})`, err);
      for (let offset = 0; offset < chunk.length; offset++) {
        slots.push({ parsed: undefined, model: undefined });
      }
    }
  }
  return slots;
}

/**
 * Ask a Jev `choice` question. Fail-open: any transport/API/parse failure
 * logs a warning and resolves to undefined (caller keeps current behavior).
 *
 * @param input - Question, optional context, and `criteria` candidates.
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
    const questions: JevRequestQuestion[] = [
      {
        id: 'choice-0',
        type: 'choice',
        question: input.question,
        context: input.context,
        criteria: input.criteria.map((criterion) => ({
          choice: criterion.choice,
          description: criterion.description,
        })),
      },
    ];
    const raw = (await postJevQuestions(
      questions,
      ctx.apiKey,
      ctx.model,
      ctx.timeoutMs,
      ctx.fetchImpl,
      ctx.signal,
    )) as Record<string, unknown>;
    const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
    logResponseModel(ctx.logger, model);
    return parseChoiceAnswer(alignAnswers(questions, extractAnswers(raw))[0], model);
  } catch (err) {
    logJevFailure(options.logger ?? moduleLogger, 'choice question', err);
    return undefined;
  }
}

/**
 * Ask a Jev `score` question. Fail-open: any transport/API/parse failure
 * logs a warning and resolves to undefined (caller keeps current behavior).
 *
 * @param input - Question, optional context, and `criteria` dimensions.
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
    const questions: JevRequestQuestion[] = [
      {
        id: 'score-0',
        type: 'score',
        question: input.question,
        context: input.context,
        criteria: input.criteria.map((criterion) => ({
          name: criterion.name,
          description: criterion.description,
        })),
      },
    ];
    const raw = (await postJevQuestions(
      questions,
      ctx.apiKey,
      ctx.model,
      ctx.timeoutMs,
      ctx.fetchImpl,
      ctx.signal,
    )) as Record<string, unknown>;
    const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
    logResponseModel(ctx.logger, model);
    return parseScoreAnswer(alignAnswers(questions, extractAnswers(raw))[0], model);
  } catch (err) {
    logJevFailure(options.logger ?? moduleLogger, 'score question', err);
    return undefined;
  }
}

/**
 * Ask a Jev `noul` question. Fail-open: any transport/API/parse failure
 * logs a warning and resolves to undefined (caller keeps current behavior).
 *
 * @param input - Question, optional context, and `criteria` candidates.
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
    const questions: JevRequestQuestion[] = [
      {
        id: 'noul-0',
        type: 'noul',
        question: input.question,
        context: input.context,
        criteria: input.criteria.map((criterion) => ({
          name: criterion.name,
          description: criterion.description,
        })),
      },
    ];
    const raw = (await postJevQuestions(
      questions,
      ctx.apiKey,
      ctx.model,
      ctx.timeoutMs,
      ctx.fetchImpl,
      ctx.signal,
    )) as Record<string, unknown>;
    const model = toNonEmptyString(isRecord(raw) ? raw.model : undefined);
    logResponseModel(ctx.logger, model);
    return parseNoulAnswer(alignAnswers(questions, extractAnswers(raw))[0], model);
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
    const validityQuestion = buildValidityQuestion(finding, 'score-0');
    const result = await askJevScore(
      {
        question: validityQuestion.question,
        context: validityQuestion.context,
        criteria: validityQuestion.criteria.map((criterion) => ({
          name: criterion.name ?? 'validity',
          description: criterion.description,
        })),
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
   * Score a batch of findings via chunked Jev Score calls. Never throws:
   * chunk failures degrade to per-finding `unavailable` assessments.
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
    const questions = findings.map((finding, index) =>
      buildValidityQuestion(finding, `validity-${index}`),
    );
    const slots = await scoreQuestionChunks(questions, ctx, 'validity batch', 'findings');
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
   * Score context contents for relevance via chunked Jev Score calls. Never
   * throws: chunk failures degrade to per-entry `unavailable` assessments.
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
    const questions = safeContents.map((content, index) =>
      buildRelevanceQuestion(content, safeQuery, `relevance-${index}`),
    );
    const slots = await scoreQuestionChunks(questions, ctx, 'relevance batch', 'entries');
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
 *   `reason: 'jev-unavailable'`, all findings kept. Never throws (the whole
 *   policy sits inside try, covering even a misbehaving custom provider).
 * - Enabled + healthy → chunked Score calls via the validity provider;
 *   findings where {@link isObviousFalsePositive} holds are dropped.
 *   `critical` findings are never dropped (see `isObviousFalsePositive`).
 *
 * Deterministic filters (`filterFindings`, `noiseBudget`) are owned by the
 * caller and intentionally untouched here.
 *
 * @param findings - Findings entering the verification pass.
 * @param options - Call options (logger/fetch/model/timeout/provider overrides).
 * @returns Kept/dropped partition with skip metadata. Never throws.
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
    logJevFailure(logger, 'verification pre-filter', err);
    return {
      kept: Array.isArray(findings) ? findings : [],
      dropped: [],
      skipped: true,
      reason: JEV_UNAVAILABLE_REASON,
    };
  }
}
