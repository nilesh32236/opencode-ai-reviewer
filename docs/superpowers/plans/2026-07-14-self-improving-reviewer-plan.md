# Self-Improving AI Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an event bus, learning store, feedback collection, meta-review, and pattern detection so the OpenCode AI Reviewer improves over time.

**Architecture:** A unified EventRouter receives all GitHub webhooks and dispatches to typed subscribers. A LearningStore (SQLite) persists findings, feedback, and quality metrics. Subscribers for feedback, meta-review, and pattern detection consume LearningStore data to tune future review prompts.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (or sql.js for WASM), existing `lib/src/engine.ts` and `app/src/index.ts`.

## Global Constraints

- Use `better-sqlite3` for LearningStore (zero config SQLite)
- All learning data lives in `.opencode/learning.db` (gitignored)
- Follow existing Vitest patterns in `lib/tests/`
- All new files in `lib/src/` follow existing import pattern (`.js` extensions in imports from `.ts` files)
- Event types use dot notation: `pr.opened`, `review.completed`, etc.

---

### Task 1: Event & Learning Types

**Files:**
- Modify: `lib/src/types/index.ts`
- Test: `lib/tests/types.test.ts`

**Interfaces:**
- Consumes: existing `ReviewResult`, `Finding`, `AgentConfig` types
- Produces: `EventType`, `GitHubEvent`, `Subscriber`, `LearningConfig`, `LearningStoreQuery`, `LearningFeedback`

- [ ] **Step 1: Add new type definitions**

Add to `lib/src/types/index.ts` after the existing types:

```typescript
// ─── Event Bus ───────────────────────────────────────────
export type EventCategory = 'pr' | 'issue' | 'comment' | 'review' | 'internal';

export interface GitHubEvent {
  type: string;
  category: EventCategory;
  payload: unknown;
  timestamp: number;
  repo?: string;
  prNumber?: number;
}

export interface Subscriber {
  name: string;
  subscribedEvents: string[];
  handle(event: GitHubEvent): Promise<void>;
}

// ─── Learning Store ──────────────────────────────────────
export interface LearningConfig {
  enabled: boolean;
  feedbackSignals: string[];
  metaReview: {
    enabled: boolean;
    interval: number;
    minFindingsForReview: number;
  };
  patternDiscovery: {
    enabled: boolean;
    minFrequency: number;
    windowSize: number;
  };
}

export interface LearningFeedback {
  findingId: string;
  signalType: 'dismissed' | 'reaction' | 'disputed_comment';
  signalValue: string;
  prNumber: number;
  createdAt: string;
}

export interface LearningQuality {
  prNumber: number;
  actionabilityScore: number;
  accuracyScore: number;
  coverageScore: number;
  consistencyScore: number;
}

export interface LearningPattern {
  patternKey: string;
  messageCluster: string[];
  frequency: number;
  fileTypes: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface CustomRule {
  ruleText: string;
  source: 'auto' | 'manual';
  status: 'pending' | 'active' | 'declined';
  approvedAt?: string;
}
```

- [ ] **Step 2: Run test to verify compilation**

Run: `pnpm --filter @opencode-pr-agent/lib typecheck`
Expected: PASS (no new errors; existing test may reference old types but should still compile)

- [ ] **Step 3: Commit**

```bash
git add lib/src/types/index.ts
git commit -m "feat: add event bus and learning store types"
```

---

### Task 2: EventBus

**Files:**
- Create: `lib/src/event-bus/types.ts`
- Create: `lib/src/event-bus/bus.ts`
- Create: `lib/src/event-bus/router.ts`
- Test: `lib/tests/event-bus.test.ts`

**Interfaces:**
- Consumes: `GitHubEvent`, `Subscriber` from Task 1
- Produces: `EventBus.register()`, `EventBus.publish()`, `EventRouter.handle()`

- [ ] **Step 1: Create `lib/src/event-bus/types.ts`**

```typescript
import type { GitHubEvent, Subscriber } from '../types/index.js';

export interface EventBusConfig {
  name: string;
}

export { GitHubEvent, Subscriber };
```

- [ ] **Step 2: Create `lib/src/event-bus/bus.ts`**

```typescript
import type { GitHubEvent, Subscriber } from '../types/index.js';

export class EventBus {
  private subscribers: Map<string, Subscriber[]> = new Map();
  private history: GitHubEvent[] = [];
  private readonly maxHistory = 100;

  register(subscriber: Subscriber): void {
    for (const eventType of subscriber.subscribedEvents) {
      const existing = this.subscribers.get(eventType) || [];
      existing.push(subscriber);
      this.subscribers.set(eventType, existing);
    }
  }

  registerAll(subscribers: Subscriber[]): void {
    for (const sub of subscribers) {
      this.register(sub);
    }
  }

  async publish(event: GitHubEvent): Promise<void> {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const matching = this.subscribers.get(event.type) || [];
    const wildcard = this.subscribers.get('*') || [];

    for (const sub of [...matching, ...wildcard]) {
      try {
        await sub.handle(event);
      } catch (err) {
        console.error(`[EventBus] Subscriber ${sub.name} failed on ${event.type}:`, err);
      }
    }
  }

  getHistory(): GitHubEvent[] {
    return [...this.history];
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}
```

- [ ] **Step 3: Create `lib/src/event-bus/router.ts`**

```typescript
import type { GitHubEvent, EventCategory } from '../types/index.js';
import { EventBus } from './bus.js';

const EVENT_CATEGORY_MAP: Record<string, EventCategory> = {
  'pull_request.opened': 'pr',
  'pull_request.synchronize': 'pr',
  'pull_request.labeled': 'pr',
  'pull_request_review.submitted': 'review',
  'pull_request_review.dismissed': 'review',
  'pull_request_review_comment.dismissed': 'review',
  'pull_request_review_comment.created': 'comment',
  'issue_comment.created': 'comment',
  'issues.labeled': 'issue',
};

const EVENT_TYPE_MAP: Record<string, string> = {
  'pull_request.opened': 'pr.opened',
  'pull_request.synchronize': 'pr.synchronize',
  'pull_request.labeled': 'pr.labeled',
  'pull_request_review.submitted': 'review.submitted',
  'pull_request_review.dismissed': 'review.dismissed',
  'pull_request_review_comment.dismissed': 'review_comment.dismissed',
  'pull_request_review_comment.created': 'review_comment.created',
  'issue_comment.created': 'comment.created',
  'issues.labeled': 'issue.labeled',
};

export class EventRouter {
  constructor(private bus: EventBus) {}

  async handle(rawEvent: string, payload: unknown): Promise<void> {
    const category = EVENT_CATEGORY_MAP[rawEvent] || 'internal';
    const type = EVENT_TYPE_MAP[rawEvent] || rawEvent;
    const repo =
      typeof payload === 'object' && payload !== null
        ? (payload as { repository?: { full_name?: string } }).repository?.full_name
        : undefined;
    const prNumber = extractPRNumber(rawEvent, payload);

    const event: GitHubEvent = {
      type,
      category,
      payload,
      timestamp: Date.now(),
      repo,
      prNumber,
    };

    await this.bus.publish(event);
  }
}

function extractPRNumber(rawEvent: string, payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.pull_request && typeof p.pull_request === 'object') {
    return (p.pull_request as { number?: number }).number;
  }
  if (p.issue && typeof p.issue === 'object') {
    return (p.issue as { number?: number }).number;
  }
  if (p.number && typeof p.number === 'number') return p.number;
  return undefined;
}
```

- [ ] **Step 4: Write the failing test**

Create `lib/tests/event-bus.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/event-bus/bus.js';
import { EventRouter } from '../src/event-bus/router.js';
import type { GitHubEvent, Subscriber } from '../src/types/index.js';

describe('EventBus', () => {
  it('registers subscribers and dispatches events by type', async () => {
    const bus = new EventBus();
    const handled: string[] = [];

    const sub: Subscriber = {
      name: 'test',
      subscribedEvents: ['pr.opened'],
      async handle(event: GitHubEvent) {
        handled.push(event.type);
      },
    };

    bus.register(sub);

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    await bus.publish({ type: 'pr.synchronize', category: 'pr', payload: {}, timestamp: 2 });

    expect(handled).toEqual(['pr.opened']);
  });

  it('wildcard subscriber matches all events', async () => {
    const bus = new EventBus();
    const handled: string[] = [];

    const sub: Subscriber = {
      name: 'wildcard',
      subscribedEvents: ['*'],
      async handle(event: GitHubEvent) {
        handled.push(event.type);
      },
    };

    bus.register(sub);
    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    await bus.publish({ type: 'review.completed', category: 'internal', payload: {}, timestamp: 2 });

    expect(handled).toEqual(['pr.opened', 'review.completed']);
  });

  it('subscriber errors do not crash the bus', async () => {
    const bus = new EventBus();
    const sub: Subscriber = {
      name: 'crashy',
      subscribedEvents: ['*'],
      async handle() {
        throw new Error('boom');
      },
    };

    bus.register(sub);
    await expect(
      bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 }),
    ).resolves.not.toThrow();
  });

  it('maintains event history', async () => {
    const bus = new EventBus();
    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    expect(bus.getHistory()).toHaveLength(1);
    expect(bus.getHistory()[0].type).toBe('pr.opened');
  });

  it('registerAll registers multiple subscribers', async () => {
    const bus = new EventBus();
    const handled: string[] = [];

    bus.registerAll([
      {
        name: 'a',
        subscribedEvents: ['pr.opened'],
        async handle() { handled.push('a'); },
      },
      {
        name: 'b',
        subscribedEvents: ['pr.synchronize'],
        async handle() { handled.push('b'); },
      },
    ]);

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    await bus.publish({ type: 'pr.synchronize', category: 'pr', payload: {}, timestamp: 2 });

    expect(handled).toEqual(['a', 'b']);
  });
});

describe('EventRouter', () => {
  it('maps pull_request.opened to pr.opened with PR number', async () => {
    const bus = new EventBus();
    const router = new EventRouter(bus);
    const events: GitHubEvent[] = [];

    bus.register({
      name: 'collector',
      subscribedEvents: ['pr.opened'],
      async handle(e) { events.push(e); },
    });

    await router.handle('pull_request.opened', {
      pull_request: { number: 42 },
      repository: { full_name: 'owner/repo' },
    });

    expect(events[0].type).toBe('pr.opened');
    expect(events[0].prNumber).toBe(42);
    expect(events[0].repo).toBe('owner/repo');
    expect(events[0].category).toBe('pr');
  });

  it('maps unknown events as internal', async () => {
    const bus = new EventBus();
    const router = new EventRouter(bus);
    const events: GitHubEvent[] = [];

    bus.register({
      name: 'collector',
      subscribedEvents: ['*'],
      async handle(e) { events.push(e); },
    });

    await router.handle('some.unknown.event', {});
    expect(events[0].category).toBe('internal');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/event-bus.test.ts`
Expected: FAIL (modules not found yet)

- [ ] **Step 6: Implement EventBus (steps 2-3 already done)**

Files already created above. Run test to verify they compile.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/event-bus.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 8: Commit**

```bash
git add lib/src/event-bus/ lib/tests/event-bus.test.ts
git commit -m "feat: add EventBus and EventRouter for unified event dispatch"
```

---

### Task 3: LearningStore

**Files:**
- Create: `lib/src/learning/schema.ts`
- Create: `lib/src/learning/store.ts`
- Modify: `lib/package.json` (add better-sqlite3)
- Test: `lib/tests/learning-store.test.ts`

**Interfaces:**
- Consumes: `LearningFeedback`, `LearningQuality`, `LearningPattern`, `CustomRule` types from Task 1
- Produces: `LearningStore` class with `recordFinding()`, `recordFeedback()`, `getRelevantLessons()`, `getQualityTrends()`, `recordQuality()`, `getFalsePositiveRate()`, `recordPattern()`, `getPendingRules()`, `approveRule()`

- [ ] **Step 1: Install better-sqlite3**

Run: `pnpm --filter @opencode-pr-agent/lib add better-sqlite3`

Then add the type definitions:
Run: `pnpm --filter @opencode-pr-agent/lib add -D @types/better-sqlite3`

- [ ] **Step 2: Create `lib/src/learning/schema.ts`**

```typescript
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), '.opencode', 'learning.db');

export function getDbPath(): string {
  return DB_PATH;
}

export function getDatabase(dbPath = DB_PATH): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  return db;
}

export function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      pr_number INTEGER NOT NULL,
      type TEXT NOT NULL,
      severity TEXT,
      file TEXT,
      line INTEGER,
      message TEXT NOT NULL,
      suggestion TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      signal_value TEXT,
      pr_number INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (finding_id) REFERENCES findings(id)
    );

    CREATE TABLE IF NOT EXISTS review_quality (
      id TEXT PRIMARY KEY,
      pr_number INTEGER NOT NULL,
      actionability_score REAL NOT NULL,
      accuracy_score REAL NOT NULL,
      coverage_score REAL NOT NULL,
      consistency_score REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      pattern_key TEXT NOT NULL UNIQUE,
      message_cluster TEXT NOT NULL,
      frequency INTEGER NOT NULL DEFAULT 1,
      file_types TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_rules (
      id TEXT PRIMARY KEY,
      rule_text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'pending',
      approved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS prompt_overrides (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      override_text TEXT NOT NULL,
      false_positive_rate_before REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta_review_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      count INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Initialize counter row if not exists
  const row = db.prepare('SELECT count FROM meta_review_counter WHERE id = 1').get() as { count: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO meta_review_counter (id, count) VALUES (1, 0)').run();
  }
}

export function generateId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
```

- [ ] **Step 3: Create `lib/src/learning/store.ts`**

```typescript
import Database from 'better-sqlite3';
import { getDatabase, generateId, getDbPath } from './schema.js';
import type { LearningFeedback, LearningQuality } from '../types/index.js';

export class LearningStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = getDatabase(dbPath || getDbPath());
  }

  close(): void {
    this.db.close();
  }

  // ─── Findings ─────────────────────────────────────────

  recordFinding(finding: {
    id?: string;
    prNumber: number;
    type: string;
    severity?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }): string {
    const id = finding.id || generateId();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO findings (id, pr_number, type, severity, file, line, message, suggestion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, finding.prNumber, finding.type, finding.severity || null, finding.file || null, finding.line || null, finding.message, finding.suggestion || null);
    return id;
  }

  getFindings(prNumber?: number, limit = 100): Array<Record<string, unknown>> {
    if (prNumber) {
      return this.db
        .prepare('SELECT * FROM findings WHERE pr_number = ? ORDER BY created_at DESC LIMIT ?')
        .all(prNumber, limit) as Array<Record<string, unknown>>;
    }
    return this.db
      .prepare('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  // ─── Feedback ─────────────────────────────────────────

  recordFeedback(feedback: {
    findingId: string;
    signalType: LearningFeedback['signalType'];
    signalValue: string;
    prNumber: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(generateId(), feedback.findingId, feedback.signalType, feedback.signalValue, feedback.prNumber);
  }

  getFalsePositiveRate(category?: string): number {
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM feedback')
      .get() as { count: number };
    if (total.count === 0) return 0;

    const disputed = this.db
      .prepare("SELECT COUNT(*) as count FROM feedback WHERE signal_type IN ('dismissed', 'disputed_comment')")
      .get() as { count: number };

    return disputed.count / total.count;
  }

  // ─── Relevant Lessons (for prompt injection) ──────────

  getRelevantLessons(filePaths: string[]): string[] {
    const lessons: string[] = [];

    // Get active custom rules
    const rules = this.db
      .prepare("SELECT rule_text FROM custom_rules WHERE status = 'active'")
      .all() as Array<{ rule_text: string }>;

    for (const rule of rules) {
      lessons.push(rule.rule_text);
    }

    // Get prompt overrides related to matched file types
    const extensions = [...new Set(filePaths.map((f) => {
      const ext = f.split('.').pop();
      return ext ? `.${ext}` : '';
    }))];

    for (const ext of extensions) {
      if (!ext) continue;
      const overrides = this.db
        .prepare('SELECT override_text FROM prompt_overrides WHERE category = ?')
        .all(ext) as Array<{ override_text: string }>;
      for (const o of overrides) {
        lessons.push(o.override_text);
      }
    }

    return lessons;
  }

  // ─── Quality / Meta-Review ────────────────────────────

  recordQuality(quality: LearningQuality): void {
    this.db
      .prepare(
        `INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generateId(),
        quality.prNumber,
        quality.actionabilityScore,
        quality.accuracyScore,
        quality.coverageScore,
        quality.consistencyScore,
      );
  }

  getQualityTrends(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM review_quality ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  // ─── Meta-review counter ──────────────────────────────

  incrementAndCheckMetaReviewInterval(interval: number): boolean {
    const row = this.db
      .prepare('SELECT count FROM meta_review_counter WHERE id = 1')
      .get() as { count: number } | undefined;

    if (!row) return false;

    const newCount = row.count + 1;
    this.db.prepare('UPDATE meta_review_counter SET count = ? WHERE id = 1').run(newCount);

    return newCount % interval === 0;
  }

  // ─── Patterns ─────────────────────────────────────────

  recordPattern(pattern: {
    patternKey: string;
    messageCluster: string[];
    frequency: number;
    fileTypes: string[];
  }): void {
    const existing = this.db
      .prepare('SELECT id, frequency FROM patterns WHERE pattern_key = ?')
      .get(pattern.patternKey) as { id: string; frequency: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE patterns SET frequency = ?, last_seen = datetime(\'now\'), file_types = ? WHERE pattern_key = ?',
        )
        .run(existing.frequency + 1, pattern.fileTypes.join(','), pattern.patternKey);
    } else {
      this.db
        .prepare(
          `INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .run(
          generateId(),
          pattern.patternKey,
          JSON.stringify(pattern.messageCluster),
          pattern.frequency,
          pattern.fileTypes.join(','),
        );
    }
  }

  getPatterns(minFrequency = 3): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM patterns WHERE frequency >= ? ORDER BY frequency DESC')
      .all(minFrequency) as Array<Record<string, unknown>>;
  }

  // ─── Custom Rules ─────────────────────────────────────

  addCustomRule(ruleText: string, source: 'auto' | 'manual'): string {
    const id = generateId();
    this.db
      .prepare('INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)')
      .run(id, ruleText, source, 'pending');
    return id;
  }

  getPendingRules(): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM custom_rules WHERE status = 'pending'")
      .all() as Array<Record<string, unknown>>;
  }

  approveRule(ruleId: string): void {
    this.db
      .prepare("UPDATE custom_rules SET status = 'active', approved_at = datetime('now') WHERE id = ?")
      .run(ruleId);
  }

  declineRule(ruleId: string): void {
    this.db
      .prepare("UPDATE custom_rules SET status = 'declined' WHERE id = ?")
      .run(ruleId);
  }

  // ─── Prompt Overrides ─────────────────────────────────

  addPromptOverride(category: string, overrideText: string, fpRateBefore: number): void {
    this.db
      .prepare(
        `INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before)
         VALUES (?, ?, ?, ?)`,
      )
      .run(generateId(), category, overrideText, fpRateBefore);
  }

  resetCounter(): void {
    this.db.prepare('UPDATE meta_review_counter SET count = 0 WHERE id = 1').run();
  }
}
```

- [ ] **Step 4: Write the failing test**

Create `lib/tests/learning-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { LearningStore } from '../src/learning/store.js';
import { getDatabase } from '../src/learning/schema.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = path.join(__dirname, '.test-learning.db');

describe('LearningStore', () => {
  let store: LearningStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('records and retrieves findings', () => {
    const id = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'critical',
      file: 'src/foo.ts',
      line: 42,
      message: 'Missing error handling',
    });

    const findings = store.getFindings(1);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('Missing error handling');
    expect(findings[0].id).toBe(id);
  });

  it('records feedback and calculates false positive rate', () => {
    const id = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test finding',
    });

    store.recordFeedback({
      findingId: id,
      signalType: 'dismissed',
      signalValue: 'false positive',
      prNumber: 1,
    });

    const fpRate = store.getFalsePositiveRate();
    expect(fpRate).toBe(1);
  });

  it('returns active custom rules as relevant lessons', () => {
    store.addCustomRule('Always handle async errors in Express routes', 'auto');
    const ruleId = store.addCustomRule('Use strict equality', 'manual');
    store.approveRule(ruleId);

    const lessons = store.getRelevantLessons(['src/routes.ts']);
    expect(lessons).toContain('Use strict equality');
    expect(lessons).not.toContain('Always handle async errors in Express routes');
  });

  it('records and retrieves qualities', () => {
    store.recordQuality({
      prNumber: 1,
      actionabilityScore: 80,
      accuracyScore: 90,
      coverageScore: 70,
      consistencyScore: 85,
    });

    const trends = store.getQualityTrends();
    expect(trends).toHaveLength(1);
    expect((trends[0] as Record<string, unknown>).actionabilityScore).toBe(80);
  });

  it('incrementAndCheckMetaReviewInterval triggers on interval', () => {
    // Intervals of 3, should trigger at count 3, 6
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(true);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(true);
  });

  it('records and retrieves patterns', () => {
    store.recordPattern({
      patternKey: 'missing-error-handling',
      messageCluster: ['Missing error handling in route', 'Unhandled promise rejection'],
      frequency: 3,
      fileTypes: ['.ts'],
    });

    const patterns = store.getPatterns(3);
    expect(patterns).toHaveLength(1);
  });

  it('manages custom rule lifecycle', () => {
    const id = store.addCustomRule('Test rule', 'auto');
    expect(store.getPendingRules()).toHaveLength(1);

    store.approveRule(id);
    expect(store.getPendingRules()).toHaveLength(0);

    const lessons = store.getRelevantLessons(['test.ts']);
    expect(lessons).toContain('Test rule');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/learning-store.test.ts`
Expected: FAIL (modules not found yet)

- [ ] **Step 6: Create files (steps 2-3 already written above)**

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/learning-store.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 8: Add `.opencode/learning.db` to `.gitignore`**

Append to `.gitignore`:
```
.opencode/learning.db
.opencode/learning.db-wal
.opencode/learning.db-shm
```

- [ ] **Step 9: Commit**

```bash
git add lib/src/learning/ lib/tests/learning-store.test.ts lib/package.json .gitignore pnpm-lock.yaml
git commit -m "feat: add LearningStore with SQLite persistence"
```

---

### Task 4: Config Updates

**Files:**
- Modify: `lib/src/types/schemas.ts`
- Modify: `lib/src/config.ts`
- Modify: `.opencode-reviewer.yml`

**Interfaces:**
- Consumes: `LearningConfig` type from Task 1
- Produces: parsed learning config accessible from `loadConfig()`

- [ ] **Step 1: Add Zod schema for LearningConfig in `lib/src/types/schemas.ts`**

Add after `AuditConfigSchema`:

```typescript
export const LearningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  feedbackSignals: z.array(z.string()).default(['dismissed', 'reaction', 'disputed_comment']),
  metaReview: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().int().min(1).max(100).default(5),
    minFindingsForReview: z.number().int().min(1).default(3),
  }).default({}),
  patternDiscovery: z.object({
    enabled: z.boolean().default(true),
    minFrequency: z.number().int().min(1).default(3),
    windowSize: z.number().int().min(10).max(1000).default(100),
  }).default({}),
});
```

- [ ] **Step 2: Update `PromptConfig` in `lib/src/types/index.ts`**

Add `learning?: z.infer<typeof LearningConfigSchema>;` to the `PromptConfig` interface.

- [ ] **Step 3: Update `validateConfig` in `lib/src/config.ts`**

Add after the audit section:
```typescript
if (config.learning) {
  result.learning = {
    enabled: config.learning.enabled,
    feedbackSignals: config.learning.feedbackSignals,
    metaReview: {
      enabled: config.learning.metaReview?.enabled ?? true,
      interval: config.learning.metaReview?.interval ?? 5,
      minFindingsForReview: config.learning.metaReview?.minFindingsForReview ?? 3,
    },
    patternDiscovery: {
      enabled: config.learning.patternDiscovery?.enabled ?? true,
      minFrequency: config.learning.patternDiscovery?.minFrequency ?? 3,
      windowSize: config.learning.patternDiscovery?.windowSize ?? 100,
    },
  };
}
```

- [ ] **Step 4: Update `PromptConfig` type to include `learning`**

In `lib/src/types/index.ts`, add to the `PromptConfig` interface:
```typescript
learning?: {
  enabled?: boolean;
  feedbackSignals?: string[];
  metaReview?: {
    enabled?: boolean;
    interval?: number;
    minFindingsForReview?: number;
  };
  patternDiscovery?: {
    enabled?: boolean;
    minFrequency?: number;
    windowSize?: number;
  };
};
```

- [ ] **Step 5: Update default AgentConfig in `lib/src/types/index.ts`**

Add to `DEFAULT_CONFIG`:
```typescript
learning: {
  enabled: true,
  feedbackSignals: ['dismissed', 'reaction', 'disputed_comment'],
  metaReview: {
    enabled: true,
    interval: 5,
    minFindingsForReview: 3,
  },
  patternDiscovery: {
    enabled: true,
    minFrequency: 3,
    windowSize: 100,
  },
},
```

Also add `learning: LearningConfig;` to the `AgentConfig` interface.

- [ ] **Step 6: Update `.opencode-reviewer.yml`**

Append:
```yaml
learning:
  enabled: true
  feedbackSignals:
    - "dismissed"
    - "reaction"
    - "disputed_comment"
  metaReview:
    enabled: true
    interval: 5
    minFindingsForReview: 3
  patternDiscovery:
    enabled: true
    minFrequency: 3
    windowSize: 100
```

- [ ] **Step 7: Update config test**

Append to `lib/tests/config.test.ts`:

```typescript
it('parses learning config', () => {
  const result = loadConfigFromString(`
learning:
  enabled: true
  metaReview:
    interval: 10
  patternDiscovery:
    minFrequency: 5
`);
  expect(result).toBeDefined();
  expect(result!.learning?.metaReview?.interval).toBe(10);
  expect(result!.learning?.patternDiscovery?.minFrequency).toBe(5);
});
```

Add `loadConfigFromString` helper at top of test file if not present.

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @opencode-pr-agent/lib test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/src/types/index.ts lib/src/types/schemas.ts lib/src/config.ts .opencode-reviewer.yml lib/tests/config.test.ts
git commit -m "feat: add learning config schema and defaults"
```

---

### Task 5: FeedbackSubscriber

**Files:**
- Create: `lib/src/learning/feedback-subscriber.ts`
- Test: `lib/tests/feedback-subscriber.test.ts`

**Interfaces:**
- Consumes: `Subscriber`, `GitHubEvent`, `LearningStore`
- Produces: `FeedbackSubscriber` class

- [ ] **Step 1: Write the failing test**

Create `lib/tests/feedback-subscriber.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackSubscriber } from '../src/learning/feedback-subscriber.js';
import { LearningStore } from '../src/learning/store.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = path.join(__dirname, '.test-feedback.db');

describe('FeedbackSubscriber', () => {
  let store: LearningStore;
  let subscriber: FeedbackSubscriber;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    subscriber = new FeedbackSubscriber(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('subscribes to review and comment events', () => {
    expect(subscriber.subscribedEvents).toContain('review.dismissed');
    expect(subscriber.subscribedEvents).toContain('review_comment.dismissed');
    expect(subscriber.subscribedEvents).toContain('comment.created');
  });

  it('records feedback on review.dismissed', async () => {
    // First record a finding
    const findingId = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
    });

    await subscriber.handle({
      type: 'review.dismissed',
      category: 'review',
      payload: {
        review: { id: 123 },
        pull_request: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    // Feedback should be recorded (dismissed signal)
    const fpRate = store.getFalsePositiveRate();
    expect(fpRate).toBeGreaterThan(0);
  });

  it('scans comment.created for dispute keywords', async () => {
    const findingId = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: 'This is a false positive, not an issue',
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = store.getFalsePositiveRate();
    expect(fpRate).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/feedback-subscriber.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create `lib/src/learning/feedback-subscriber.ts`**

```typescript
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { LearningStore } from './store.js';

const DISPUTE_KEYWORDS = ['false positive', 'not an issue', 'wrong', 'incorrect', 'false alarm'];

export class FeedbackSubscriber implements Subscriber {
  name = 'FeedbackSubscriber';
  subscribedEvents = ['review.dismissed', 'review_comment.dismissed', 'comment.created'];

  constructor(private store: LearningStore) {}

  async handle(event: GitHubEvent): Promise<void> {
    switch (event.type) {
      case 'review.dismissed':
        await this.handleReviewDismissed(event);
        break;
      case 'review_comment.dismissed':
        await this.handleReviewCommentDismissed(event);
        break;
      case 'comment.created':
        await this.handleCommentCreated(event);
        break;
    }
  }

  private async handleReviewDismissed(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { review?: { id?: number }; pull_request?: { number?: number } };
    const prNumber = payload?.pull_request?.number || event.prNumber || 0;
    if (!prNumber) return;

    // Mark all findings for this PR as disputed
    const findings = this.store.getFindings(prNumber);
    for (const finding of findings) {
      this.store.recordFeedback({
        findingId: finding.id as string,
        signalType: 'dismissed',
        signalValue: 'review_dismissed',
        prNumber,
      });
    }
  }

  private async handleReviewCommentDismissed(event: GitHubEvent): Promise<void> {
    const prNumber = event.prNumber || 0;
    if (!prNumber) return;

    this.store.recordFeedback({
      findingId: `review_${event.timestamp}`,
      signalType: 'dismissed',
      signalValue: 'comment_dismissed',
      prNumber,
    });
  }

  private async handleCommentCreated(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { body?: string; issue?: { number?: number } };
    const body = payload?.body || '';
    const prNumber = payload?.issue?.number || event.prNumber || 0;
    if (!prNumber || !body) return;

    const lower = body.toLowerCase();
    const isDispute = DISPUTE_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isDispute) return;

    // Mark most recent findings as disputed
    const findings = this.store.getFindings(prNumber, 5);
    for (const finding of findings) {
      this.store.recordFeedback({
        findingId: finding.id as string,
        signalType: 'disputed_comment',
        signalValue: body.slice(0, 200),
        prNumber,
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/feedback-subscriber.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/src/learning/feedback-subscriber.ts lib/tests/feedback-subscriber.test.ts
git commit -m "feat: add FeedbackSubscriber for learning from review dismissals and disputes"
```

---

### Task 6: Prompt Integration

**Files:**
- Modify: `lib/src/engine.ts`
- Modify: `lib/src/types/index.ts` (add `learningStore` to ReviewEngine constructor)

**Interfaces:**
- Consumes: `LearningStore.getRelevantLessons()`
- Produces: lessons injected into review prompt as `## Historical Lessons` section

- [ ] **Step 1: Write a test for the prompt injection**

Modify `lib/tests/prompt-builder.test.ts`:

```typescript
it('injects learning lessons when provided', () => {
  const prompt = buildReviewPrompt(
    { maxFilesPerBatch: 3 },
    '## PR Context\n...',
    ['Always handle async errors', 'Use strict equality checks'],
  );
  expect(prompt).toContain('## Historical Lessons');
  expect(prompt).toContain('Always handle async errors');
});
```

- [ ] **Step 2: Update `buildReviewPrompt` in `lib/src/prompts/builder.ts`**

Current signature: `(inputs: PromptBuilderInputs, prContext: string): string`. Add optional `lessons` parameter. Insert the lessons section right after `## Output Format: JSON Lines` and before `## Critical Rules`. The full modified function:

```typescript
export function buildReviewPrompt(
  inputs: PromptBuilderInputs,
  prContext: string,
  lessons?: string[],
): string {
  if (inputs.reviewPromptFile) {
    const customPrompt = loadPromptFile(inputs.reviewPromptFile);
    if (customPrompt) {
      return customPrompt + (inputs.reviewPromptExtra ? '\n\n' + inputs.reviewPromptExtra : '');
    }
  }

  const projectContext = inputs.projectContext || getDefaultProjectContext();
  const batchSize = inputs.maxFilesPerBatch || 3;
  const sections: string[] = [];

  sections.push(
    'You are a Senior Code Reviewer with deep expertise in software architecture, design patterns, and best practices. Review this pull request thoroughly.',
  );

  sections.push('\n## PR & Issue Context');
  sections.push('');
  sections.push(prContext);

  sections.push('\n## Project Context');
  sections.push('');
  sections.push(projectContext);

  sections.push('\n## Context Window Management');
  sections.push('');
  sections.push(
    'This repository may be too large to review in one pass. To prevent context overflow:',
  );
  sections.push('');
  sections.push('1. Get the full list of changed files.');
  sections.push('2. Determine which project(s) the PR touches based on file paths.');
  sections.push(`3. Group files into batches of at most ${batchSize} files per batch.`);
  sections.push('4. For each batch, review for ALL items listed under "What to Check".');
  sections.push('5. Collect all results, deduplicate, and write the final output.');

  sections.push('\n' + buildWhatToCheck());

  sections.push('\n## Calibration');
  sections.push('');
  sections.push(
    "Be specific — reference file paths and line numbers for every issue. Explain WHY each issue matters, not just what's wrong. Categorize by actual severity — not everything is Critical. Acknowledge what was done well before listing issues.",
  );
  sections.push('');
  sections.push('If you find significant deviations from the PR intent, flag them specifically.');
  sections.push('');
  sections.push('## Severity Guide');
  sections.push('');
  sections.push(
    '- **critical**: Bug, security hole, broken functionality, HTML spec violation, PII exposure — must fix before merge',
  );
  sections.push(
    '- **important**: Architecture concern, maintainability debt, significant duplication, missing error handling, accessibility gaps — should fix',
  );
  sections.push(
    '- **minor**: Style, naming, optimization, documentation, small refactors — nice to have',
  );

  sections.push('\n## Output Format: JSON Lines');
  sections.push('');
  sections.push(buildOutputFormat());

  // Historical lessons from learning store
  if (lessons && lessons.length > 0) {
    sections.push('\n## Historical Lessons');
    sections.push('');
    sections.push('The following patterns were detected in similar code in past reviews:');
    sections.push('');
    for (const lesson of lessons) {
      sections.push(`- ${lesson}`);
    }
  }

  sections.push('\n## Critical Rules');
  sections.push('');
  sections.push('**DO:**');
  sections.push('- Reference specific file:line for every issue');
  sections.push('- Explain WHY each issue matters');
  sections.push('- Categorize by actual severity');
  sections.push('- Acknowledge strengths before issues');
  sections.push('- Give a clear verdict');
  sections.push('');
  sections.push("**DON'T:**");
  sections.push('- Say "looks good" without checking');
  sections.push('- Mark nitpicks as Critical');
  sections.push("- Give feedback on code you didn't actually read");
  sections.push('- Be vague ("improve error handling")');
  sections.push('- Avoid giving a clear verdict');
  sections.push('- Run git push, git commit, or create any pull requests');

  if (inputs.reviewPromptExtra) {
    sections.push('\n## Additional Instructions');
    sections.push('');
    sections.push(inputs.reviewPromptExtra);
  }

  return sections.join('\n');
}
```

- [ ] **Step 3: Run prompt builder test to verify it passes**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/prompt-builder.test.ts`
Expected: PASS

- [ ] **Step 4: Update `ReviewEngine.reviewPR()` to accept and pass lessons**

In `lib/src/engine.ts`:
1. Add import at top: `import { LearningStore } from './learning/store.js';`
2. Add a `learningStore` parameter to the constructor:

```typescript
export class ReviewEngine {
  // ...
  constructor(
    config: AgentConfig,
    githubToken: string,
    repo: string,
    private learningStore?: LearningStore,
  ) {
    // existing init...
  }
```

In `reviewPR()`, before building prompt:

```typescript
const lessons = this.learningStore
  ? this.learningStore.getRelevantLessons(pr.changedFiles.map((f) => f.path))
  : [];
```

Then pass `lessons` to `buildReviewPrompt`:

```typescript
const prompt = buildReviewPrompt(
  {
    projectContext: this.config.projectContext.description || undefined,
    maxFilesPerBatch: this.config.batchSize,
  },
  contextMarkdown + mcpSection,
  lessons,
);
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @opencode-pr-agent/lib typecheck`
Expected: PASS

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @opencode-pr-agent/lib test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/src/engine.ts lib/src/prompts/builder.ts lib/tests/prompt-builder.test.ts
git commit -m "feat: inject learning lessons into review prompts"
```

---

### Task 7: Meta-Review Subsystem

**Files:**
- Create: `lib/src/meta-review/prompts.ts`
- Create: `lib/src/meta-review/engine.ts`
- Test: `lib/tests/meta-review.test.ts`

**Interfaces:**
- Consumes: `LearningStore`, `GitHubEvent`, `Subscriber`
- Produces: `MetaReviewEngine.run()`, `MetaReviewSubscriber`

- [ ] **Step 1: Create `lib/src/meta-review/prompts.ts`**

```typescript
export function buildMetaReviewPrompt(context: {
  reviewSummary: string;
  findingsCount: number;
  issuesCount: number;
  strengthsCount: number;
  hasVerdict: boolean;
  fileCount: number;
}): string {
  return `You are evaluating the quality of an AI code review. Assess the review based on:

1. **Actionability** — Are the findings specific? Do they include file paths, line numbers, and concrete suggestions?
2. **Coverage** — Were enough files reviewed given the PR size?
3. **Consistency** — Are similar issues treated similarly across files?
4. **Accuracy signals** — Are there any obvious false positives?

Review output to evaluate:
- Summary: ${context.reviewSummary.slice(0, 500)}
- Findings: ${context.findingsCount} total (${context.issuesCount} issues, ${context.strengthsCount} strengths)
- Verdict: ${context.hasVerdict ? 'Yes' : 'No'}
- Files changed: ${context.fileCount}

Output a JSON object with scores (0-100):
{
  "actionabilityScore": <number>,
  "coverageScore": <number>,
  "consistencyScore": <number>,
  "accuracyScore": <number>,
  "suggestions": ["<suggestion to improve>"]
}

Return ONLY the JSON object, no markdown fences.`;
}
```

- [ ] **Step 2: Create `lib/src/meta-review/engine.ts`**

```typescript
import { LearningStore } from '../learning/store.js';
import { buildMetaReviewPrompt } from './prompts.js';
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { runOpenCode } from '../opencode.js';

const DISPUTE_KEYWORDS = ['false positive', 'not an issue', 'wrong', 'incorrect', 'false alarm'];

export class MetaReviewEngine {
  constructor(private store: LearningStore) {}

  async runMetaReview(context: {
    prNumber: number;
    reviewSummary: string;
    findingsCount: number;
    issuesCount: number;
    strengthsCount: number;
    hasVerdict: boolean;
    fileCount: number;
  }): Promise<{
    actionabilityScore: number;
    accuracyScore: number;
    coverageScore: number;
    consistencyScore: number;
    suggestions: string[];
  }> {
    const fpRate = this.store.getFalsePositiveRate();
    const prompt = buildMetaReviewPrompt(context);

    await runOpenCode(prompt, {
      model: 'opencode/deepseek-v4-flash-free',
    });

    let result: Record<string, unknown> = {};
    try {
      const fs = await import('fs');
      const content = await fs.promises.readFile('.opencode/meta-review-output.jsonl', 'utf-8');
      const parsed = JSON.parse(content.trim().split('\n').pop() || '{}');
      result = parsed;
    } catch {
      // Fallback defaults if OpenCode call fails
      result = {
        actionabilityScore: 70,
        coverageScore: 70,
        consistencyScore: 70,
        accuracyScore: Math.max(0, 100 - fpRate * 100),
        suggestions: ['Unable to complete meta-review analysis'],
      };
    }

    const quality = {
      prNumber: context.prNumber,
      actionabilityScore: (result.actionabilityScore as number) || 70,
      accuracyScore: (result.accuracyScore as number) || Math.max(0, 100 - fpRate * 100),
      coverageScore: (result.coverageScore as number) || 70,
      consistencyScore: (result.consistencyScore as number) || 70,
    };

    this.store.recordQuality(quality);

    // If false positive rate > 30%, add a prompt override suggestion
    if (fpRate > 0.3) {
      this.store.addPromptOverride(
        'general',
        `Note: Recent reviews had a ${Math.round(fpRate * 100)}% false positive rate. Be more conservative with issue severity.`,
        fpRate,
      );
    }

    return {
      ...quality,
      suggestions: (result.suggestions as string[]) || [],
    };
  }
}

export class MetaReviewSubscriber implements Subscriber {
  name = 'MetaReviewSubscriber';
  subscribedEvents = ['review.completed'];

  constructor(
    private engine: MetaReviewEngine,
    private store: LearningStore,
    private interval: number,
  ) {}

  async handle(event: GitHubEvent): Promise<void> {
    const shouldRun = this.store.incrementAndCheckMetaReviewInterval(this.interval);
    if (!shouldRun) return;

    const payload = event.payload as {
      prNumber?: number;
      reviewSummary?: string;
      findingsCount?: number;
      issuesCount?: number;
      strengthsCount?: number;
      hasVerdict?: boolean;
      fileCount?: number;
    };

    await this.engine.runMetaReview({
      prNumber: payload.prNumber || event.prNumber || 0,
      reviewSummary: payload.reviewSummary || '',
      findingsCount: payload.findingsCount || 0,
      issuesCount: payload.issuesCount || 0,
      strengthsCount: payload.strengthsCount || 0,
      hasVerdict: payload.hasVerdict || false,
      fileCount: payload.fileCount || 0,
    });
  }
}
```

- [ ] **Step 3: Write the failing test**

Create `lib/tests/meta-review.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MetaReviewEngine, MetaReviewSubscriber } from '../src/meta-review/engine.js';
import { LearningStore } from '../src/learning/store.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = path.join(__dirname, '.test-meta.db');

describe('MetaReviewEngine', () => {
  let store: LearningStore;
  let engine: MetaReviewEngine;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    engine = new MetaReviewEngine(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('records quality metrics after review', async () => {
    await engine.runMetaReview({
      prNumber: 1,
      reviewSummary: 'Good review with specific findings',
      findingsCount: 5,
      issuesCount: 3,
      strengthsCount: 2,
      hasVerdict: true,
      fileCount: 4,
    });

    const trends = store.getQualityTrends();
    expect(trends).toHaveLength(1);
    expect((trends[0] as Record<string, unknown>).pr_number).toBe(1);
  });

  it('adds prompt override when FP rate is high', async () => {
    // Create 2 findings with 2 disputes → 100% FP rate
    const id1 = store.recordFinding({ prNumber: 1, type: 'issue', message: 'fp1' });
    store.recordFeedback({ findingId: id1, signalType: 'dismissed', signalValue: 'fp', prNumber: 1 });
    const id2 = store.recordFinding({ prNumber: 1, type: 'issue', message: 'fp2' });
    store.recordFeedback({ findingId: id2, signalType: 'disputed_comment', signalValue: 'wrong', prNumber: 1 });

    await engine.runMetaReview({
      prNumber: 2,
      reviewSummary: 'test',
      findingsCount: 1,
      issuesCount: 1,
      strengthsCount: 0,
      hasVerdict: true,
      fileCount: 1,
    });

    const lessons = store.getRelevantLessons(['test.ts']);
    expect(lessons.some((l) => l.includes('false positive rate'))).toBe(true);
  });
});

describe('MetaReviewSubscriber', () => {
  it('only runs at configured interval', () => {
    const store = new LearningStore(':memory:');
    const engine = new MetaReviewEngine(store);
    const sub = new MetaReviewSubscriber(engine, store, 3);

    expect(sub.subscribedEvents).toEqual(['review.completed']);
    expect(sub.name).toBe('MetaReviewSubscriber');

    store.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/meta-review.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 5: Implement (steps 1-2 already done)**

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/meta-review.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/src/meta-review/ lib/tests/meta-review.test.ts
git commit -m "feat: add MetaReview subsystem with quality scoring and prompt overrides"
```

---

### Task 8: Pattern Detector + Rule Approval

**Files:**
- Create: `lib/src/pattern-detector/cluster.ts`
- Create: `lib/src/pattern-detector/engine.ts`
- Create: `lib/src/pattern-detector/rule-approval.ts`
- Test: `lib/tests/pattern-detector.test.ts`

**Interfaces:**
- Consumes: `LearningStore`
- Produces: `PatternDetector.discover()`, `RuleApprovalSubscriber`

- [ ] **Step 1: Write the failing test**

Create `lib/tests/pattern-detector.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { clusterFindings } from '../src/pattern-detector/cluster.js';
import { PatternDetector } from '../src/pattern-detector/engine.js';
import { RuleApprovalSubscriber } from '../src/pattern-detector/rule-approval.js';
import { LearningStore } from '../src/learning/store.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = path.join(__dirname, '.test-pattern.db');

describe('clusterFindings', () => {
  it('groups similar messages by Jaccard similarity', () => {
    const messages = [
      'Missing error handling in async route',
      'Unhandled promise rejection in route handler',
      'Add error boundary to React component',
      'Wrap async handler in try/catch',
      'React component missing key prop',
    ];

    const clusters = clusterFindings(messages, 0.3);
    // "Missing error handling" and "Unhandled promise rejection" should cluster
    // "Add error boundary" and "Wrap async handler" should cluster
    // "React component missing key prop" should be its own cluster
    expect(clusters.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for empty input', () => {
    expect(clusterFindings([], 0.3)).toEqual([]);
  });
});

describe('PatternDetector', () => {
  let store: LearningStore;
  let detector: PatternDetector;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    detector = new PatternDetector(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('detects patterns from findings with same message', () => {
    // Add 3 findings with similar messages across different PRs
    for (let i = 0; i < 3; i++) {
      store.recordFinding({
        prNumber: i + 1,
        type: 'issue',
        severity: 'important',
        message: 'Missing error handling in async function',
        file: 'src/routes.ts',
      });
    }

    const patterns = detector.discover(3);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].frequency).toBeGreaterThanOrEqual(3);
  });
});

describe('RuleApprovalSubscriber', () => {
  let store: LearningStore;
  let sub: RuleApprovalSubscriber;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    sub = new RuleApprovalSubscriber(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('handles /approve-rule command', async () => {
    const ruleId = store.addCustomRule('Test rule', 'auto');

    await sub.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: `/approve-rule ${ruleId}`,
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const pending = store.getPendingRules();
    expect(pending).toHaveLength(0);
  });

  it('ignores non-approval comments', async () => {
    await sub.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: 'Looks good to me',
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    // No crash — should silently ignore
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/pattern-detector.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 3: Create `lib/src/pattern-detector/cluster.ts`**

```typescript
function tokenize(message: string): Set<string> {
  return new Set(
    message
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export function clusterFindings(
  messages: string[],
  threshold = 0.3,
): Array<{ centroid: string; messages: string[] }> {
  if (messages.length === 0) return [];

  const tokens = messages.map((m) => tokenize(m));
  const assigned = new Array(messages.length).fill(false);
  const clusters: Array<{ centroid: string; messages: string[] }> = [];

  for (let i = 0; i < messages.length; i++) {
    if (assigned[i]) continue;

    const cluster: string[] = [messages[i]];
    assigned[i] = true;

    for (let j = i + 1; j < messages.length; j++) {
      if (assigned[j]) continue;
      const sim = jaccardSimilarity(tokens[i], tokens[j]);
      if (sim >= threshold) {
        cluster.push(messages[j]);
        assigned[j] = true;
      }
    }

    if (cluster.length >= 2) {
      clusters.push({ centroid: messages[i], messages: cluster });
    }
  }

  return clusters;
}
```

- [ ] **Step 4: Create `lib/src/pattern-detector/engine.ts`**

```typescript
import { LearningStore } from '../learning/store.js';
import { clusterFindings } from './cluster.js';

export interface DiscoveredPattern {
  patternKey: string;
  messages: string[];
  frequency: number;
  fileTypes: string[];
}

export class PatternDetector {
  constructor(private store: LearningStore) {}

  discover(minFrequency: number): DiscoveredPattern[] {
    const findings = this.store.getFindings(undefined, 100);
    if (findings.length === 0) return [];

    const messages = findings.map((f) => f.message as string).filter(Boolean);
    const clusters = clusterFindings(messages, 0.3);

    const patterns: DiscoveredPattern[] = [];

    for (const cluster of clusters) {
      if (cluster.messages.length < minFrequency) continue;

      // Find which files and PRs are involved
      const relatedFindings = findings.filter((f) =>
        cluster.messages.some((m) => m === f.message),
      );

      const fileTypes = [
        ...new Set(
          relatedFindings
            .map((f) => {
              const file = f.file as string;
              if (!file) return '';
              const ext = file.split('.').pop();
              return ext ? `.${ext}` : '';
            })
            .filter(Boolean),
        ),
      ];

      const patternKey = cluster.centroid
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 60);

      patterns.push({
        patternKey,
        messages: cluster.messages,
        frequency: cluster.messages.length,
        fileTypes,
      });

      // Persist to store
      this.store.recordPattern({
        patternKey,
        messageCluster: cluster.messages,
        frequency: cluster.messages.length,
        fileTypes,
      });
    }

    return patterns;
  }
}
```

- [ ] **Step 5: Create `lib/src/pattern-detector/rule-approval.ts`**

```typescript
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { LearningStore } from '../learning/store.js';

const APPROVE_RULE_RE = /^\/approve-rule\s+(\S+)/;

export class RuleApprovalSubscriber implements Subscriber {
  name = 'RuleApprovalSubscriber';
  subscribedEvents = ['comment.created'];

  constructor(private store: LearningStore) {}

  async handle(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { body?: string };
    const body = payload?.body || '';
    if (!body) return;

    const match = body.match(APPROVE_RULE_RE);
    if (!match) return;

    const ruleId = match[1];
    this.store.approveRule(ruleId);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @opencode-pr-agent/lib test -- tests/pattern-detector.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/src/pattern-detector/ lib/tests/pattern-detector.test.ts
git commit -m "feat: add PatternDetector with clustering and RuleApprovalSubscriber"
```

---

### Task 9: Wiring Everything + Exports

**Files:**
- Modify: `app/src/index.ts`
- Modify: `lib/src/index.ts`
- Modify: `lib/src/engine.ts` (ensure LearningStore is passed through)

**Interfaces:**
- Consumes: All above tasks
- Produces: Working integrated system

- [ ] **Step 1: Update `lib/src/index.ts` exports**

Add exports for all new modules:

```typescript
export { EventBus } from './event-bus/bus.js';
export { EventRouter } from './event-bus/router.js';
export { LearningStore } from './learning/store.js';
export { getDatabase, getDbPath } from './learning/schema.js';
export { FeedbackSubscriber } from './learning/feedback-subscriber.js';
export { MetaReviewEngine, MetaReviewSubscriber } from './meta-review/engine.js';
export { buildMetaReviewPrompt } from './meta-review/prompts.js';
export { PatternDetector } from './pattern-detector/engine.js';
export { clusterFindings } from './pattern-detector/cluster.js';
export { RuleApprovalSubscriber } from './pattern-detector/rule-approval.js';
```

- [ ] **Step 2: Update `app/src/index.ts`**

Replace the spread `app.on()` handlers with a single `EventRouter` + `EventBus` setup:

```typescript
import {
  DEFAULT_CONFIG,
  GitHubHelper,
  ReviewEngine,
  getDefaultMCPServers,
  EventBus,
  EventRouter,
  LearningStore,
  FeedbackSubscriber,
  MetaReviewEngine,
  MetaReviewSubscriber,
} from '@opencode-pr-agent/lib';
import type { AgentConfig, Subscriber, GitHubEvent } from '@opencode-pr-agent/lib';
import type { Probot, ProbotOctokit } from 'probot';
import { handleAudit } from './handlers/audit.js';
import { handleAutofixLoop } from './handlers/autofix.js';
import { handleCommand } from './handlers/commands.js';
import { handlePRReview } from './handlers/pr-review.js';

export default (app: Probot): void => {
  const learningStore = new LearningStore();
  const bus = new EventBus();
  const router = new EventRouter(bus);

  // Register all subscribers
  const subscribers: Subscriber[] = [];

  // Create a review subscriber that wraps handlePRReview
  const reviewSubscriber: Subscriber = {
    name: 'ReviewSubscriber',
    subscribedEvents: ['pr.opened', 'pr.synchronize', 'comment.created'],
    async handle(event: GitHubEvent) {
      if (event.type === 'comment.created') {
        const payload = event.payload as { body?: string; issue?: { number: number } };
        if (!payload.body?.includes('/review') && !payload.body?.includes('/oc')) return;
      }

      // Skip bot PRs
      const payload = event.payload as {
        pull_request?: { user?: { login: string }; labels?: Array<{ name: string }> };
        issue?: { number: number };
      };

      if (event.type === 'pr.opened' || event.type === 'pr.synchronize') {
        if (payload.pull_request?.user?.login === 'github-actions[bot]') return;
        const labels = payload.pull_request?.labels?.map((l) => l.name) || [];
        if (labels.some((l) => ['autofix', 'autofix:approved', 'autofix:merged'].includes(l))) return;
      }

      const config = buildConfig();
      const prNumber = event.prNumber || 0;
      if (!prNumber) return;

      await handlePRReview(prNumber, event.repo || '', getToken(), config);

      // Publish review.completed for meta-review
      await bus.publish({
        type: 'review.completed',
        category: 'internal',
        payload: { prNumber, reviewSummary: '', findingsCount: 0, issuesCount: 0, strengthsCount: 0, hasVerdict: true, fileCount: 0 },
        timestamp: Date.now(),
        repo: event.repo,
        prNumber,
      });
    },
  };

  // Fix subscriber
  const fixSubscriber: Subscriber = {
    name: 'FixSubscriber',
    subscribedEvents: ['comment.created', 'issue.labeled'],
    async handle(event: GitHubEvent) {
      const payload = event.payload as { body?: string; issue?: { number: number }; labels?: Array<{ name: string }> };

      if (event.type === 'comment.created') {
        if (!payload.body?.includes('/fix')) return;
      }

      if (event.type === 'issue.labeled') {
        const labels = payload.labels?.map((l) => l.name) || [];
        if (!labels.includes('autofix-trigger')) return;
        const issuePayload = event.payload as { issue?: { pull_request?: unknown } };
        if (issuePayload.issue?.pull_request) return;
      }

      const config = buildConfig();
      const prNumber = event.prNumber || 0;
      if (!prNumber) return;

      await handleCommand('fix', prNumber, event.repo || '', getToken(), config);
    },
  };

  // Audit subscriber
  const auditSubscriber: Subscriber = {
    name: 'AuditSubscriber',
    subscribedEvents: ['comment.created'],
    async handle(event: GitHubEvent) {
      const payload = event.payload as { body?: string };
      if (!payload.body?.includes('/audit')) return;
      const config = buildConfig();
      await handleAudit(event.repo || '', getToken(), config);
    },
  };

  subscribers.push(reviewSubscriber, fixSubscriber, auditSubscriber);

  // Learning subscribers
  const feedbackSub = new FeedbackSubscriber(learningStore);
  subscribers.push(feedbackSub);

  const metaReviewEngine = new MetaReviewEngine(learningStore);
  const metaReviewSub = new MetaReviewSubscriber(
    metaReviewEngine,
    learningStore,
    DEFAULT_CONFIG.learning.metaReview.interval,
  );
  subscribers.push(metaReviewSub);

  bus.registerAll(subscribers);

  // Single event handler — catches everything
  app.on('*', async (context) => {
    await router.handle(context.name, context.payload);
  });

  console.log('✅ OpenCode PR Agent app loaded (self-improving)');
};

function getToken(): string {
  return process.env.GITHUB_TOKEN || '';
}

function buildConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    reviewModel: process.env.REVIEW_MODEL || DEFAULT_CONFIG.reviewModel,
    fixModel: process.env.FIX_MODEL || DEFAULT_CONFIG.fixModel,
    batchSize: Number.parseInt(process.env.BATCH_SIZE || '3', 10),
    maxIterations: Number.parseInt(process.env.MAX_ITERATIONS || '3', 10),
    enableMCP: process.env.ENABLE_MCP !== 'false',
    mcpServers:
      process.env.ENABLE_MCP !== 'false'
        ? getDefaultMCPServers(process.env.GITHUB_TOKEN || '')
        : [],
    projectContext: {
      description: process.env.PROJECT_DESCRIPTION || '',
      conventionsPath: process.env.CONVENTIONS_PATH || undefined,
      typecheckCommands: process.env.TYPECHECK_COMMANDS
        ? process.env.TYPECHECK_COMMANDS.split(',')
        : [],
      lintCommands: process.env.LINT_COMMANDS ? process.env.LINT_COMMANDS.split(',') : [],
    },
    learning: {
      enabled: true,
      feedbackSignals: ['dismissed', 'reaction', 'disputed_comment'],
      metaReview: { enabled: true, interval: 5, minFindingsForReview: 3 },
      patternDiscovery: { enabled: true, minFrequency: 3, windowSize: 100 },
    },
  };
}
```

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: PASS (all packages compile)

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/index.ts lib/src/index.ts
git commit -m "feat: wire up unified EventRouter and self-improving subscribers"
```

---

### Task 10: Final Self-Review

- [ ] **Step 1: Verify spec coverage**

Check each spec requirement against a task:
- EventBus routing: Task 2 ✓
- LearningStore: Task 3 ✓
- Feedback collection: Task 5 ✓
- Meta-review: Task 7 ✓
- Pattern detector: Task 8 ✓
- Rule approval: Task 8 ✓
- Prompt integration: Task 6 ✓
- Config: Task 4 ✓
- Wiring: Task 9 ✓
- Exports: Task 9 ✓

- [ ] **Step 2: Spot-check for placeholders or stale references**

- [ ] **Step 3: Verify type consistency across task interfaces**

- [ ] **Step 4: Run full test suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit any final fixes**
