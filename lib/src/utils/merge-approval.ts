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
