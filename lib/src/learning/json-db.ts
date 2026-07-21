import * as fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'path';
import * as core from '@actions/core';

interface FindingRow {
  id: string;
  pr_number: number;
  type: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  created_at: string;
}

interface FeedbackRow {
  id: string;
  finding_id: string;
  signal_type: string;
  signal_value?: string;
  pr_number: number;
  created_at: string;
}

interface ReviewQualityRow {
  id: string;
  pr_number: number;
  actionability_score: number;
  accuracy_score: number;
  coverage_score: number;
  consistency_score: number;
  created_at: string;
}

interface PatternRow {
  id: string;
  pattern_key: string;
  message_cluster: string;
  frequency: number;
  file_types?: string;
  first_seen: string;
  last_seen: string;
}

interface CustomRuleRow {
  id: string;
  rule_text: string;
  source: string;
  status: string;
  approved_at?: string;
}

interface PromptOverrideRow {
  id: string;
  category: string;
  override_text: string;
  false_positive_rate_before?: number;
  created_at: string;
}

interface MetaReviewCounterRow {
  id: number;
  count: number;
}

export interface Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseInstance {
  pragma(sql: string): void;
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
  close(): Promise<void>;
}

type SqlHandlerResult = { changes?: number; rows?: unknown[]; row?: unknown };

export class JsonDatabase implements DatabaseInstance {
  public data: {
    findings: FindingRow[];
    feedback: FeedbackRow[];
    review_quality: ReviewQualityRow[];
    patterns: PatternRow[];
    custom_rules: CustomRuleRow[];
    prompt_overrides: PromptOverrideRow[];
    meta_review_counter: MetaReviewCounterRow[];
  };
  private filePath: string;
  private inTransaction = false;
  private writeTimeout: ReturnType<typeof setTimeout> | null = null;
  private handlers: Array<{
    regex: RegExp;
    handler: (params: unknown[], cleanSql: string) => SqlHandlerResult;
  }>;

  constructor(filePath: string) {
    this.filePath = filePath.endsWith('.db') ? filePath.replace(/\.db$/, '.json') : filePath;
    this.data = {
      findings: [],
      feedback: [],
      review_quality: [],
      patterns: [],
      custom_rules: [],
      prompt_overrides: [],
      meta_review_counter: [],
    };
    this.handlers = this.initHandlers();
    this.load();
    if (this.data.meta_review_counter.length === 0) {
      this.data.meta_review_counter.push({ id: 1, count: 0 });
      this.save();
    }
  }

  private initHandlers(): Array<{
    regex: RegExp;
    handler: (params: unknown[], cleanSql: string) => SqlHandlerResult;
  }> {
    return [
      {
        regex: /^INSERT\s+OR\s+REPLACE\s+INTO\s+findings\b/i,
        handler: (p) => this.handleInsertOrReplaceFindings(p),
      },
      { regex: /^INSERT\s+INTO\s+findings\b/i, handler: (p) => this.handleInsertFindings(p) },
      { regex: /^INSERT\s+INTO\s+feedback\b/i, handler: (p) => this.handleInsertFeedback(p) },
      {
        regex: /^INSERT\s+INTO\s+review_quality\b/i,
        handler: (p) => this.handleInsertReviewQuality(p),
      },
      {
        regex: /^INSERT\s+INTO\s+prompt_overrides\b/i,
        handler: (p) => this.handleInsertPromptOverride(p),
      },
      { regex: /^INSERT\s+INTO\s+custom_rules\b/i, handler: (p) => this.handleInsertCustomRule(p) },
      { regex: /^INSERT\s+INTO\s+patterns\b/i, handler: (p) => this.handleInsertPattern(p) },
      {
        regex:
          /^INSERT\s+INTO\s+meta_review_counter\s*\(id\s*,\s*count\)\s*VALUES\s*\(1\s*,\s*0\)/i,
        handler: () => this.handleInsertMetaReviewCounter(),
      },
      {
        regex: /^DELETE\s+FROM\s+feedback\s+WHERE\s+pr_number\s*=\s*\?/i,
        handler: (p) => this.handleDeleteFeedbackByPr(p),
      },
      {
        regex: /^DELETE\s+FROM\s+findings\s+WHERE\s+pr_number\s*=\s*\?/i,
        handler: (p) => this.handleDeleteFindingsByPr(p),
      },
      {
        regex: /^UPDATE\s+meta_review_counter\s+SET\s+count\s*=\s*\?\s+WHERE\s+id\s*=\s*1/i,
        handler: (p) => this.handleUpdateMetaReviewCounter(p),
      },
      {
        regex: /^UPDATE\s+meta_review_counter\s+SET\s+count\s*=\s*0\s+WHERE\s+id\s*=\s*1/i,
        handler: () => this.handleResetMetaReviewCounter(),
      },
      {
        regex: /^UPDATE\s+custom_rules\s+SET\s+status\s*=\s*'active'\s*,\s*approved_at/i,
        handler: (p) => this.handleApproveCustomRule(p),
      },
      {
        regex: /^UPDATE\s+custom_rules\s+SET\s+status\s*=\s*'declined'\s+WHERE\s+id\s*=\s*\?/i,
        handler: (p) => this.handleDeclineCustomRule(p),
      },
      {
        regex: /^UPDATE\s+patterns\s+SET\s+frequency\b/i,
        handler: (p) => this.handleUpdatePattern(p),
      },
      {
        regex: /^SELECT\s+count\s+FROM\s+meta_review_counter\s+WHERE\s+id\s*=\s*1/i,
        handler: () => this.handleGetMetaReviewCounter(),
      },
      {
        regex:
          /^SELECT\s+COUNT\(\*\)\s+(?:as\s+)?count\s+FROM\s+feedback\s+WHERE\s+signal_type\s+IN\s*\(\s*'dismissed'\s*,\s*'disputed_comment'\s*\)/i,
        handler: () => this.handleGetDisputedFeedbackCount(),
      },
      {
        regex: /^SELECT\s+COUNT\(\*\)\s+(?:as\s+)?count\s+FROM\s+feedback\b/i,
        handler: () => this.handleGetFeedbackCount(),
      },
      {
        regex: /^SELECT\s+id\s*,\s*frequency\s+FROM\s+patterns\s+WHERE\s+pattern_key\s*=\s*\?/i,
        handler: (p) => this.handleGetPatternByKey(p),
      },
      {
        regex: /\bFROM\s+findings\s+WHERE\s+id\s*=\s*\?/i,
        handler: (p) => this.handleGetFindingById(p),
      },
      {
        regex: /\bFROM\s+findings\s+WHERE\s+type\s*=\s*\?/i,
        handler: (p) => this.handleGetFindingsByType(p),
      },
      {
        regex: /\bFROM\s+findings\s+WHERE\s+pr_number\s*=\s*\?/i,
        handler: (p) => this.handleGetFindingsByPr(p),
      },
      {
        regex: /\bFROM\s+findings\s+ORDER\s+BY\s+created_at\s+DESC\s+LIMIT\s*\?/i,
        handler: (p) => this.handleGetAllFindingsLimited(p),
      },
      { regex: /^SELECT\s+\*\s+FROM\s+findings\b/i, handler: (p) => this.handleGetAllFindings(p) },
      {
        regex: /\bFROM\s+custom_rules\s+WHERE\s+status\s*=\s*'active'/i,
        handler: () => this.handleGetActiveCustomRules(),
      },
      {
        regex: /\bFROM\s+prompt_overrides\s+WHERE\s+category\s*=\s*'general'/i,
        handler: () => this.handleGetPromptOverridesGeneral(),
      },
      {
        regex: /\bFROM\s+prompt_overrides\s+WHERE\s+category\s*=\s*\?/i,
        handler: (p) => this.handleGetPromptOverridesByCategory(p),
      },
      {
        regex: /\bFROM\s+prompt_overrides\s+WHERE\s+category\s+IN\s*\(/i,
        handler: (p) => this.handleGetPromptOverridesByCategories(p),
      },
      { regex: /\bFROM\s+review_quality\b/i, handler: (p) => this.handleGetReviewQuality(p) },
      {
        regex: /\bFROM\s+patterns\s+WHERE\s+frequency\s*>=\s*\?/i,
        handler: (p) => this.handleGetPatternsByFrequency(p),
      },
      {
        regex: /\bFROM\s+custom_rules\s+WHERE\s+status\s*=\s*'pending'/i,
        handler: () => this.handleGetPendingCustomRules(),
      },
      {
        regex: /^SELECT\s+message\s*,\s*file\s+FROM\s+findings\b/i,
        handler: (p) => this.handleGetFindingMessages(p),
      },
    ];
  }

  private findHandler(
    cleanSql: string,
  ): ((params: unknown[], cleanSql: string) => SqlHandlerResult) | null {
    for (const { regex, handler } of this.handlers) {
      if (regex.test(cleanSql)) {
        return handler;
      }
    }
    return null;
  }

  private handleInsertOrReplaceFindings(params: unknown[]): SqlHandlerResult {
    const rowSize = 8;
    let changes = 0;
    for (let i = 0; i < params.length; i += rowSize) {
      const [id, pr_number, type, severity, file, line, message, suggestion] = params.slice(
        i,
        i + rowSize,
      );
      const idx = this.data.findings.findIndex((f) => f.id === id);
      const entry = {
        id: id as string,
        pr_number: pr_number as number,
        type: type as string,
        severity: severity as string | undefined,
        file: file as string | undefined,
        line: line as number | undefined,
        message: message as string,
        suggestion: suggestion as string | undefined,
        created_at: new Date().toISOString(),
      };
      if (idx >= 0) {
        this.data.findings[idx] = entry;
      } else {
        this.data.findings.push(entry);
      }
      changes++;
    }
    return { changes };
  }

  private handleInsertFindings(params: unknown[]): SqlHandlerResult {
    return this.handleInsertOrReplaceFindings(params);
  }

  private handleInsertFeedback(params: unknown[]): SqlHandlerResult {
    const rowSize = 5;
    let changes = 0;
    for (let i = 0; i < params.length; i += rowSize) {
      const [id, finding_id, signal_type, signal_value, pr_number] = params.slice(i, i + rowSize);
      this.data.feedback.push({
        id: id as string,
        finding_id: finding_id as string,
        signal_type: signal_type as string,
        signal_value: signal_value as string | undefined,
        pr_number: pr_number as number,
        created_at: new Date().toISOString(),
      });
      changes++;
    }
    return { changes };
  }

  private handleInsertReviewQuality(params: unknown[]): SqlHandlerResult {
    const [id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score] =
      params;
    this.data.review_quality.push({
      id: id as string,
      pr_number: pr_number as number,
      actionability_score: actionability_score as number,
      accuracy_score: accuracy_score as number,
      coverage_score: coverage_score as number,
      consistency_score: consistency_score as number,
      created_at: new Date().toISOString(),
    });
    return { changes: 1 };
  }

  private handleInsertPromptOverride(params: unknown[]): SqlHandlerResult {
    const [id, category, override_text, false_positive_rate_before] = params;
    this.data.prompt_overrides.push({
      id: id as string,
      category: category as string,
      override_text: override_text as string,
      false_positive_rate_before: false_positive_rate_before as number | undefined,
      created_at: new Date().toISOString(),
    });
    return { changes: 1 };
  }

  private handleInsertCustomRule(params: unknown[]): SqlHandlerResult {
    const [id, rule_text, source, status] = params;
    this.data.custom_rules.push({
      id: id as string,
      rule_text: rule_text as string,
      source: source as string,
      status: status as string,
    });
    return { changes: 1 };
  }

  private handleInsertPattern(params: unknown[]): SqlHandlerResult {
    const [id, pattern_key, message_cluster, frequency, file_types] = params;
    this.data.patterns.push({
      id: id as string,
      pattern_key: pattern_key as string,
      message_cluster: message_cluster as string,
      frequency: frequency as number,
      file_types: file_types as string | undefined,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    });
    return { changes: 1 };
  }

  private handleInsertMetaReviewCounter(): SqlHandlerResult {
    const entry = this.data.meta_review_counter.find((x) => x.id === 1);
    if (!entry) {
      this.data.meta_review_counter.push({ id: 1, count: 0 });
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  private handleDeleteFeedbackByPr(params: unknown[]): SqlHandlerResult {
    const prNumber = params[0] as number;
    const initialLength = this.data.feedback.length;
    this.data.feedback = this.data.feedback.filter((f) => f.pr_number !== prNumber);
    return { changes: initialLength - this.data.feedback.length };
  }

  private handleDeleteFindingsByPr(params: unknown[]): SqlHandlerResult {
    const prNumber = params[0] as number;
    const initialLength = this.data.findings.length;
    this.data.findings = this.data.findings.filter((f) => f.pr_number !== prNumber);
    return { changes: initialLength - this.data.findings.length };
  }

  private handleUpdateMetaReviewCounter(params: unknown[]): SqlHandlerResult {
    const count = params[0] as number;
    const entry = this.data.meta_review_counter.find((x) => x.id === 1);
    if (entry) {
      entry.count = count;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  private handleResetMetaReviewCounter(): SqlHandlerResult {
    const entry = this.data.meta_review_counter.find((x) => x.id === 1);
    if (entry) {
      entry.count = 0;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  private handleApproveCustomRule(params: unknown[]): SqlHandlerResult {
    const id = params[0] as string;
    const entry = this.data.custom_rules.find((x) => x.id === id);
    if (entry) {
      entry.status = 'active';
      entry.approved_at = new Date().toISOString();
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  private handleDeclineCustomRule(params: unknown[]): SqlHandlerResult {
    const id = params[0] as string;
    const entry = this.data.custom_rules.find((x) => x.id === id);
    if (entry) {
      entry.status = 'declined';
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  private handleUpdatePattern(params: unknown[]): SqlHandlerResult {
    const [frequency, file_types, pattern_key] = params;
    const entry = this.data.patterns.find((x) => x.pattern_key === (pattern_key as string));
    if (entry) {
      entry.frequency = frequency as number;
      entry.last_seen = new Date().toISOString();
      entry.file_types = file_types as string | undefined;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  private handleGetMetaReviewCounter(): SqlHandlerResult {
    return { row: this.data.meta_review_counter.find((x) => x.id === 1) };
  }

  private handleGetFeedbackCount(): SqlHandlerResult {
    return { row: { count: this.data.feedback.length } };
  }

  private handleGetDisputedFeedbackCount(): SqlHandlerResult {
    const count = this.data.feedback.filter((f) =>
      ['dismissed', 'disputed_comment'].includes(f.signal_type),
    ).length;
    return { row: { count } };
  }

  private handleGetPatternByKey(params: unknown[]): SqlHandlerResult {
    const pattern_key = params[0] as string;
    const found = this.data.patterns.find((x) => x.pattern_key === pattern_key);
    return found ? { row: { id: found.id, frequency: found.frequency } } : { row: undefined };
  }

  private handleGetFindingById(params: unknown[]): SqlHandlerResult {
    const id = params[0] as string;
    return { row: this.data.findings.find((f) => f.id === id) };
  }

  private handleGetFindingsByType(params: unknown[]): SqlHandlerResult {
    const [type, limit] = params;
    return {
      rows: this.data.findings
        .filter((f) => f.type === (type as string))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit as number | undefined),
    };
  }

  private handleGetFindingsByPr(params: unknown[]): SqlHandlerResult {
    const [prNumber, limit] = params;
    return {
      rows: this.data.findings
        .filter((f) => f.pr_number === (prNumber as number))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit as number | undefined),
    };
  }

  private handleGetAllFindings(params: unknown[]): SqlHandlerResult {
    const limit = params[0] as number | undefined;
    return {
      rows: this.data.findings
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit),
    };
  }

  private handleGetAllFindingsLimited(params: unknown[]): SqlHandlerResult {
    return this.handleGetAllFindings(params);
  }

  private handleGetActiveCustomRules(): SqlHandlerResult {
    return { rows: this.data.custom_rules.filter((r) => r.status === 'active') };
  }

  private handleGetPromptOverridesGeneral(): SqlHandlerResult {
    return { rows: this.data.prompt_overrides.filter((o) => o.category === 'general') };
  }

  private handleGetPromptOverridesByCategory(params: unknown[]): SqlHandlerResult {
    const cat = params[0] as string;
    return { rows: this.data.prompt_overrides.filter((o) => o.category === cat) };
  }

  private handleGetPromptOverridesByCategories(params: unknown[]): SqlHandlerResult {
    const categories = params as string[];
    return { rows: this.data.prompt_overrides.filter((o) => categories.includes(o.category)) };
  }

  private handleGetReviewQuality(params: unknown[]): SqlHandlerResult {
    const limit = params[0] as number | undefined;
    return {
      rows: this.data.review_quality
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit),
    };
  }

  private handleGetPatternsByFrequency(params: unknown[]): SqlHandlerResult {
    const minFrequency = params[0] as number;
    return {
      rows: this.data.patterns
        .filter((p) => p.frequency >= minFrequency)
        .sort((a, b) => b.frequency - a.frequency),
    };
  }

  private handleGetPendingCustomRules(): SqlHandlerResult {
    return { rows: this.data.custom_rules.filter((r) => r.status === 'pending') };
  }

  private handleGetFindingMessages(params: unknown[]): SqlHandlerResult {
    const limit = params[0] as number | undefined;
    return {
      rows: this.data.findings
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((f) => ({ message: f.message, file: f.file })),
    };
  }

  private load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(content);
      } catch {
        core.warning('Failed to parse JSON database, starting with empty data');
      }
    }
  }

  public save() {
    if (this.inTransaction) return;
    if (this.writeTimeout) clearTimeout(this.writeTimeout);
    this.writeTimeout = setTimeout(() => {
      this.writeTimeout = null;
      this.writeToDisk();
    }, 100);
  }

  private async writeToDisk() {
    try {
      const dir = path.dirname(this.filePath);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(this.filePath, JSON.stringify(this.data), 'utf-8');
    } catch (err) {
      console.warn(`Failed to save JSON database: ${err instanceof Error ? err.message : err}`);
    }
  }

  pragma(_sql: string): void {}

  exec(sql: string): void {
    if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
      return;
    }
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const self = this;
    const wrapper: (...args: unknown[]) => unknown = function (this: unknown, ...args: unknown[]) {
      const backup = JSON.stringify(self.data);
      self.inTransaction = true;
      try {
        const res = fn.apply(this, args);
        if (res instanceof Promise) {
          return res
            .then((result) => {
              self.inTransaction = false;
              self.save();
              return result;
            })
            .catch((err) => {
              self.inTransaction = false;
              self.data = JSON.parse(backup);
              self.save();
              throw err;
            });
        }
        self.inTransaction = false;
        self.save();
        return res;
      } catch (err) {
        self.inTransaction = false;
        self.data = JSON.parse(backup);
        self.save();
        throw err;
      }
    };
    return wrapper as T;
  }

  async close(): Promise<void> {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    try {
      const dir = path.dirname(this.filePath);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(this.filePath, JSON.stringify(this.data), 'utf-8');
    } catch (err) {
      console.warn(`Failed to save JSON database: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Execute a SQL operation via structured dispatch using regex-based
   * handler matching. This is the primary public API for running SQL
   * against the in-memory JSON store.
   */
  dispatch(
    sql: string,
    params: unknown[] = [],
  ): { changes?: number; rows?: unknown[]; row?: unknown } {
    const cleanSql = sql.trim().replace(/\s+/g, ' ');
    const handler = this.findHandler(cleanSql);
    if (!handler) {
      throw new Error(`Unrecognized SQL statement: ${cleanSql.substring(0, 120)}`);
    }
    const result = handler(params, cleanSql);
    if (result.changes !== undefined && result.changes > 0 && !this.inTransaction) {
      this.save();
    }
    return result;
  }

  /** @deprecated Use dispatch() instead. */
  handleSql(
    sql: string,
    params: unknown[] = [],
  ): { changes?: number; rows?: unknown[]; row?: unknown } {
    return this.dispatch(sql, params);
  }

  prepare(sql: string): Statement {
    const self = this;
    const cleanSql = sql.trim().replace(/\s+/g, ' ');

    return {
      run(...params: unknown[]): { changes: number } {
        const handler = self.findHandler(cleanSql);
        if (!handler) {
          throw new Error(`Unrecognized SQL statement: ${cleanSql.substring(0, 120)}`);
        }
        const result = handler(params, cleanSql);
        if (!self.inTransaction) {
          self.save();
        }
        return { changes: result.changes ?? 0 };
      },

      get(...params: unknown[]): unknown {
        const handler = self.findHandler(cleanSql);
        if (!handler) {
          throw new Error(`Unrecognized SQL statement: ${cleanSql.substring(0, 120)}`);
        }
        const result = handler(params, cleanSql);
        return result.row !== undefined ? result.row : result.rows?.[0];
      },

      all(...params: unknown[]): unknown[] {
        const handler = self.findHandler(cleanSql);
        if (!handler) {
          throw new Error(`Unrecognized SQL statement: ${cleanSql.substring(0, 120)}`);
        }
        const result = handler(params, cleanSql);
        return result.rows ?? [];
      },
    };
  }
}
