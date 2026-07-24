## 2025-02-12 - Token Leaks Fixed in Logs and Comments
**Learning:** Found that errors thrown during `git push` (which can contain credentials embedded in the URL) were being posted directly to public GitHub PR comments and logs.
**Prevention:** Introduced a `sanitizeError` utility to explicitly strip tokens, API keys, and basic auth credentials from all log outputs and PR error comments.
## 2026-07-23 - Command Injection Fixed in autofix handler
**Learning:** Found that `runChecksAfterFix` configuration was being executed via `execSync(checkCmd, ...)` without shell injection protection in the App context. Although the GitHub Action parsed and validated this string properly using `validateRunChecksCommand`, the App side did not, allowing malicious `.opencode-reviewer.yml` configurations to inject arbitrary commands.
**Prevention:** Extracted `validateRunChecksCommand` to `lib/src/utils/validation.ts` so it can be shared. Replaced `execSync(checkCmd)` with `execFileSync(program, args)` in `app/src/handlers/autofix.ts`, and enforced the allowlist using `validateRunChecksCommand` before execution.
