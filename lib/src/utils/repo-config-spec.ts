/**
 * Single table driving per-repo config merges.
 *
 * `app/src/utils/config.ts#mergeRepoConfig` kept two parallel field lists
 * that had to change together: the early-return guard enumerating merged
 * sections and the spread-merge body. Adding a section to one list but not
 * the other silently dropped the config. This spec is the single source of
 * truth: the guard (`hasRepoConfigOverrides`) and the merge body iterate the
 * same `REPO_CONFIG_MERGE_FIELDS` table so one edit covers both.
 */

/** A mergeable top-level repo-config section. */
export interface RepoMergeField {
  /** Stable field key (top-level repo config section or `review.*` leaf). */
  key: string;
  /** Extract the section value from a loaded repo config (undefined when absent). */
  pick: (repoConfig: Record<string, unknown>) => unknown;
}

/** Read a nested path (`a.b.c`) from an object. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Single table of every repo-config section merged into the base config.
 * Add new sections here exactly once — the presence guard and merge body
 * both derive from this table.
 */
export const REPO_CONFIG_MERGE_FIELDS: readonly RepoMergeField[] = [
  { key: 'review.sensitivity', pick: (c) => getPath(c, 'review.sensitivity') },
  { key: 'review.categories', pick: (c) => getPath(c, 'review.categories') },
  { key: 'review.enableCodebaseIndex', pick: (c) => getPath(c, 'review.enableCodebaseIndex') },
  {
    key: 'review.enableMetaVerification',
    pick: (c) => getPath(c, 'review.enableMetaVerification'),
  },
  {
    key: 'review.enableTestGapDetection',
    pick: (c) => getPath(c, 'review.enableTestGapDetection'),
  },
  { key: 'review.suppressLowConfidence', pick: (c) => getPath(c, 'review.suppressLowConfidence') },
  { key: 'review.failOnSeverity', pick: (c) => getPath(c, 'review.failOnSeverity') },
  { key: 'review.suggestTitleAndLabels', pick: (c) => getPath(c, 'review.suggestTitleAndLabels') },
  { key: 'review.streamComments', pick: (c) => getPath(c, 'review.streamComments') },
  { key: 'review.streamBatchSize', pick: (c) => getPath(c, 'review.streamBatchSize') },
  { key: 'review.pathInstructions', pick: (c) => getPath(c, 'review.pathInstructions') },
  { key: 'review.showFunctionScores', pick: (c) => getPath(c, 'review.showFunctionScores') },
  {
    key: 'review.enableReviewsArrayInline',
    pick: (c) => getPath(c, 'review.enableReviewsArrayInline'),
  },
  { key: 'review.dedupFingerprints', pick: (c) => getPath(c, 'review.dedupFingerprints') },
  { key: 'review.excludeAgentConfigs', pick: (c) => getPath(c, 'review.excludeAgentConfigs') },
  { key: 'notifications', pick: (c) => c.notifications },
  { key: 'secrets', pick: (c) => c.secrets },
  { key: 'llm', pick: (c) => c.llm },
  { key: 'sca', pick: (c) => c.sca },
  { key: 'changelog', pick: (c) => c.changelog },
  { key: 'describe', pick: (c) => c.describe },
  { key: 'multiAgent', pick: (c) => c.multiAgent },
  { key: 'project.autoLoadAgentsMd', pick: (c) => getPath(c, 'project.autoLoadAgentsMd') },
  { key: 'project.attributionFooter', pick: (c) => getPath(c, 'project.attributionFooter') },
];

/**
 * Whether a loaded repo config carries any merged section.
 * The early-return fast path in `mergeRepoConfig` must call this (not a
 * hand-maintained parallel list) so guard and merge can never diverge.
 *
 * @param repoConfig - Loaded repo config object (or null/undefined).
 * @returns True when at least one merged section is present.
 */
export function hasRepoConfigOverrides(repoConfig: unknown): boolean {
  if (typeof repoConfig !== 'object' || repoConfig === null) return false;
  const cfg = repoConfig as Record<string, unknown>;
  // `dedup_fingerprints` (snake_case) is a legacy alias of
  // `review.dedupFingerprints` — honour it in the guard as well.
  const alias = getPath(cfg, 'review.dedup_fingerprints');
  if (alias !== undefined) return true;
  return REPO_CONFIG_MERGE_FIELDS.some((f) => {
    const v = f.pick(cfg);
    if (v === undefined || v === null) return false;
    if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
  });
}
