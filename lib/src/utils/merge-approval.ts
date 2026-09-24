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
  /** Sender repository permission (`admin`/`maintain`/`write`). */
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
 * Check whether labels contain the exact dedicated merge-approval label.
 * Matching is case-insensitive with surrounding whitespace tolerated, but no
 * substrings: `autofix:ready`, `autofix:approved`, and similar never count.
 * @param labels - PR labels.
 * @returns True only when `autofix:merge-approved` is present.
 */
export function hasMergeApprovalLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    if (label.trim().toLowerCase() === MERGE_APPROVAL_LABEL) return true;
  }
  return false;
}

/**
 * Fail-closed human merge-authorization check (REF-005).
 *
 * Requires ALL of: exact `autofix:merge-approved` label, non-bot sender login
 * and type, privileged `author_association`, privileged repository permission
 * (when a permission value is supplied — callers with API access must supply
 * it), open and unmerged PR, and event-head SHA bound to the current head SHA.
 * `autofix:ready` and injected `approved:true` JSON never authorize.
 *
 * Pure function (no I/O), safe to unit test.
 * @param input - Merge authorization signals.
 * @returns Authorization verdict with a deny reason.
 */
export function isMergeAuthorized(input: MergeAuthorizationInput): MergeAuthorizationResult {
  const labels = input?.labels;
  if (!hasMergeApprovalLabel(labels)) {
    return {
      authorized: false,
      reason: `missing required label \`${MERGE_APPROVAL_LABEL}\` — \`autofix:ready\` is advisory only`,
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
  if (typeof senderType === 'string' && senderType.trim().toLowerCase() === 'bot') {
    return { authorized: false, reason: 'bot sender type cannot authorize a merge' };
  }
  if (!isPrivilegedAssociation(input?.authorAssociation)) {
    return {
      authorized: false,
      reason: `unprivileged author_association \`${String(input?.authorAssociation ?? 'none')}\` — requires OWNER/MEMBER/COLLABORATOR`,
    };
  }
  // Permission is required when the caller can resolve it; an absent value
  // fails closed only when explicitly supplied as a non-privileged value.
  // Callers WITHOUT API access pass `undefined` (association gate applies);
  // callers WITH access must pass the resolved permission and it must qualify.
  if (input?.permission !== undefined && !isPrivilegedPermission(input.permission)) {
    return {
      authorized: false,
      reason: `unprivileged repository permission \`${String(input.permission)}\` — requires admin/maintain/write`,
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
