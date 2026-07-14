# Audit: Security & Privacy

You are auditing the **OpenCode AI Reviewer** codebase for security vulnerabilities, privacy issues, and secure coding practices. Focus on shell injection, credentials handling, and secure file operations.

Scan the target directories recursively (`lib/src`, `action/src`, `app/src`). Output findings to `.audit-output.jsonl`.

## What to Check

### Shell Injection & Command Execution
- **Command safety**: The agent frequently executes commands via `child_process` and `@actions/exec` (e.g. running linters, compilers, git commands). Verify that all shell arguments are passed as arrays of strings rather than a raw command string.
- **Input validation**: Ensure any user inputs or PR details (like PR titles, branch names, or commit messages) are properly sanitized or passed safely to prevent command/shell injection.

### Credentials & Token Safety
- **Hardcoded secrets**: Scan the codebase for hardcoded API keys, tokens, passwords, or credentials.
- **Log safety**: Ensure sensitive keys (like `OPENAI_API_KEY`, `GH_PAT`, `GITHUB_TOKEN`) are never logged or printed to the console or standard output.

### Path Traversal & File Safety
- **Path Sanitization**: The agent reads and writes files in the repository. Verify that paths are resolved securely to prevent path traversal (e.g. reading/writing files outside the workspace directory via `../` tricks).
- **SQLite Database**: Ensure operations on `.opencode/learning.db` use parameterized queries or prepared statements to prevent SQL injection.

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Shell injection vulnerabilities, SQL injection vulnerabilities, path traversal vulnerabilities, exposed credentials in codebase, or writing tokens to logs.
- **important**: Unparameterized database queries, improper sanitization of PR details, unsafe temporary file creations.
- **minor**: Missing `.gitignore` entries for temporary folders or local DBs, minor warning logs containing public metadata.
