/**
 * Shared database row shapes used by both the SQL and JSON-file learning
 * backends. Kept in their own module (rather than `json-db.ts`) so the row
 * types are owned by a neutral location that neither backend depends on,
 * avoiding a circular import between `learning/types.ts` and `json-db.ts`.
 */

/** Database row for a code review finding. */
export interface FindingRow {
  id: string;
  pr_number: number;
  type: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  duration_ms?: number;
  tokens_used?: number;
  comment_id?: number;
  created_at: string;
}

/** Database row for review quality metrics. */
export interface ReviewQualityRow {
  id: string;
  pr_number: number;
  actionability_score: number;
  accuracy_score: number;
  coverage_score: number;
  consistency_score: number;
  duration_ms?: number;
  tokens_used?: number;
  created_at: string;
}

/** Database row for a detected pattern. */
export interface PatternRow {
  id: string;
  pattern_key: string;
  message_cluster: string;
  frequency: number;
  file_types?: string;
  first_seen: string;
  last_seen: string;
}

/** Database row for a custom review rule. */
export interface CustomRuleRow {
  id: string;
  rule_text: string;
  source: string;
  status: string;
  approved_at?: string;
}

/** Lifecycle status of a generated suppression rule. */
export type SuppressionRuleStatus = 'active' | 'expired';

/** Database row for a generated suppression rule. */
export interface SuppressionRuleRow {
  id: string;
  pattern_key: string;
  message: string;
  file_types?: string | null;
  dismissal_count: number;
  status: SuppressionRuleStatus;
  created_at: string;
  last_active_at?: string | null;
  expires_at?: string | null;
  reviews_seen: number;
  suppression_hits: number;
}
