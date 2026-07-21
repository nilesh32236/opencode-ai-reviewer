## 2025-02-12 - Token Leaks Fixed in Logs and Comments
**Learning:** Found that errors thrown during `git push` (which can contain credentials embedded in the URL) were being posted directly to public GitHub PR comments and logs.
**Prevention:** Introduced a `sanitizeError` utility to explicitly strip tokens, API keys, and basic auth credentials from all log outputs and PR error comments.
