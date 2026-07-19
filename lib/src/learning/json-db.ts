import * as fs from 'fs';
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
  close(): void;
}

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
    this.load();
    if (this.data.meta_review_counter.length === 0) {
      this.data.meta_review_counter.push({ id: 1, count: 0 });
      this.save();
    }
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
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`Failed to save JSON database: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  pragma(_sql: string): void {}

  exec(sql: string): void {
    // Migration helper
    if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
      // Tables are already initialized in constructor
      return;
    }
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const self = this;
    return function (this: unknown, ...args: unknown[]) {
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
    } as unknown as T;
  }

  close(): void {
    this.save();
  }

  prepare(sql: string): Statement {
    const self = this;
    const cleanSql = sql.trim().replace(/\s+/g, ' ');

    return {
      run(...params: unknown[]): { changes: number } {
        let changes = 0;
        if (
          cleanSql.startsWith('INSERT OR REPLACE INTO findings') ||
          cleanSql.startsWith('INSERT INTO findings')
        ) {
          const rowSize = 8;
          for (let i = 0; i < params.length; i += rowSize) {
            const [id, pr_number, type, severity, file, line, message, suggestion] = params.slice(
              i,
              i + rowSize,
            );
            const idx = self.data.findings.findIndex((f) => f.id === id);
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
              self.data.findings[idx] = entry;
            } else {
              self.data.findings.push(entry);
            }
            changes++;
          }
        } else if (cleanSql.startsWith('INSERT INTO feedback')) {
          const rowSize = 5;
          for (let i = 0; i < params.length; i += rowSize) {
            const [id, finding_id, signal_type, signal_value, pr_number] = params.slice(
              i,
              i + rowSize,
            );
            self.data.feedback.push({
              id: id as string,
              finding_id: finding_id as string,
              signal_type: signal_type as string,
              signal_value: signal_value as string | undefined,
              pr_number: pr_number as number,
              created_at: new Date().toISOString(),
            });
            changes++;
          }
        } else if (cleanSql.startsWith('INSERT INTO review_quality')) {
          const [
            id,
            pr_number,
            actionability_score,
            accuracy_score,
            coverage_score,
            consistency_score,
          ] = params;
          self.data.review_quality.push({
            id: id as string,
            pr_number: pr_number as number,
            actionability_score: actionability_score as number,
            accuracy_score: accuracy_score as number,
            coverage_score: coverage_score as number,
            consistency_score: consistency_score as number,
            created_at: new Date().toISOString(),
          });
          changes = 1;
        } else if (cleanSql.startsWith('INSERT INTO prompt_overrides')) {
          const [id, category, override_text, false_positive_rate_before] = params;
          self.data.prompt_overrides.push({
            id: id as string,
            category: category as string,
            override_text: override_text as string,
            false_positive_rate_before: false_positive_rate_before as number | undefined,
            created_at: new Date().toISOString(),
          });
          changes = 1;
        } else if (cleanSql.startsWith('INSERT INTO custom_rules')) {
          const [id, rule_text, source, status] = params;
          self.data.custom_rules.push({
            id: id as string,
            rule_text: rule_text as string,
            source: source as string,
            status: status as string,
          });
          changes = 1;
        } else if (cleanSql.startsWith('DELETE FROM feedback WHERE pr_number = ?')) {
          const prNumber = params[0] as number;
          const initialLength = self.data.feedback.length;
          self.data.feedback = self.data.feedback.filter((f) => f.pr_number !== prNumber);
          changes = initialLength - self.data.feedback.length;
        } else if (cleanSql.startsWith('DELETE FROM findings WHERE pr_number = ?')) {
          const prNumber = params[0] as number;
          const initialLength = self.data.findings.length;
          self.data.findings = self.data.findings.filter((f) => f.pr_number !== prNumber);
          changes = initialLength - self.data.findings.length;
        } else if (cleanSql.startsWith('UPDATE meta_review_counter SET count = ? WHERE id = 1')) {
          const count = params[0] as number;
          const entry = self.data.meta_review_counter.find((x) => x.id === 1);
          if (entry) {
            entry.count = count;
            changes = 1;
          }
        } else if (cleanSql.startsWith('UPDATE meta_review_counter SET count = 0 WHERE id = 1')) {
          const entry = self.data.meta_review_counter.find((x) => x.id === 1);
          if (entry) {
            entry.count = 0;
            changes = 1;
          }
        } else if (
          cleanSql.startsWith("UPDATE custom_rules SET status = 'active', approved_at =") ||
          cleanSql.includes("status = 'active', approved_at = datetime('now')")
        ) {
          const id = params[0] as string;
          const entry = self.data.custom_rules.find((x) => x.id === id);
          if (entry) {
            entry.status = 'active';
            entry.approved_at = new Date().toISOString();
            changes = 1;
          }
        } else if (
          cleanSql.startsWith("UPDATE custom_rules SET status = 'declined' WHERE id = ?")
        ) {
          const id = params[0] as string;
          const entry = self.data.custom_rules.find((x) => x.id === id);
          if (entry) {
            entry.status = 'declined';
            changes = 1;
          }
        } else if (
          cleanSql.startsWith(
            "UPDATE patterns SET frequency = ?, last_seen = datetime('now'), file_types = ? WHERE pattern_key = ?",
          ) ||
          cleanSql.includes('UPDATE patterns SET frequency = ?')
        ) {
          const [frequency, file_types, pattern_key] = params;
          const entry = self.data.patterns.find((x) => x.pattern_key === (pattern_key as string));
          if (entry) {
            entry.frequency = frequency as number;
            entry.last_seen = new Date().toISOString();
            entry.file_types = file_types as string | undefined;
            changes = 1;
          }
        } else if (cleanSql.startsWith('INSERT INTO patterns')) {
          const [id, pattern_key, message_cluster, frequency, file_types] = params;
          self.data.patterns.push({
            id: id as string,
            pattern_key: pattern_key as string,
            message_cluster: message_cluster as string,
            frequency: frequency as number,
            file_types: file_types as string | undefined,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
          });
          changes = 1;
        } else if (
          cleanSql.startsWith('INSERT INTO meta_review_counter (id, count) VALUES (1, 0)')
        ) {
          const entry = self.data.meta_review_counter.find((x) => x.id === 1);
          if (!entry) {
            self.data.meta_review_counter.push({ id: 1, count: 0 });
            changes = 1;
          }
        }

        if (!self.inTransaction) {
          self.save();
        }
        return { changes };
      },

      get(...params: unknown[]): unknown {
        if (cleanSql.startsWith('SELECT count FROM meta_review_counter WHERE id = 1')) {
          return self.data.meta_review_counter.find((x) => x.id === 1);
        }
        if (cleanSql.includes("feedback WHERE signal_type IN ('dismissed', 'disputed_comment')")) {
          const count = self.data.feedback.filter((f) =>
            ['dismissed', 'disputed_comment'].includes(f.signal_type),
          ).length;
          return { count };
        }
        if (
          cleanSql.startsWith('SELECT COUNT(*) as count FROM feedback') ||
          cleanSql.includes('COUNT(*) as count FROM feedback')
        ) {
          return { count: self.data.feedback.length };
        }
        if (
          cleanSql.startsWith('SELECT id, frequency FROM patterns WHERE pattern_key = ?') ||
          cleanSql.includes('patterns WHERE pattern_key = ?')
        ) {
          const pattern_key = params[0] as string;
          const found = self.data.patterns.find((x) => x.pattern_key === pattern_key);
          return found ? { id: found.id, frequency: found.frequency } : undefined;
        }
        return undefined;
      },

      all(...params: unknown[]): unknown[] {
        if (cleanSql.includes('FROM findings WHERE type = ?')) {
          const [type, limit] = params;
          return self.data.findings
            .filter((f) => f.type === (type as string))
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limit as number | undefined);
        }
        if (cleanSql.includes('FROM findings WHERE pr_number = ?')) {
          const [prNumber, limit] = params;
          return self.data.findings
            .filter((f) => f.pr_number === (prNumber as number))
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limit as number | undefined);
        }
        if (cleanSql.startsWith('SELECT * FROM findings') || cleanSql.includes('FROM findings')) {
          const limit = params[0] as number | undefined;
          return self.data.findings
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limit);
        }
        if (cleanSql.includes("custom_rules WHERE status = 'active'")) {
          return self.data.custom_rules.filter((r) => r.status === 'active');
        }
        if (cleanSql.includes("prompt_overrides WHERE category = 'general'")) {
          return self.data.prompt_overrides.filter((o) => o.category === 'general');
        }
        if (cleanSql.includes('prompt_overrides WHERE category = ?')) {
          const cat = params[0] as string;
          return self.data.prompt_overrides.filter((o) => o.category === cat);
        }
        if (cleanSql.includes('FROM review_quality')) {
          const limit = params[0] as number | undefined;
          return self.data.review_quality
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limit);
        }
        if (cleanSql.includes('FROM patterns WHERE frequency >= ?')) {
          const minFrequency = params[0] as number;
          return self.data.patterns
            .filter((p) => p.frequency >= minFrequency)
            .sort((a, b) => b.frequency - a.frequency);
        }
        if (cleanSql.includes("custom_rules WHERE status = 'pending'")) {
          return self.data.custom_rules.filter((r) => r.status === 'pending');
        }
        return [];
      },
    };
  }
}
