# Audit: Security & Privacy

You are auditing the **OpenCode AI Reviewer** codebase for security vulnerabilities, privacy issues, and secure coding practices. Focus on shell injection, credentials handling, and secure file operations.

Scan the target directories recursively (`lib/src`, `action/src`, `app/src`). Write findings to the output file `.opencode/audit-{category}.jsonl` in JSON Lines format.

## What to Check

### Shell Injection & Command Execution

Look for these patterns in `lib/src/opencode.ts` and `action/src/`:

**Bad — shell string interpolation:**
```ts
exec(`git diff ${unsafeBranchName}`);          // CRITICAL
exec(`opencode review --pr ${prNumber}`);       // CRITICAL
```
**Good — argument arrays:**
```ts
exec('git', ['diff', branchName]);               // safe
exec('opencode', ['review', '--pr', String(prNumber)]);  // safe
```

- **Command safety**: The agent frequently executes commands via `@actions/exec` (e.g. running linters, compilers, git commands in `opencode.ts`). Verify that all shell arguments are passed as arrays of strings rather than a raw command string. Using `exec.exec(command, args)` with args array is safe; using a single interpolated string is **critical**.
- **Input validation**: Ensure any user inputs or PR details (like PR titles, branch names, or commit messages from `@actions/github` context) are properly sanitized or passed safely to prevent command/shell injection.
- **Git operations**: In `setupOpenCode` / `configureGit` or any function running git commands, verify branch names and file paths from external sources are passed as separate args, not concatenated into command strings.

### Credentials & Token Safety
- **Hardcoded secrets**: Scan the codebase for hardcoded API keys, tokens, passwords, or credentials. Check `.env.example` and any test files.
- **Log safety**: Ensure sensitive keys (like `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_PAT`) are never logged or printed to `console.log`, `core.info`, or `core.warning`. Check that `sanitizeDbError()` from `lib/src/learning/db.ts` is used when logging database connection errors.
- **Environment filtering**: In `opencode.ts`, check that the environment passed to spawned processes is explicitly filtered (not inheriting all env vars) to avoid leaking tokens to child processes.

### Path Traversal & File Safety
- **Path Sanitization**: The agent reads and writes files in the repository. Verify that paths are resolved securely to prevent path traversal (e.g. reading/writing files outside the workspace directory via `../` tricks). Use `path.resolve()` with a workspace root check rather than raw user-controlled paths.
- **SQLite Database** (`lib/src/learning/db.ts`): Ensure SQLite operations use parameterized queries (the `?` placeholder style seen in `store.ts`) to prevent SQL injection.
- **JSON Database** (`lib/src/learning/json-db.ts`): For the JSON fallback, validate safe serialization, atomic writes, and secure path handling instead of SQL parameterization.
- **Temporary file permissions**: Files written to `.opencode/` directory (audit outputs, prompt overrides) should not be world-readable if they contain any operational metadata.

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Shell injection via command string interpolation, SQL injection via string-interpolated queries, path traversal allowing writes outside workspace, exposed credentials in source code or logs.
- **important**: Unparameterized database queries (even in JSON adapter), improper sanitization of PR details passed to shell, unsafe temp file creation with predictable names, missing env filtering in subprocess spawn.
- **minor**: Missing `.gitignore` entries for temporary folders or local DBs, verbose error output containing public metadata, unused imports of crypto modules.
