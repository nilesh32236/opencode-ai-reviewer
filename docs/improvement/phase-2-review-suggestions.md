# Phase 2 — Review Suggestions: Actionable Fix Guidance

> **Severity:** Medium  
> **Effort:** Medium (2–3 days)  
> **Dependencies:** Phase 1 (shares review prompt changes)

---

## Problems Being Solved

### Problem 2.1 — Review issues raised without "how to fix" guidance

**Current behavior:**  
The review outputs a list of issues with `severity`, `file`, `line`, and `message`. The `suggestion` field is optional and in practice often missing or empty, especially for IMPORTANT and CRITICAL issues.

Looking at `buildReviewBody` in `github.ts`:
```ts
const line = `- **${i.severity.toUpperCase()}:** ${i.file}:${i.line} — ${i.message}`;
lines.push(i.suggestion ? `${line}\n  > ${i.suggestion}` : line);
```

The `> suggestion` is appended if present, but nothing in the prompt enforces it.

**Impact:**  
- Developer knows something is wrong but not how to fix it
- Increases time to resolve issues
- Reduces value of the review — "what's wrong" without "how to fix" is less actionable
- The inline comment format (suggestion diff blocks for one-click apply in GitHub UI) is never used

---

### Problem 2.2 — GitHub suggestion diff blocks not used

**Current behavior:**  
GitHub supports ` ```suggestion ` blocks in review comments for one-click code application. The codebase has the infrastructure (`buildInlineComments` in `jsonl-parser.ts`) to post inline comments, but the suggestion blocks are never generated.

**Impact:**  
Simple fixes (renaming a variable, adding a null check, fixing a typo) require the developer to manually apply the fix when GitHub could offer a "Apply suggestion" button.

---

## Proposed Solution

### Step 1 — Update the review prompt to require suggestions

**File:** `lib/src/prompts/builder.ts → buildReviewPrompt()`

Add a requirement in the prompt instructions:

```
## Suggestion Requirements

For every issue you raise, you MUST include a `suggestion` field explaining how to fix it:

- **CRITICAL issues**: Always include a concrete suggestion. If the fix is a code change of ≤ 10 lines, 
  also provide a `suggestionCode` field with the corrected code snippet.
- **IMPORTANT issues**: Always include a suggestion. Provide `suggestionCode` when the fix is clear-cut.
- **MINOR issues**: Include a suggestion where helpful; can be a brief note for style/convention issues.

The `suggestion` field should be:
1. Specific — reference the exact variable, function, or pattern to change
2. Actionable — tell the developer exactly what to do, not just what's wrong
3. Brief — 1–3 sentences or a short code snippet

Bad example:  "This should be fixed."
Good example: "Wrap the `db.query()` call in a try/catch and handle the error. Example: `try { await db.query(...) } catch (err) { logger.error(err); throw new DatabaseError(err); }`"
```

---

### Step 2 — Add `suggestionCode` to the issue type

**File:** `lib/src/types/index.ts`

Add an optional field to `ReviewIssue`:

```ts
export interface ReviewIssue {
  severity: 'critical' | 'important' | 'minor';
  file: string;
  line: number;
  message: string;
  suggestion?: string;         // Already exists — textual suggestion
  suggestionCode?: string;     // NEW — raw code for the suggestion block (GitHub diff format)
  inline?: boolean;
  commentId?: number;
}
```

---

### Step 3 — Generate GitHub suggestion diff blocks in inline comments

**File:** `lib/src/jsonl-parser.ts → buildInlineComments()`

Currently the inline comment body is:
```ts
body = `**${severity}:** ${issue.message}${issue.suggestion ? '\n\n> ' + issue.suggestion : ''}`;
```

Update to include a suggestion diff block when `suggestionCode` is present:

```ts
function buildInlineCommentBody(issue: ReviewIssue): string {
  let body = `**${issue.severity.toUpperCase()}:** ${issue.message}`;

  if (issue.suggestion) {
    body += `\n\n${issue.suggestion}`;
  }

  if (issue.suggestionCode) {
    // GitHub suggestion block — renders as one-click apply button
    body += `\n\n\`\`\`suggestion\n${issue.suggestionCode}\n\`\`\``;
  }

  return body;
}
```

---

### Step 4 — Add suggestion quality check to the meta-verification pass

**File:** `lib/src/prompts/verify.ts`

The verification pass currently filters false positives. Extend it to also flag issues where `suggestion` is missing for CRITICAL/IMPORTANT severity:

```ts
// In the verification prompt instructions:
`Additionally, flag any CRITICAL or IMPORTANT issue that has no suggestion field.
 Return these with action: "needs-suggestion" — the review pass should be re-run for those issues.`
```

**File:** `lib/src/engine.ts → verifyReviewResult()`

After the verification pass, identify issues that need suggestions and either:
- Trigger a targeted re-pass to get suggestions for just those issues (preferred)
- Log a warning and mark them for a future pass

This is a "nice to have" — implement the prompt requirement first (Step 1), then add the verification gate if quality is still poor.

---

### Step 5 — Update inline comment summary for unmapped issues

**File:** `lib/src/utils/github.ts → buildReviewBody()`

For issues in the review summary (not inline), show suggestion more prominently:

```ts
if (result.issues.length > 0) {
  lines.push('### Issues');
  lines.push('');
  for (const i of result.issues) {
    lines.push(`- **${i.severity.toUpperCase()}:** \`${i.file}:${i.line}\` — ${i.message}`);
    if (i.suggestion) {
      lines.push(`  > 💡 **How to fix:** ${i.suggestion}`);
    }
    if (i.suggestionCode) {
      lines.push('  <details><summary>Show suggested fix</summary>');
      lines.push('');
      lines.push(`  \`\`\`suggestion`);
      lines.push(`  ${i.suggestionCode}`);
      lines.push(`  \`\`\``);
      lines.push('  </details>');
    }
  }
}
```

---

## JSONL Output Schema Update

The review JSONL output needs to include `suggestionCode`. Update the prompt to instruct the model to emit it:

```json
{
  "type": "issue",
  "severity": "critical",
  "file": "lib/src/engine.ts",
  "line": 42,
  "message": "Missing null check on `pr.changedFiles` before iterating",
  "suggestion": "Add a null guard: `const files = pr.changedFiles ?? [];` before the for loop.",
  "suggestionCode": "const files = pr.changedFiles ?? [];\nfor (const file of files) {"
}
```

Update the JSONL schema validation in `lib/src/types/schemas.ts` to include `suggestionCode` as optional string.

---

## Implementation Checklist

- [ ] `lib/src/types/index.ts` — Add `suggestionCode?: string` to `ReviewIssue`
- [ ] `lib/src/types/schemas.ts` — Add `suggestionCode` to Zod schema (optional string)
- [ ] `lib/src/prompts/builder.ts` — Add suggestion requirement instructions to review prompt
- [ ] `lib/src/jsonl-parser.ts` — Update `buildInlineComments()` to generate suggestion diff blocks
- [ ] `lib/src/utils/github.ts` — Update `buildReviewBody()` to display suggestions prominently
- [ ] `lib/src/prompts/verify.ts` — Add suggestion-quality check
- [ ] Write tests for the updated `buildInlineComments()` in `lib/tests/jsonl-parser.test.ts`
- [ ] Write tests for the updated `buildReviewBody()` in `lib/tests/github.test.ts`

---

## Example Output Before vs After

### Before (current)
```
**CRITICAL:** lib/src/engine.ts:42 — Missing null check on changedFiles
```

### After (proposed)
```
**CRITICAL:** `lib/src/engine.ts:42` — Missing null check on changedFiles

> 💡 **How to fix:** Add a null guard before iterating: replace `pr.changedFiles` 
> with `pr.changedFiles ?? []` at the start of the loop.

```suggestion
const files = pr.changedFiles ?? [];
for (const file of files) {
```
```

The `suggestion` block renders as a GitHub one-click "Apply suggestion" button on inline comments.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| LLM doesn't reliably generate `suggestionCode` for every issue | Make it opt-in by severity; only enforce for CRITICAL via verification pass |
| Suggestion code is wrong or introduces new bugs | Always show it as a suggestion (not an auto-apply); developer reviews before applying |
| Multi-line suggestion blocks are malformed | Add a validation step in `buildInlineComments()` to sanitize/truncate suggestion code |
| Suggestion block format rejected by GitHub API for non-diff lines | Fall back to text suggestion if the comment's line is not in the diff |
