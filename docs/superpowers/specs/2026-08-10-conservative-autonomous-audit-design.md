# Conservative Autonomous Audit Design

## Goal

Audit and improve the OpenCode AI Reviewer monorepo through a sequential,
evidence-backed loop while preserving all existing autonomous review, fix, and
merge authority.

## Scope

- Inspect all GitHub Actions workflows, including reusable review, audit, and
  autofix workflows and scheduled self-healing workflows.
- Verify and fix reproducible test failures, security issues, resilience bugs,
  cache correctness issues, and meaningful duplication across `lib`, `action`,
  `app`, and `cli`.
- Keep shared behavior in `lib`; wrappers consume the shared package rather than
  introducing parallel implementations.
- Do not change triggers, approval labels, merge conditions, or the authority
  to automatically merge approved changes.

## Execution Model

`AUTONOMOUS_PLAN.md` is the durable state manifest. Items are ordered and
processed one at a time:

1. Read the topmost unchecked item.
2. Reproduce or otherwise establish evidence for the item.
3. Make the smallest isolated change that resolves it.
4. Run targeted checks, followed by `pnpm build`, `pnpm typecheck`,
   `pnpm test`, and `pnpm lint`.
5. Mark the item complete only after all required checks pass.
6. Commit the item with a conventional commit message.

Changes to `lib/src` require rebuilding dependent packages and regenerating the
Action bundle. Unverified observations remain in the manifest as audit tasks
and are not changed solely because they appear plausible.

## Workflow Safety

Workflow optimizations are limited to setup deduplication, cache correctness,
concurrency isolation, permission minimization where behavior is unchanged,
input validation, and failure observability. Existing review/fix routing,
labels, and auto-merge behavior are invariants. Any workflow change must be
checked for trigger equivalence and YAML syntax before commit.

## Verification

The workspace gates are `pnpm build`, `pnpm typecheck`, `pnpm test`, and
`pnpm lint`. Targeted tests are required before the full gates for code fixes.
The initial baseline includes one failing setup-secret test and otherwise
1,809 passing tests from the first `pnpm test` run.

## Completion Criteria

The loop ends when every manifest item is either completed with evidence or
explicitly deferred with a documented reason. No claim of completion is made
without fresh verification output.
