# Phase 4 — Command Reliability: Regex Matching, PR-vs-Issue, Missing Commands

> **Goal:** Replace substring-based slash command matching with anchored regexes, fix the App's `/fix` PR-vs-issue confusion, add the missing `/discover` subscriber, and add a `--dry-run` flag to destructive commands.

This phase addresses **Findings F-10, F-11, F-16** from the master plan and supports the `--force` flag introduced in Phase 3.

---

## 1. Background — what's wrong today

### 1.1 Substring matching causes false triggers

Every slash command in the App uses `body.includes('/cmd')`. From `app/src/index.ts`:

- Line 49: `/review` or `/oc review` — `body.includes('/review')`
- Line 125: `/fix` — `body.includes('/fix')`
- Line 155: `/audit` — `body.includes('/audit')`
- Line 175: `/analyze` (alias `/analyse`) — `body.includes('/analyze') || body.includes('/analyse')`
- Line 236: `/explain` — `body.includes('/explain')`

A comment like:

- "let me see the **fix** here" → triggers `/fix` (because `body.includes('/fix')` is false here, but `body.includes('fix')` is true... actually wait, the check is `body.includes('/fix')` so it requires the `/`. Let me re-check.)
- "this is a duplicate of `/fixed-issue` from last week" → triggers `/fix` (substring `/fix` is present in `/fixed-issue`).
- "the `/oc review` and `/review` commands both work" → triggers `/review` (twice).
- "I'll `/analyse` this tomorrow" → triggers `/analyze`.
- "what's the **/fix** command do?" → triggers `/fix`.

The user's complaint is implicit but the bug is real: the bot fires on any comment that *mentions* the command, not just comments that *are* the command.

### 1.2 App `/fix` does not distinguish PR vs issue

In `app/src/handlers/commands.ts:77-117`:

```ts
case 'fix': {
  const existingPR = await findExistingAutofixPR(gh, issueNumber);
  if (existingPR) {
    await handleAutofixLoop(existingPR, ...);
  } else {
    await createAutofixPR(...);  // <-- always creates a new PR
  }
  break;
}
```

There is no `gh.isPR(issueNumber)` check. If a maintainer comments `/fix` on a **PR** (not an issue), `findExistingAutofixPR` looks at the PR body for `PR #N` markers, finds none, returns null, and `createAutofixPR` runs — creating a brand-new autofix PR whose body is `## Fixes #<PR-number>\n\n<PR-body>`. The result is a recursive autofix PR that "fixes" another PR by number.

The Action variant handles this correctly — `action/src/index.ts:241-254` checks `issue?.pull_request` and dispatches to `runAutofixLoop` instead of `runFixIssue`. The App variant doesn't.

### 1.3 Missing `/discover` command

The self-improving-reviewer spec (`docs/superpowers/specs/2026-07-14-self-improving-reviewer-design.md` §2.5) specifies a `/discover` slash command that runs the pattern detector on demand. The `PatternDetector` is implemented (`lib/src/pattern-detector/engine.ts`), but no subscriber in `app/src/index.ts` listens for `/discover`. The feature is dead code from the user's perspective.

### 1.4 No `--dry-run` for destructive commands

There's no way to test what `/fix` would do without actually pushing commits and opening a PR. A `--dry-run` flag would let maintainers preview the analysis plan, the gate state, and the proposed fix summary without side effects.

---

## 2. Design — anchored regex matching with flag parsing

### 2.1 The new command matcher

A new utility module `lib/src/utils/command-match.ts`:

```ts
export interface ParsedCommand {
  command: string;          // 'fix', 'analyze', etc. — without the slash
  args: string[];           // positional args
  flags: Record<string, string | boolean>;  // --force, --dry-run, etc.
  raw: string;              // the original line
}

const COMMAND_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'review',  regex: /^\s*\/(?:oc\s+)?review\b/i },
  { name: 'fix',     regex: /^\s*\/(?:oc\s+)?fix\b/i },
  { name: 'audit',   regex: /^\s*\/(?:oc\s+)?audit\b/i },
  { name: 'analyze', regex: /^\s*\/(?:oc\s+)?analy[sz]e\b/i },
  { name: 'explain', regex: /^\s*\/(?:oc\s+)?explain\b/i },
  { name: 'discover', regex: /^\s*\/(?:oc\s+)?discover\b/i },
  { name: 'reconcile-comments', regex: /^\s*\/(?:oc\s+)?reconcile-comments\b/i },
  { name: 'answer',  regex: /^\s*\/(?:oc\s+)?answer\b/i },
];

const FLAG_PATTERN = /--([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;

export function parseCommand(body: string): ParsedCommand | null {
  // Find the first line that starts with a slash command
  for (const line of body.split('\n')) {
    const matched = COMMAND_PATTERNS.find(p => p.regex.test(line));
    if (!matched) continue;

    // Strip the command itself, parse the rest as args + flags
    const rest = line.replace(matched.regex, '').trim();
    const flags: Record<string, string | boolean> = {};
    const args: string[] = [];

    let m: RegExpExecArray | null;
    let lastIndex = 0;
    FLAG_PATTERN.lastIndex = 0;
    while ((m = FLAG_PATTERN.exec(rest)) !== null) {
      flags[m[1]] = m[2] ?? m[3] ?? m[4] ?? true;
      lastIndex = m.index + m[0].length;
    }
    // Anything before the first flag is positional args
    const positional = rest.slice(0, lastIndex > 0 ? rest.indexOf('--') : rest.length).trim();
    if (positional) args.push(...positional.split(/\s+/));

    return { command: matched.name, args, flags, raw: line };
  }
  return null;
}
```

This matcher:

- Requires the command at the **start of a line** (anchored `^\s*`).
- Allows an optional `/oc` prefix (the existing `commandTriggers` config).
- Recognizes both `/analyze` and `/analyse` spellings.
- Parses `--flag` and `--flag=value` (with quoted strings).
- Returns `null` for non-command comments — no false triggers.

### 2.2 Per-subscriber refactor

Each subscriber in `app/src/index.ts` is refactored to use `parseCommand`. Example for `/fix`:

```ts
class FixSubscriber {
  async handle(event) {
    if (!isCommentEvent(event)) return;
    const body = event.payload.comment?.body ?? event.payload.review?.body ?? '';
    const parsed = parseCommand(body);
    if (!parsed || parsed.command !== 'fix') return;

    const issueNumber = event.payload.issue?.number ?? event.payload.pull_request?.number;
    if (!issueNumber) return;

    // Phase 4 fix: distinguish PR vs issue
    const isPR = !!(event.payload.issue?.pull_request ?? event.payload.pull_request);
    const repo = `${event.payload.repository.owner.login}/${event.payload.repository.name}`;

    if (parsed.flags.dryRun) {
      await handleDryRunFix(issueNumber, repo, parsed);
      return;
    }

    await handleCommand('fix', issueNumber, repo, getToken(), config, undefined, {
      force: parsed.flags.force === true,
      triggeredBy: event.payload.comment?.user?.login ?? event.payload.review?.user?.login,
    });
  }
}
```

### 2.3 PR-vs-issue disambiguation in App `/fix`

In `app/src/handlers/commands.ts`, the `fix` case becomes:

```ts
case 'fix': {
  const isPR = await gh.isPR(issueNumber);
  if (isPR) {
    // It's a PR — run the autofix loop against this PR, not create a new one
    const prContext = await gh.getPRContext(issueNumber);
    await handleAutofixLoop(prContext, ...);
  } else {
    const existingPR = await findExistingAutofixPR(gh, issueNumber);
    if (existingPR) {
      await handleAutofixLoop(existingPR, ...);
    } else {
      await createAutofixPR(...);
    }
  }
  break;
}
```

The new `gh.isPR(issueNumber)` helper:

```ts
async isPR(issueNumber: number): Promise<boolean> {
  const issue = await this.octokit.rest.issues.get({
    owner: this.owner, repo: this.repo, issue_number: issueNumber,
  });
  return !!issue.data.pull_request;
}
```

### 2.4 The `/discover` subscriber

```ts
class DiscoverSubscriber {
  async handle(event) {
    if (!isCommentEvent(event)) return;
    const parsed = parseCommand(event.payload.comment?.body ?? '');
    if (!parsed || parsed.command !== 'discover') return;

    const issueNumber = event.payload.issue?.number ?? event.payload.pull_request?.number;
    const repo = `${event.payload.repository.owner.login}/${event.payload.repository.name}`;
    const config = await loadConfig(repo);

    await handleDiscoverCommand(issueNumber, repo, getToken(), config, parsed.flags);
  }
}

async function handleDiscoverCommand(issueNumber, repo, token, config, flags) {
  const gh = new GitHubHelper(...);
  const store = new LearningStore(...);
  const detector = new PatternDetector(store);

  const windowSize = typeof flags.window === 'string' ? Number(flags.window) : config.learning.patternDiscovery.windowSize;
  const patterns = await detector.discoverPatterns({ windowSize });

  const md = renderPatternsComment(patterns);
  await gh.postOrUpdateComment(issueNumber, '<!-- discovered-patterns -->', md);
}
```

The `renderPatternsComment` helper produces a markdown summary of detected patterns, with a `/approve-rule <pattern-id>` prompt for each so the maintainer can promote patterns to active rules.

### 2.5 The `/answer` command

A manual override for the reply-matching subscriber (Phase 2):

```ts
async function handleAnswerCommand(issueNumber, repo, token, config, args, flags) {
  const store = new LearningStore(...);
  const gh = new GitHubHelper(...);

  // Usage: /answer q1="use zod" q2="yes, add tests"
  // Or:    /answer q1="use zod"
  for (const [qid, answer] of Object.entries(flags)) {
    if (qid.startsWith('q')) {
      await store.markQuestionAnswered(repo, issueNumber, qid, {
        text: String(answer),
        by: triggeredBy,
      });
    }
  }
  await gh.postComment(issueNumber, `✅ Recorded ${Object.keys(flags).length} answer(s). Run \`/fix\` to proceed.`);
}
```

### 2.6 The `--dry-run` flag

For `/fix` and `/audit`, `--dry-run` runs the analysis and gate steps but stops before pushing commits:

```ts
async function handleDryRunFix(issueNumber, repo, parsed) {
  const gh = new GitHubHelper(...);
  const engine = new ReviewEngine(...);
  const store = new LearningStore(...);

  // Run analyze if needed
  let issueContext = await gh.gatherContext({ issueNumber });
  if (!issueContext.includes('<!-- issue-analysis-plan -->')) {
    await handleAnalyzeCommand(issueNumber, repo, getToken(), config);
    issueContext = await gh.gatherContext({ issueNumber });
  }

  const plan = await store.getCurrentAnalysisPlan(repo, issueNumber);
  const openQuestions = await store.getOpenQuestions(repo, issueNumber);
  const requiredOpen = openQuestions.filter(q => q.required);

  const md = renderDryRunComment({
    plan,
    openQuestions: requiredOpen,
    wouldProceed: requiredOpen.length === 0 || parsed.flags.force === true,
  });
  await gh.postComment(issueNumber, '<!-- dry-run -->', md);
}
```

The dry-run comment looks like:

```markdown
<!-- dry-run -->

🔍 **Dry run** for `/fix` on issue #42.

## Plan
${plan.summary}
- Priority: ${plan.priority}
- Affected files: ${plan.affectedFiles.join(', ')}

## Open Questions
${requiredOpen.length === 0 ? '_(none — would proceed to fix)_' : requiredOpen.map(q => `- **${q.questionId}**: ${q.question}`).join('\n')}

## Decision
${requiredOpen.length === 0 ? '✅ Would proceed to fix.' : '⏸️ Would block — open required questions exist. Use `/fix --force` to override.'}

_No commits pushed, no PR opened._
```

---

## 3. File-by-file changes

### 3.1 `lib/src/utils/command-match.ts` (NEW)

The `parseCommand` function and `ParsedCommand` type from §2.1. Pure functions, fully unit-testable.

### 3.2 `lib/src/utils/github.ts` (MODIFY)

Add:

```ts
async isPR(issueNumber: number): Promise<boolean>;
async getPRContext(prNumber: number): Promise<PRContext>;  // ensure this exists, expose publicly if not
async deleteCommentByMarker(issueNumber: number, marker: string): Promise<void>;
```

The `deleteCommentByMarker` helper finds a comment by its marker (e.g. `<!-- autofix-waiting -->`) and deletes it. Used by Phase 3's gate cleanup.

### 3.3 `app/src/index.ts` (MODIFY — every subscriber)

Replace every `body.includes('/cmd')` check with `parseCommand(body)?.command === 'cmd'`. This touches lines 49, 125, 155, 175, 236, and the conversation subscriber around line 264.

Add the two new subscribers: `DiscoverSubscriber` and (if not added in Phase 2) `AnswerSubscriber`.

### 3.4 `app/src/handlers/commands.ts` (MODIFY)

- Add the `isPR` check in the `fix` case (§2.3).
- Add `handleDiscoverCommand` (§2.4).
- Add `handleAnswerCommand` (§2.5).
- Add `handleDryRunFix` (§2.6).
- Update `handleCommand` signature to accept `{ force, triggeredBy, dryRun }` options.
- Add the `discover` and `answer` cases to the `handleCommand` switch.

### 3.5 `lib/src/pattern-detector/engine.ts` (MODIFY)

Expose a `discoverPatterns(input)` method that returns a serializable array of patterns. (May already exist — verify and make public if private.)

### 3.6 `lib/src/types/index.ts` (MODIFY)

Add:

```ts
export interface CommandOptions {
  force?: boolean;
  dryRun?: boolean;
  triggeredBy?: string;
  args?: string[];
  flags?: Record<string, string | boolean>;
}
```

### 3.7 `lib/src/config.ts` + `lib/src/types/index.ts` (MODIFY)

Add:

```ts
review: {
  // ...existing...
  commandPrefix: string[];  // default: ['/', '/oc']  — configurable prefixes for slash commands
}
```

The `parseCommand` function reads this config to know which prefixes to accept.

### 3.8 `action/src/index.ts` + `action/src/fix.ts` (MODIFY)

The Action also parses slash commands from issue comments (when triggered by `/fix` on an issue). Update it to use the same `parseCommand` utility. Add `--force` and `--dry-run` support to the action's `runFixIssue` (Phase 3 already covered `--force`; `--dry-run` is Phase 4).

---

## 4. Tests

### 4.1 `lib/tests/command-match.test.ts` (NEW)

Comprehensive tests for `parseCommand`:

- `/fix` → `{ command: 'fix', args: [], flags: {} }`.
- `/fix --force` → `{ command: 'fix', args: [], flags: { force: true } }`.
- `/fix --force reason="picking zod"` → `{ command: 'fix', args: [], flags: { force: true, reason: 'picking zod' } }`.
- `/oc review` → `{ command: 'review', ... }`.
- `/analyze` and `/analyse` → both parse to `analyze`.
- `  /fix` (leading whitespace) → parses.
- `What's the /fix command?` (command not at line start) → `null`.
- `This is a duplicate of /fixed-issue` → `null` (because `^\s*\/fix\b` requires word boundary, `/fixed-issue` doesn't match `\/fix\b`).
- `I'll /analyse this tomorrow.` → `null` (because `^\s*\/analy[sz]e\b` requires the command at line start; "I'll " precedes it).
- Multi-line comment with `/fix` on the second line → parses.
- Empty body → `null`.
- Body with no commands → `null`.
- Body with two commands on separate lines → parses the first one (documented behavior).

### 4.2 `lib/tests/command.test.ts` (MODIFY)

Add tests for the App's command dispatch with the new `parseCommand`-based matching:

- `/fix` on an issue → `createAutofixPR` called.
- `/fix` on a PR → `handleAutofixLoop` called (Phase 4 fix).
- `/fix --force` on an issue with open questions → `createAutofixPR` called with `force: true`.
- `/fix --dry-run` on an issue → `handleDryRunFix` called, `engine.runFix` not called.
- "what's the fix?" → no command parsed, nothing happens.
- `/discover` on a PR → `handleDiscoverCommand` called.
- `/answer q1="use zod"` on an issue → `handleAnswerCommand` called, question marked answered.

### 4.3 `lib/tests/github.test.ts` (MODIFY)

Add tests for `isPR`, `deleteCommentByMarker`.

### 4.4 `lib/tests/discover.test.ts` (NEW)

Tests for `handleDiscoverCommand`:

- Calls `detector.discoverPatterns` with the configured window size.
- Posts a `<!-- discovered-patterns -->` comment.
- The `--window` flag overrides the config window size.

### 4.5 `lib/tests/answer.test.ts` (NEW)

Tests for `handleAnswerCommand`:

- Parses `q1="use zod" q2="yes"` and marks both questions answered.
- Parses `q1="use zod"` and marks only `q1` answered.
- Ignores flags that don't start with `q`.
- Posts the "Recorded N answers" comment.

---

## 5. Acceptance Criteria

- [ ] `parseCommand` exists, is a pure function, and is test-covered with all cases in §4.1.
- [ ] Every subscriber in `app/src/index.ts` uses `parseCommand` instead of `body.includes`.
- [ ] The App's `/fix` distinguishes PR vs issue (no longer creates recursive autofix PRs).
- [ ] `gh.isPR`, `gh.deleteCommentByMarker` exist and are test-covered.
- [ ] `/discover` subscriber exists, is registered, and is test-covered.
- [ ] `/answer` command exists and is test-covered.
- [ ] `--dry-run` flag works on `/fix` (and `/audit` if added).
- [ ] `--force` flag (Phase 3) is parsed via `parseCommand`.
- [ ] The `review.commandPrefix` config key exists.
- [ ] All test scenarios in §4 pass.

---

## 6. Rollout Steps

1. **PR-4.1 — `parseCommand` utility:** Add `lib/src/utils/command-match.ts` and `lib/tests/command-match.test.ts`. No callers yet. This is the foundation.
2. **PR-4.2 — Wire subscribers:** Refactor every subscriber in `app/src/index.ts` to use `parseCommand`. Update `lib/tests/command.test.ts`. Behavior change: comments that mention commands in the middle of a sentence no longer trigger them. Call out in changelog.
3. **PR-4.3 — PR-vs-issue fix:** Add `gh.isPR`. Update `app/src/handlers/commands.ts` fix case. Add regression test.
4. **PR-4.4 — `/discover` subscriber:** Add the subscriber and `handleDiscoverCommand`. Expose `discoverPatterns` publicly on `PatternDetector`.
5. **PR-4.5 — `/answer` command:** Add `handleAnswerCommand`. Useful as a manual override for Phase 2's reply matching.
6. **PR-4.6 — `--dry-run`:** Add the dry-run flag for `/fix` (and optionally `/audit`). Add `handleDryRunFix` and the dry-run comment template.
7. **PR-4.7 — Action parity:** Update `action/src/index.ts` and `action/src/fix.ts` to use `parseCommand` for the same consistency. (Phase 5 will consolidate further.)

PRs 4.1, 4.3, 4.4, 4.5, 4.6 can all land in parallel once 4.1 is merged. PR 4.2 depends on 4.1. PR 4.7 depends on 4.2.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Existing users have workflows that mention `/fix` in the middle of comments expecting it to trigger | Low | Medium | Announce the change in the changelog. The vast majority of usage puts the command at line start. |
| `parseCommand` is too strict — misses legitimate command invocations | Low | Medium | The regex allows leading whitespace and an optional `/oc` prefix. Add a fallback: if no command is parsed but `body.trim().startsWith('/')`, log a warning so we can detect false negatives in production. |
| `--force` and `--dry-run` parsing breaks on quoted strings with special chars | Low | Low | Test with a variety of quoted strings in §4.1. The regex handles double-quoted, single-quoted, and unquoted values. |
| `/discover` produces too many patterns → comment is huge | Medium | Low | Cap the comment at the top 20 patterns by frequency. Add a `--limit` flag. |
| `/answer` is abused (maintainer answers a question they shouldn't have) | Low | Low | The audit trail (`issue_questions.answered_by`) records who answered. The Phase 3 PR body includes the decisions and who made them. |
| `isPR` makes an extra API call per `/fix` invocation | Low | Low | One extra call is negligible. Could cache per-request if it becomes a bottleneck. |

---

## 8. Open Questions

1. **Should `parseCommand` return all commands in a multi-command comment, or just the first?** Recommendation: just the first. Multi-command comments are rare and confusing; better to post "Please run one command at a time" if multiple are detected. (Possible Phase 6 enhancement.)

2. **Should `/oc` be the default prefix, or `/`?** Recommendation: both, configurable via `review.commandPrefix`. Default `['/', '/oc']`. The existing config has `commandTriggers: ['/oc', '/review']` which is a different (and largely unused) concept — Phase 5 should clean this up.

3. **Should `--dry-run` be available on every command, or just destructive ones?** Recommendation: just `/fix` and `/audit` for now. `/analyze` and `/explain` are already non-destructive (they just post comments).

4. **Should the `/answer` command require the maintainer to quote-reply to the question comment, or accept the raw `q1="..."` syntax?** Recommendation: accept both. The raw syntax is faster for power users; quote-reply is more discoverable.

5. **Should `/discover` be available on PRs, or only on issues?** Recommendation: both. On a PR, it analyzes patterns in the PR's review history. On an issue, it analyzes patterns repo-wide.

---

End of Phase 4. Continue to `phase-5-app-action-parity.md`.
