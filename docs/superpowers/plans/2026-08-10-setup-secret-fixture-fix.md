# Setup Secret Fixture Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the setup-secret test fixture so absent provider keys are truly absent and the existing provider validation behavior is tested accurately.

**Architecture:** Keep `SetupEngine.checkSecrets()` unchanged because its provider detection is correct. Update only the test environment lifecycle to delete unset variables, then verify the targeted setup suite and all workspace gates.

**Tech Stack:** TypeScript, Vitest, pnpm workspace, Node.js environment variables.

## Global Constraints

- Preserve autonomous review, fix, and merge authority.
- Keep strict TypeScript and `.js` ESM import conventions.
- Do not change production setup behavior unless a new test proves it is defective.
- Run `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm lint` before completion.
- Commit this isolated fix with a conventional commit message.

---

### Task 1: Correct Setup Test Environment Cleanup

**Files:**
- Modify: `lib/tests/setup.test.ts:85-96`
- Test: `lib/tests/setup.test.ts:120-179`

**Interfaces:**
- Consumes: `SetupEngine.checkSecrets()` and the existing `process.env` test setup.
- Produces: A test fixture where unset provider variables are absent rather than the string `"undefined"`.

- [ ] **Step 1: Confirm the fixture failure and coercion behavior**

Run:

```bash
pnpm --filter @opencode-pr-agent/lib test -- tests/setup.test.ts
node -e "process.env.TEST_UNSET = undefined; console.log(process.env.TEST_UNSET, typeof process.env.TEST_UNSET); delete process.env.TEST_UNSET"
```

Expected: the setup suite fails only at the non-OpenCode provider-key test, and Node reports the assigned value as a string rather than an absent variable.

- [ ] **Step 2: Replace undefined assignments with deletion**

In `beforeEach`, replace the provider and credential assignments that use `process.env.NAME = undefined` with explicit deletion:

```ts
for (const key of [
  'GITHUB_TOKEN',
  'INPUT_GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'INPUT_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'INPUT_ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'INPUT_GEMINI_API_KEY',
  'OPENCODE_API_KEY',
  'INPUT_OPENCODE_API_KEY',
  'APP_ID',
  'PRIVATE_KEY',
  'PRIVATE_KEY_PATH',
  'APP_PRIVATE_KEY',
]) {
  delete process.env[key];
}
```

Retain the existing `afterEach` snapshot restoration so tests cannot leak environment changes.

- [ ] **Step 3: Run the targeted setup suite**

Run:

```bash
pnpm --filter @opencode-pr-agent/lib test -- tests/setup.test.ts
```

Expected: all setup tests pass, including the non-OpenCode model test with a missing provider key.

- [ ] **Step 4: Run the workspace verification gates**

Run in order:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Expected: every command exits with status 0 and no new warnings indicate a fixture or lifecycle regression.

- [ ] **Step 5: Mark the manifest item complete**

Update only the first unchecked item in `AUTONOMOUS_PLAN.md` from `- [ ]` to `- [x]` and record that the failure was a test environment coercion bug fixed by deleting unset variables.

- [ ] **Step 6: Commit the isolated change**

Run:

```bash
git add lib/tests/setup.test.ts AUTONOMOUS_PLAN.md
git commit -m "test: fix setup secret environment isolation"
```

Expected: one commit contains only the fixture correction and its manifest state update.
