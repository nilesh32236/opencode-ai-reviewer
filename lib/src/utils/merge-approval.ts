/**
 * Human merge-approval policy for autonomous PR merges (REF-005).
 *
 * `autofix:ready` is an advisory AI/CI signal only — it must never authorize a
 * merge. Merges require the dedicated `autofix:merge-approved` label applied by
 * an explicit human actor. This module centralizes the label name, the
 * privileged actor allowlists, and the fail-closed evaluation so workflows,
 * tests, and reviewers share one definition.
 *
 * Deliberately distinct from `autofix:approved` (see `safe-exec.ts`), which
 * authorizes destructive fixes and suppresses review/fix processing and must
 * not be repurposed for merge authorization.
 */

/** Dedicated human merge-authorization label. Advisory `autofix:ready` never merges. */
export const MERGE_APPROVAL_LABEL = 'autofix:merge-approved' as const;

/** Advisory AI/CI signal. Display only — never authorizes a merge. */
export const MERGE_ADVISORY_LABEL = 'autofix:ready' as const;

/** Destructive-fix approval labels that must NOT authorize a merge. */
export const MERGE_FORBIDDEN_LABELS: ReadonlySet<string> = new Set([
  'autofix:approved',
  'autofix-approve',
  'autofix-approved',
]);

/**
 * GitHub `author_association` values accepted as privileged human actors.
 * Mirrors `app/src/utils/privilege.ts` (OWNER/MEMBER/COLLABORATOR).
 */
export const MERGE_APPROVAL_ASSOCIATIONS: ReadonlyArray<string> = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
] as const;

/**
 * Repository permission levels accepted as privileged human actors.
 * Checked via the API (`admin`/`maintain`/`write`); association alone is not
 * sufficient where a permission lookup is available.
 */
export const MERGE_APPROVAL_PERMISSIONS: ReadonlyArray<string> = [
  'admin',
  'maintain',
  'write',
] as const;

/** Input for {@link isMergeAuthorized}. All fields fail closed when absent. */
export interface MergeAuthorizationInput {
  /** Current PR labels (any case, surrounding whitespace tolerated). */
  labels?: unknown;
  /** Event sender login (e.g. `octocat`). Bot logins (`[bot]` suffix) are rejected. */
  senderLogin?: unknown;
  /** Event sender type (e.g. `User`, `Bot`). `Bot` is rejected. */
  senderType?: unknown;
  /** Sender `author_association` (e.g. `OWNER`). */
  authorAssociation?: unknown;
  /**
   * Sender repository permission (`admin`/`maintain`/`write`), resolved via
   * the API immediately before merge. Required — absent values fail closed.
   */
  permission?: unknown;
  /** Whether the PR is open. */
  isOpen?: unknown;
  /** Whether the PR is already merged. */
  isMerged?: unknown;
  /** Head SHA the approval was issued for (event SHA). */
  eventHeadSha?: unknown;
  /** Current PR head SHA (re-fetched immediately before merge). */
  currentHeadSha?: unknown;
}

/** Result of {@link isMergeAuthorized}. */
export interface MergeAuthorizationResult {
  /** True only when every human-approval check passes. */
  authorized: boolean;
  /** Machine-readable deny reason (present when not authorized). */
  reason: string;
}

/** Current PR state for {@link authorizeMergeFromTimeline}. All fields fail closed when absent. */
export interface MergeApprovalPRState {
  /** Current PR labels (any case, surrounding whitespace tolerated). */
  labels?: unknown;
  /** Whether the PR is open. */
  isOpen?: unknown;
  /** Whether the PR is already merged. */
  isMerged?: unknown;
  /** Current PR head SHA (re-fetched immediately before merge). */
  currentHeadSha?: unknown;
  /**
   * Approver repository permission (`admin`/`maintain`/`write`), resolved via
   * the API for the resolved approver immediately before merge. Required —
   * absent values fail closed.
   */
  permission?: unknown;
}

/**
 * Single timeline `labeled` event candidate for merge-approval resolution.
 * Accepts both the REST timeline shape (`{ event: 'labeled', label: { name },
 * actor: { login, type }, commit_id, created_at }`) and flattened shapes —
 * field aliases below keep the resolver tolerant without ever failing open.
 */
export interface MergeApprovalTimelineEvent {
  /** Event name — only `labeled` events are considered. */
  event?: unknown;
  /** Label applied by the event (string or `{ name }`). */
  label?: unknown;
  /** Actor login — also accepts `actor` object or `senderLogin` alias. */
  actorLogin?: unknown;
  /** Actor object (`{ login, type }`) for REST timeline shapes. */
  actor?: unknown;
  /** Actor type (`User`/`Bot`) — also accepts `actor.type` or `senderType` alias. */
  actorType?: unknown;
  /** Sender type alias for workflow event shapes. */
  senderType?: unknown;
  /** Sender `author_association`. */
  authorAssociation?: unknown;
  /** Head SHA the label was applied at — accepts `commit_id`/`commitSha` aliases. */
  commitSha?: unknown;
  /** Commit alias for REST timeline shapes (`commit_id`). */
  commit_id?: unknown;
  /** Event timestamp for latest-wins ordering (ISO string). */
  createdAt?: unknown;
  /** Timestamp alias for REST timeline shapes (`created_at`). */
  created_at?: unknown;
}

/** Approver identity resolved from the PR timeline (binding side of the verdict). */
export interface ResolvedMergeApproval {
  /** Approving actor login (may be empty — `isMergeAuthorized` fails closed). */
  senderLogin: string;
  /** Approving actor type (pass-through — absent/`Bot` fails closed downstream). */
  senderType: unknown;
  /** Approving actor `author_association` (pass-through — unprivileged fails closed). */
  authorAssociation: unknown;
  /** Head SHA the approval was issued for (pass-through — stale/missing fails closed). */
  eventHeadSha: unknown;
}

/**
 * Check whether a login denotes a bot account (`[bot]` suffix, case-insensitive).
 * @param login - Actor login.
 * @returns True for bot logins or non-string input (fail closed upstream).
 */
export function isBotActor(login: unknown): boolean {
  if (typeof login !== 'string' || login.trim() === '') return true;
  return login.toLowerCase().endsWith('[bot]');
}

/**
 * Normalize a PR label to its lowercase trimmed name.
 * Accepts plain strings and GitHub API label objects (`{ name: '...' }`);
 * anything else yields `undefined` (fail closed upstream).
 * @param label - Raw label value.
 * @returns Normalized label name, or `undefined` when not recoverable.
 */
function normalizeLabelName(label: unknown): string | undefined {
  const name =
    typeof label === 'string' ? label : (label as { name?: unknown } | null | undefined)?.name;
  if (typeof name !== 'string') return undefined;
  return name.trim().toLowerCase();
}

/**
 * Find a forbidden destructive-fix label in a PR label list.
 * @param labels - PR labels (strings or `{ name }` API objects).
 * @returns The normalized forbidden label name, or `undefined` when absent.
 */
function findForbiddenMergeLabel(labels: unknown): string | undefined {
  if (!Array.isArray(labels)) return undefined;
  for (const label of labels) {
    const name = normalizeLabelName(label);
    if (name !== undefined && (MERGE_FORBIDDEN_LABELS as ReadonlySet<string>).has(name)) {
      return name;
    }
  }
  return undefined;
}

/**
 * Check whether an `author_association` value is a privileged human association.
 * @param association - Raw association value.
 * @returns True only for exactly OWNER/MEMBER/COLLABORATOR (case-sensitive, per API).
 */
export function isPrivilegedAssociation(association: unknown): boolean {
  if (typeof association !== 'string') return false;
  return (MERGE_APPROVAL_ASSOCIATIONS as readonly string[]).includes(association);
}

/**
 * Check whether a repository permission level is privileged for merges.
 * @param permission - Raw permission value (`admin`/`maintain`/`write`/`read`/…).
 * @returns True for admin/maintain/write (case-insensitive, whitespace tolerated).
 */
export function isPrivilegedPermission(permission: unknown): boolean {
  if (typeof permission !== 'string') return false;
  const normalized = permission.trim().toLowerCase();
  return (MERGE_APPROVAL_PERMISSIONS as readonly string[]).includes(normalized);
}

/**
 * Check whether labels contain a forbidden destructive-fix label.
 * `autofix:approved` and its variants authorize destructive fixes — they must
 * never authorize a merge, even alongside the merge-approval label.
 * @param labels - PR labels (strings or `{ name }` API objects).
 * @returns True when any forbidden label is present.
 */
export function hasForbiddenMergeLabel(labels: unknown): boolean {
  return findForbiddenMergeLabel(labels) !== undefined;
}

/**
 * Check whether labels contain the exact dedicated merge-approval label.
 * Matching is case-insensitive with surrounding whitespace tolerated, but no
 * substrings: `autofix:ready`, `autofix:approved`, and similar never count.
 * Accepts plain strings and GitHub API label objects (`{ name: '...' }`).
 * @param labels - PR labels.
 * @returns True only when `autofix:merge-approved` is present.
 */
export function hasMergeApprovalLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;
  for (const label of labels) {
    if (normalizeLabelName(label) === MERGE_APPROVAL_LABEL) return true;
  }
  return false;
}

/**
 * Fail-closed human merge-authorization check (REF-005).
 *
 * Requires ALL of: no forbidden destructive-fix labels, exact
 * `autofix:merge-approved` label, non-bot sender login and type (an absent
 * sender type fails closed — only the `[bot]` login heuristic is not enough),
 * privileged `author_association`, privileged repository permission (required;
 * absent values fail closed — callers must resolve it via the API immediately
 * before merge), open and unmerged PR, and event-head SHA bound to the
 * current head SHA. `autofix:ready` and injected `approved:true` JSON never
 * authorize.
 *
 * Pure function (no I/O), safe to unit test.
 * @param input - Merge authorization signals.
 * @returns Authorization verdict with a deny reason.
 */
export function isMergeAuthorized(input: MergeAuthorizationInput): MergeAuthorizationResult {
  const labels = input?.labels;
  const forbidden = findForbiddenMergeLabel(labels);
  if (forbidden !== undefined) {
    return {
      authorized: false,
      reason: `forbidden label \`${forbidden}\` — destructive-fix approvals never authorize a merge; remove it and require \`${MERGE_APPROVAL_LABEL}\``,
    };
  }
  if (!hasMergeApprovalLabel(labels)) {
    return {
      authorized: false,
      reason: `missing required label \`${MERGE_APPROVAL_LABEL}\` — \`${MERGE_ADVISORY_LABEL}\` is advisory only`,
    };
  }
  const senderLogin = input?.senderLogin;
  if (typeof senderLogin !== 'string' || senderLogin.trim() === '') {
    return { authorized: false, reason: 'missing event sender login' };
  }
  if (isBotActor(senderLogin)) {
    return { authorized: false, reason: `bot sender \`${senderLogin}\` cannot authorize a merge` };
  }
  const senderType = input?.senderType;
  if (typeof senderType !== 'string' || senderType.trim() === '') {
    return { authorized: false, reason: 'missing event sender type — cannot verify human actor' };
  }
  if (senderType.trim().toLowerCase() === 'bot') {
    return { authorized: false, reason: 'bot sender type cannot authorize a merge' };
  }
  if (!isPrivilegedAssociation(input?.authorAssociation)) {
    return {
      authorized: false,
      reason: `unprivileged author_association \`${String(input?.authorAssociation ?? 'none')}\` — requires OWNER/MEMBER/COLLABORATOR`,
    };
  }
  // Repository permission is the strong signal (API-resolved, not
  // event-supplied). Absent values fail closed: callers must resolve the
  // sender's permission immediately before merge and pass it in.
  if (!isPrivilegedPermission(input?.permission)) {
    return {
      authorized: false,
      reason: `unprivileged repository permission \`${String(input?.permission ?? 'none')}\` — requires admin/maintain/write`,
    };
  }
  if (input?.isOpen !== true) {
    return { authorized: false, reason: 'PR is not open' };
  }
  if (input?.isMerged === true) {
    return { authorized: false, reason: 'PR is already merged' };
  }
  const eventSha = typeof input?.eventHeadSha === 'string' ? input.eventHeadSha.trim() : '';
  const currentSha = typeof input?.currentHeadSha === 'string' ? input.currentHeadSha.trim() : '';
  if (eventSha === '' || currentSha === '') {
    return {
      authorized: false,
      reason: 'missing head SHA binding — cannot verify approval target',
    };
  }
  if (eventSha !== currentSha) {
    return {
      authorized: false,
      reason: `stale approval (approved ${eventSha.slice(0, 7)}, head is now ${currentSha.slice(0, 7)}) — re-approval required after every push`,
    };
  }
  return {
    authorized: true,
    reason: `human approval verified (${senderLogin}, head ${currentSha.slice(0, 7)})`,
  };
}

/**
 * Extract a string field from a timeline event, tolerating alias names.
 * @param event - Raw timeline event object.
 * @param keys - Field names to try in order.
 * @returns First non-empty trimmed string, or `undefined`.
 */
function timelineStringField(event: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Resolve the approving human actor from PR timeline `labeled` events (DISC-001).
 *
 * Workflow merge sites cannot trust the ambient event sender (it may be the
 * orchestrator bot or a stale event): the approver is the actor of the latest
 * `labeled` event that applied the exact `autofix:merge-approved` label, and
 * the approved head SHA is that event's commit. Callers re-fetch the timeline
 * immediately before merge, resolve with this function, look up the resolved
 * login's repository permission via the API, and evaluate everything with
 * {@link isMergeAuthorized} (or {@link authorizeMergeFromTimeline}).
 *
 * Latest-wins: array order is chronological from the API, so the last
 * matching event wins; when both candidates carry parseable `created_at` /
 * `createdAt` timestamps the newer timestamp wins instead. Bot filtering is
 * intentionally NOT applied here — bots are returned as candidates so the
 * downstream verdict denies with an explicit bot reason.
 *
 * Pure function (no I/O), safe to unit test.
 * @param events - PR timeline events (array; anything else yields `undefined`).
 * @returns Resolved approver binding, or `undefined` when no
 * `autofix:merge-approved` labeled event exists.
 */
export function resolveMergeApprovalEvent(events: unknown): ResolvedMergeApproval | undefined {
  if (!Array.isArray(events)) return undefined;
  let best: ResolvedMergeApproval | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  let bestHasTime = false;
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    const eventName = timelineStringField(event, ['event']);
    if (eventName === undefined || eventName.toLowerCase() !== 'labeled') continue;
    const labelValue =
      event.label !== undefined
        ? event.label
        : timelineStringField(event, ['labelName', 'label_name']);
    if (normalizeLabelName(labelValue) !== MERGE_APPROVAL_LABEL) continue;
    const actor =
      event.actor !== null && typeof event.actor === 'object'
        ? (event.actor as Record<string, unknown>)
        : undefined;
    const login =
      timelineStringField(event, ['actorLogin', 'actor_login', 'senderLogin', 'login']) ??
      (actor !== undefined ? timelineStringField(actor, ['login']) : undefined) ??
      '';
    const actorType =
      timelineStringField(event, [
        'actorType',
        'actor_type',
        'senderType',
        'sender_type',
        'type',
      ]) ?? (actor !== undefined ? timelineStringField(actor, ['type']) : undefined);
    const association = timelineStringField(event, ['authorAssociation', 'author_association']);
    // Prefer the canonical REST binding field (`commit_id`/`commitId`) strictly;
    // generic `sha`/`headSha` aliases are only a fallback when the canonical
    // field is absent, so an unrelated `sha` field can never override (or
    // masquerade as) the approval binding. Missing binding stays `undefined`
    // and fails closed downstream in `isMergeAuthorized`.
    const commitSha =
      timelineStringField(event, ['commitSha', 'commit_sha', 'commit_id', 'commitId']) ??
      timelineStringField(event, ['sha', 'headSha', 'head_sha']);
    const createdRaw =
      timelineStringField(event, ['createdAt', 'created_at']) ??
      event.createdAt ??
      event.created_at;
    let time = Number.NaN;
    if (typeof createdRaw === 'string' && createdRaw.trim() !== '') {
      const parsed = Date.parse(createdRaw.trim());
      if (!Number.isNaN(parsed)) time = parsed;
    } else if (typeof createdRaw === 'number' && Number.isFinite(createdRaw)) {
      time = createdRaw;
    }
    const candidate: ResolvedMergeApproval = {
      senderLogin: login,
      senderType: actorType,
      authorAssociation: association,
      eventHeadSha: commitSha,
    };
    if (best === undefined) {
      best = candidate;
      bestTime = time;
      bestHasTime = !Number.isNaN(time);
      continue;
    }
    // Both timestamped: newer wins, ties keep the later array entry.
    if (!Number.isNaN(time) && bestHasTime) {
      if (time >= bestTime) {
        best = candidate;
        bestTime = time;
      }
      continue;
    }
    // Otherwise array order is chronological: later entries supersede.
    best = candidate;
    bestTime = time;
    bestHasTime = !Number.isNaN(time);
  }
  return best;
}

/**
 * Fail-closed merge verdict from live PR state plus timeline approval binding (DISC-001).
 *
 * Resolves the approver with {@link resolveMergeApprovalEvent} and evaluates
 * the full {@link isMergeAuthorized} contract (label presence, forbidden
 * labels, bot rejection, association + API-resolved permission, open/unmerged,
 * event-head SHA bound to the current head). Any missing signal — no labeled
 * event, missing label, stale head, weak permission — denies. A head move
 * after approval denies and requires re-approval (no auto-carry).
 *
 * Pure function (no I/O): callers re-fetch PR state, timeline, and the
 * resolved approver's permission immediately before merge and pass them in.
 * @param pr - Live PR state including the approver's API-resolved permission.
 * @param events - PR timeline events for approver resolution.
 * @returns Authorization verdict with a deny reason.
 */
export function authorizeMergeFromTimeline(
  pr: MergeApprovalPRState,
  events: unknown,
): MergeAuthorizationResult {
  const resolved = resolveMergeApprovalEvent(events);
  if (resolved === undefined) {
    return {
      authorized: false,
      reason: `missing required label \`${MERGE_APPROVAL_LABEL}\` — no labeled event found in the PR timeline (\`${MERGE_ADVISORY_LABEL}\` is advisory only)`,
    };
  }
  return isMergeAuthorized({
    labels: pr?.labels,
    senderLogin: resolved.senderLogin,
    senderType: resolved.senderType,
    authorAssociation: resolved.authorAssociation,
    permission: pr?.permission,
    isOpen: pr?.isOpen,
    isMerged: pr?.isMerged,
    eventHeadSha: resolved.eventHeadSha,
    currentHeadSha: pr?.currentHeadSha,
  });
}
