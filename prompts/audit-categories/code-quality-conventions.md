# Audit: Code Quality & Conventions

You are auditing code quality and adherence to project conventions. Focus on consistency, dead code, and maintainability.

## What to Check

### Linting Compliance
- Code follows configured linting rules
- No unused variables or imports
- No `any` type without explicit suppression
- Consistent indentation and formatting

### Project Conventions
- Theme/design tokens used (no raw hex colors)
- Correct icon library used exclusively
- CSS animations preferred over JS animation libraries
- Forms use validation library

### Dead Code & Debug Artifacts
- `console.log` calls removed (or wrapped in dev-only checks)
- Commented-out code blocks removed
- Unused component props or state variables
- TODO/FIXME comments tracked and resolved

### Naming & Organization
- File names follow project conventions
- Constants use UPPER_SNAKE_CASE
- Components in correct directories
- No circular dependencies

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Lint errors, raw hex colors in production, animation library imports
- **important**: Quote violations, missing semicolons, debug console.log, unused imports
- **minor**: Indentation issues, naming drift, commented-out code