# Phase 3 — Issue Analysis & Question Workflow

> **Severity:** High  
> **Effort:** Large (5–7 days)  
> **Dependencies:** None (new workflow, independent)

---

## Problems Being Solved

### Problem 3.1 — Issues are not automatically analyzed on open

**Current behavior:**  
`/analyze` is only triggered by a manual comment command. The `AnalyzeSubscriber` in `app/src/index.ts` only subscribes to `comment.created` events. There is no handler for `issues.opened`.

Looking at `app/src/index.ts`:
```ts
const analyzeSubscriber: Subscriber = {
  subscribedEvents: ['comment.created', 'review_comment.created'],  // <-- no 'issue.opened'
  ...
}
```

**Impact:**  
- Issues sit unanalyzed until someone manually comments `/analyze`
- No automated implementation plan is generated
- Fix agent starts without a plan when `/fix` is triggered immediately after issue creation

---

### Problem 3.2 — `/fix` starts immediately without checking for blocking questions

**Current behavior:**  
`handleCommand('fix', ...)` in `commands.ts`:
1. Checks if an existing autofix PR exists
2. If not, calls `createAutofixPR()` which calls `engine.runAnalyze()` if no plan exists yet
3. Then immediately calls `engine.runFix()`

There is **no check** for whether the analysis raised blocking questions that need user answers. The fix runs regardless.

Looking at `commands.ts → createAutofixPR()`:
```ts
// Auto-analyze if no implementation plan exists yet
if (!issueContext.includes('<!-- issue-analysis-plan -->')) {
  const planMarkdown = await engine.runAnalyze(...);
  await gh.postOrUpdateComment(...);
  issueContext = await gh.gatherContext({ issueNumber });
}

// Immediately runs fix — no question gate!
const fixResult = await engine.runFix(...);
```

Same problem exists in `action/src/fix.ts → runFixIssue()`.

**Impact:**  
- Fix agent starts with insufficient context
- Produces incorrect or incomplete fixes
- If the user answers questions later, the fix has already run with wrong assumptions
- Wasted compute + potentially wrong PR created

---

### Problem 3.3 — Analysis plan has no structured format for questions

**Current behavior:**  
`buildAnalyzePrompt()` in `lib/src/prompts/builder.ts` asks the LLM to produce a markdown implementation plan, but there is no structure for "blocking questions". The output is free-form markdown.

There is no way to programmatically detect whether the plan contains blocking questions that need user answers before the fix can proceed.

**Impact:**  
- The fix-gate check (Problem 3.2) cannot be implemented without a structured output format

---

## Proposed Solution

### Step 1 — Auto-analyze when an issue is opened

**File:** `app/src/index.ts`

Add a new `AutoAnalyzeSubscriber` that handles `issue.opened`:

```ts
const autoAnalyzeSubscriber: Subscriber = {
  name: 'AutoAnalyzeSubscriber',
  subscribedEvents: ['issue.opened'],
  async handle(event: GitHubEvent, signal?: AbortSignal) {
    if (signal?.aborted) return;
    try {
      const payload = event.payload as Record<string, unknown>;
      const issue = payload.issue as Record<string, unknown> | undefined;
      if (!issue) return;

      // Skip pull requests (they come through as issue.opened too)
      if (issue.pull_request) return;

      // Skip bot-created issues (audit issues, etc.)
      const user = issue.user as Record<string, string> | undefined;
      if (user?.type === 'Bot') return;

      const issueNumber = (issue.number as number) || 0;
      if (!issueNumber) return;

      const config = buildConfig();

      // Small delay to let any initial labels/assignments settle
      await new Promise(r => setTimeout(r, 2000));

      await handleCommand('analyze', issueNumber, event.repo || '', getToken(), config, signal);
    } catch (err) {
      logger.error(`AutoAnalyzeSubscriber failed: ${err instanceof Error ? err.message : err}`);
    }
  },
};

subscribers.push(autoAnalyzeSubscriber);
```

**Note:** The `EventRouter` must also route `issues.opened` GitHub webhook events to `issue.opened` GitHubEvent type. Check `lib/src/event-bus/router.ts` — add the mapping if missing:

```ts
case 'issues':
  if (payload.action === 'opened') {
    await bus.publish({ type: 'issue.opened', ... });
  }
  break;
```

---

### Step 2 — Add `issue.opened` to the GitHubEvent type

**File:** `lib/src/types/index.ts`

```ts
export type GitHubEventType =
  | 'pr.opened'
  | 'pr.synchronize'
  | 'comment.created'
  | 'review_comment.created'
  | 'issue.opened'      // NEW
  | 'issue.labeled'
  | 'issue.closed'
  | 'internal';
```

---

### Step 3 — Add structured "Questions" section to the analysis plan

**File:** `lib/src/prompts/builder.ts → buildAnalyzePrompt()`

Add a required section to the analysis output format:

```
## Required Output Format

Write your analysis to `.opencode/analysis-plan.md` using this exact structure:

### Implementation Plan

(Your detailed implementation plan here — approach, files to change, steps)

### Blocking Questions

If you have questions that MUST be answered before implementation can begin, list them here.
Only include questions that would fundamentally change the approach or files affected.
If you have no blocking questions, write: "None — implementation can proceed immediately."

Format blocking questions as:
- **Q1:** (question text)
- **Q2:** (question text)

### Confidence Level

Rate your confidence: HIGH / MEDIUM / LOW
- HIGH: Plan is clear, no ambiguity, all context available
- MEDIUM: Some assumptions made, minor clarifications would help but not blocking
- LOW: Significant unknowns, blocking questions must be answered first
```

---

### Step 4 — Parse the analysis plan for blocking questions

**File:** `lib/src/engine.ts` (or a new utility `lib/src/utils/analyze-parser.ts`)

Add a utility to parse the structured analysis plan:

```ts
export interface AnalysisPlanResult {
  planMarkdown: string;       // Full plan as written
  hasBlockingQuestions: boolean;
  blockingQuestions: string[];
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
}

export function parseAnalysisPlan(markdown: string): AnalysisPlanResult {
  const questionsSection = markdown.match(
    /### Blocking Questions\n([\s\S]*?)(?=###|$)/
  )?.[1]?.trim() ?? '';

  const hasBlockingQuestions =
    questionsSection.length > 0 &&
    !questionsSection.toLowerCase().includes('none') &&
    !questionsSection.toLowerCase().includes('can proceed');

  const blockingQuestions: string[] = [];
  if (hasBlockingQuestions) {
    const matches = questionsSection.matchAll(/- \*\*Q\d+:\*\* (.+)/g);
    for (const match of matches) {
      blockingQuestions.push(match[1].trim());
    }
  }

  const confidenceMatch = markdown.match(/### Confidence Level\s+(\w+)/);
  const confidenceLevel = (confidenceMatch?.[1]?.toUpperCase() ?? 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'LOW';

  return { planMarkdown: markdown, hasBlockingQuestions, blockingQuestions, confidenceLevel };
}
```

---

### Step 5 — Post analysis plan with question prompts and correct labels

**File:** `app/src/handlers/commands.ts → handleAnalyzeCommand()`

After posting the plan, check for blocking questions and apply the right label:

```ts
export async function handleAnalyzeCommand(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
): Promise<void> {
  const gh = new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, token, repo);

  try {
    const issueContext = await gh.gatherContext({ issueNumber });
    const planMarkdown = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);

    const parsed = parseAnalysisPlan(planMarkdown);

    // Post the full plan
    await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

    // If there are blocking questions, post them separately and label the issue
    if (parsed.hasBlockingQuestions) {
      const questionsBody = [
        '## ❓ Questions Before Proceeding',
        '',
        'I have analyzed this issue but need clarification before starting implementation.',
        'Please answer the following questions by replying to this comment:',
        '',
        ...parsed.blockingQuestions.map((q, i) => `**Q${i + 1}:** ${q}`),
        '',
        '---',
        '*Once these are answered, comment `/fix` to start the implementation.*',
      ].join('\n');

      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- issue-analysis-questions -->',
        questionsBody,
      );

      await gh.ensureLabels(['analysis:needs-input']);
      await gh.addLabels(issueNumber, ['analysis:needs-input']);
    } else {
      // No blocking questions — mark as ready for fix
      await gh.ensureLabels(['analysis:ready']);
      await gh.addLabels(issueNumber, ['analysis:ready']);
    }

    logger.info(`Posted analysis plan for issue #${issueNumber}`);
  } catch (err) {
    logger.error(`Failed to analyze issue #${issueNumber}: ${err}`);
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- issue-analysis-error -->',
      `❌ **Analysis Failed**: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await engine.cleanup();
  }
}
```

---

### Step 6 — Gate the `/fix` command on blocking questions

**File:** `app/src/handlers/commands.ts → createAutofixPR()`

Before calling `engine.runFix()`, check if there are unanswered blocking questions:

```ts
async function createAutofixPR(...): Promise<number | null> {
  // ... existing branch setup ...

  let issueContext = await gh.gatherContext({ issueNumber });

  // Run analyze if no plan exists
  if (!issueContext.includes('<!-- issue-analysis-plan -->')) {
    const planMarkdown = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);
    await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);
    issueContext = await gh.gatherContext({ issueNumber });
  }

  // NEW: Check for unanswered blocking questions
  const hasQuestionsPending = await checkForUnansweredQuestions(gh, issueNumber, issueContext);
  if (hasQuestionsPending) {
    logger.info(`Issue #${issueNumber} has unanswered blocking questions — fix deferred`);
    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- autofix-deferred -->',
      [
        '⏸️ **Fix Deferred — Questions Pending**',
        '',
        'I cannot start the fix yet because there are unanswered questions in the analysis.',
        'Please answer the questions above, then comment `/fix` again.',
      ].join('\n'),
    );
    return null;
  }

  // ... continue with fix ...
}

/**
 * Returns true if the issue has an analysis with blocking questions
 * that have NOT been answered in subsequent comments.
 */
async function checkForUnansweredQuestions(
  gh: GitHubHelper,
  issueNumber: number,
  issueContext: string,
): Promise<boolean> {
  // Check if a questions comment was posted (marker present in context)
  if (!issueContext.includes('<!-- issue-analysis-questions -->')) {
    return false; // No questions were raised
  }

  // Check if the issue has the 'analysis:needs-input' label removed
  // (we remove it once questions are answered)
  const issue = await gh.getIssue(issueNumber);
  if (!issue.labels.includes('analysis:needs-input')) {
    return false; // Label was removed — questions answered
  }

  // Check if there are user replies AFTER the questions comment
  const questionsCommentIdx = issue.comments.findIndex(
    c => c.body.startsWith('<!-- issue-analysis-questions -->')
  );
  if (questionsCommentIdx === -1) return true;

  const repliesAfter = issue.comments.slice(questionsCommentIdx + 1).filter(
    c => !c.author.includes('[bot]')
  );

  return repliesAfter.length === 0; // No user replies after questions
}
```

---

### Step 7 — Bundle user answers into fix context

**File:** `app/src/handlers/commands.ts → createAutofixPR()`

When questions have been answered, collect the Q&A and include it in the fix context:

```ts
// Collect Q&A from issue comments
const qaContext = buildQAContext(issue.comments, issueContext);
if (qaContext) {
  issueContext += '\n\n## User-Provided Answers\n\n' + qaContext;
}

function buildQAContext(
  comments: IssueComment[],
  issueContext: string,
): string {
  // Find the questions comment position
  const questionsIdx = comments.findIndex(
    c => c.body.startsWith('<!-- issue-analysis-questions -->')
  );
  if (questionsIdx === -1) return '';

  // Collect all subsequent non-bot comments as answers
  const answers = comments.slice(questionsIdx + 1).filter(
    c => !c.author.includes('[bot]')
  );

  if (answers.length === 0) return '';

  const lines = ['### Q&A Context (from issue discussion)'];
  for (const answer of answers) {
    lines.push(`**@${answer.author}:** ${answer.body}`);
    lines.push('');
  }
  return lines.join('\n');
}
```

---

### Step 8 — Handle question-answer interaction: remove `analysis:needs-input` label

**File:** `app/src/index.ts`

Add a subscriber that watches for human replies on issues with the `analysis:needs-input` label:

```ts
const questionAnsweredSubscriber: Subscriber = {
  name: 'QuestionAnsweredSubscriber',
  subscribedEvents: ['comment.created'],
  async handle(event: GitHubEvent, signal?: AbortSignal) {
    if (signal?.aborted) return;
    try {
      const payload = event.payload as Record<string, unknown>;
      const comment = payload.comment as Record<string, string> | undefined;
      const issue = payload.issue as Record<string, unknown> | undefined;

      if (!comment || !issue) return;
      if (issue.pull_request) return; // Only issues, not PRs
      if ((comment.user as Record<string, string>)?.type === 'Bot') return;

      // Check if the issue has the 'analysis:needs-input' label
      const labels = (issue.labels as Array<Record<string, string>>)?.map(l => l.name) ?? [];
      if (!labels.includes('analysis:needs-input')) return;

      const issueNumber = (issue.number as number) || 0;
      if (!issueNumber) return;

      const config = buildConfig();
      const gh = new GitHubHelper(getToken(), event.repo || '');

      // Remove 'analysis:needs-input' and add 'analysis:ready'
      await gh.setLabels(issueNumber, ['analysis:ready'], ['analysis:needs-input']);

      // Post a confirmation comment
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- analysis-answers-received -->',
        '✅ **Answers received.** You can now comment `/fix` to start the implementation.',
      );

      logger.info(`Received answers for issue #${issueNumber} — marked as analysis:ready`);
    } catch (err) {
      logger.error(`QuestionAnsweredSubscriber failed: ${err instanceof Error ? err.message : err}`);
    }
  },
};
```

---

### Step 9 — Action path: same fix gate in `action/src/fix.ts`

**File:** `action/src/fix.ts → runFixIssue()`

Add the same question-gate check before calling `engine.runFix()`:

```ts
// After gathering issue context and running analyze:
const hasUnansweredQuestions = issueContext.includes('<!-- issue-analysis-questions -->') 
  && issue.labels.includes('analysis:needs-input');

if (hasUnansweredQuestions) {
  core.info('Issue has unanswered blocking questions — skipping fix');
  await gh.postOrUpdateComment(
    issueNumber,
    '<!-- autofix-deferred -->',
    '⏸️ **Fix Deferred** — Please answer the analysis questions first, then re-trigger `/fix`.',
  );
  core.setOutput('changes_made', 'false');
  return;
}
```

---

### Step 10 — Workflow: subscribe `issues.opened` in self-review.yml

**File:** `.github/workflows/self-review.yml`

Add `issues: [opened]` to the trigger list and a new `analyze-issue` job:

```yaml
on:
  pull_request:
    types: [opened, synchronize, labeled, closed]
  issues:
    types: [labeled, opened]    # ADD 'opened'
  issue_comment:
    types: [created]
  ...

analyze-issue:
  if: |
    github.event_name == 'issues' &&
    github.event.action == 'opened' &&
    github.event.issue.pull_request == null
  runs-on: ubuntu-latest
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@v6
      with:
        fetch-depth: 1
        token: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}

    - uses: ./action
      with:
        mode: analyze
        model: 'opencode/deepseek-v4-flash-free'
        github_token: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
        openai_api_key: ${{ secrets.OPENAI_API_KEY }}
        anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
        gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

---

### Step 11 — Add `analyze` mode to action dispatch

**File:** `action/src/index.ts`

The `analyze` mode currently exists only in the Probot app path. The action does not dispatch it. Add it:

```ts
case 'analyze': {
  const { runAnalyzeIssue } = await import('./analyze.js');
  await runAnalyzeIssue(inputs, config, engine, gh);
  break;
}
```

**File:** `action/src/analyze.ts` — Create or expand:

```ts
export async function runAnalyzeIssue(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
): Promise<void> {
  const issueNumber = github.context.payload.issue?.number;
  if (!issueNumber) {
    core.setFailed('Could not determine issue number for analyze');
    return;
  }

  const issueContext = await gh.gatherContext({ issueNumber });
  const planMarkdown = await engine.runAnalyze(issueNumber, issueContext);

  const parsed = parseAnalysisPlan(planMarkdown);

  await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

  if (parsed.hasBlockingQuestions) {
    // Post questions and label
    ...
    await gh.addLabels(issueNumber, ['analysis:needs-input']);
  } else {
    await gh.addLabels(issueNumber, ['analysis:ready']);
  }

  core.setOutput('has_blocking_questions', String(parsed.hasBlockingQuestions));
  core.setOutput('confidence_level', parsed.confidenceLevel);
}
```

---

## Implementation Checklist

- [ ] `lib/src/types/index.ts` — Add `issue.opened` to `GitHubEventType`
- [ ] `lib/src/event-bus/router.ts` — Route `issues.opened` webhook to `issue.opened` event
- [ ] `lib/src/prompts/builder.ts` — Update `buildAnalyzePrompt()` for structured output with Blocking Questions section
- [ ] `lib/src/engine.ts` or new utility — Add `parseAnalysisPlan()` function
- [ ] `app/src/index.ts` — Add `AutoAnalyzeSubscriber` for `issue.opened`
- [ ] `app/src/index.ts` — Add `QuestionAnsweredSubscriber` for removing `analysis:needs-input` label
- [ ] `app/src/handlers/commands.ts` — Update `handleAnalyzeCommand()` to post questions + apply labels
- [ ] `app/src/handlers/commands.ts` — Add `checkForUnansweredQuestions()` gate in `createAutofixPR()`
- [ ] `app/src/handlers/commands.ts` — Bundle Q&A into fix context via `buildQAContext()`
- [ ] `action/src/fix.ts` — Add unanswered-questions gate in `runFixIssue()`
- [ ] `action/src/analyze.ts` — Expand to post plan + questions + labels
- [ ] `action/src/index.ts` — Add `analyze` case to action dispatch
- [ ] `.github/workflows/self-review.yml` — Add `issues: [opened]` trigger and `analyze-issue` job
- [ ] Create labels `analysis:ready` and `analysis:needs-input` in repo label setup

---

## State Machine for Issues

```
Issue opened
    │
    ▼
[AutoAnalyze runs]
    │
    ├─→ No blocking questions ──→ label: analysis:ready
    │                                    │
    │                                    └──→ /fix triggers immediately
    │
    └─→ Blocking questions found ──→ label: analysis:needs-input
                                            │
                                            │  (user replies to questions)
                                            ▼
                                    [QuestionAnswered fires]
                                    label changes to: analysis:ready
                                            │
                                            └──→ /fix now allowed
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Auto-analyze fires on bot-created issues (audit findings) | Filter out `user.type === 'Bot'` in `AutoAnalyzeSubscriber` |
| LLM doesn't follow the structured output format | Add output parsing fallback: if section not found, treat as "no blocking questions" |
| Users confused by the gate | Clear messaging: "Please answer Q1 and Q2 above, then comment `/fix`" |
| Questions are vague or unnecessary | Prompt engineering: "Only include BLOCKING questions — not nice-to-haves" |
| Race condition: /fix triggered before auto-analyze finishes | The gate checks the issue context which includes the analysis plan marker — if not present, analyze runs first anyway |
