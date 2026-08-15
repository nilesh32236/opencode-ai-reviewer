## 2026-07-22 - Token Leaks Fixed in Logs and Comments
**Learning:** Found that errors thrown during `git push` (which can contain credentials embedded in the URL) were being posted directly to public GitHub PR comments and logs.
**Prevention:** Introduced a `sanitizeError` utility to explicitly strip tokens, API keys, and basic auth credentials from all log outputs and PR error comments.
## 2026-07-23 - Command Injection Fixed in autofix handler
**Learning:** Found that `runChecksAfterFix` configuration was being executed via `execSync(checkCmd, ...)` without shell injection protection in the App context. Although the GitHub Action parsed and validated this string properly using `validateRunChecksCommand`, the App side did not, allowing malicious `.opencode-reviewer.yml` configurations to inject arbitrary commands.
**Prevention:** Extracted `validateRunChecksCommand` to `lib/src/utils/validation.ts` so it can be shared. Replaced `execSync(checkCmd)` with `execFileSync(program, args)` in `app/src/handlers/autofix.ts`, and enforced the allowlist using `validateRunChecksCommand` before execution.
## 2026-08-09 - Command Injection Fixed in handleDocsCommand
**Learning:** In `app/src/handlers/commands.ts`, the `handleDocsCommand` used the `pr.headRef` as `baseRef` directly without verifying its structure or character content. This could allow for command injection or argument injection via malicious branch names (e.g. beginning with `-`).
**Prevention:** Added `validateRefName(pr.headRef)` to explicitly validate the PR's head ref before allowing git operations like `git pull`, `git checkout`, or `git rebase` to execute with it.
## 2026-08-15 - Command Injection Risk Fixed in self-heal handler
**Learning:** Found that `branchName` was being pushed to `origin` without validation via `exec.exec('git', ['push', 'origin', branchName, '--force-with-lease'])` in `action/src/self-heal.ts`. Although `exec` is mostly safe from shell injection, malicious branch names (e.g. beginning with `-`) could still cause argument injection to git.
**Prevention:** Added `validateRefName(branchName)` to explicitly validate the dynamically generated `branchName` before allowing git push operations to execute with it.
