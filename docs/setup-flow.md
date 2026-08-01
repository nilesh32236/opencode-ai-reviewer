# Setup Validation Flow

The reviewer ships an onboarding wizard (`setup` mode) that validates a deployment before the first review/audit hits a cryptic error deep in the pipeline. It runs a set of independent, non-destructive pre-flight checks and produces a clear pass/fail report with actionable messages.

## Triggering Setup

### Option 1 — `/setup` slash command (GitHub App)

Comment `/setup` (or `/oc setup`) on any issue. The Probot app clones the repository into a temp workspace, runs all checks against it, and posts the report as a comment on the issue.

### Option 2 — Manual `workflow_dispatch` (GitHub Action)

Open the **Actions** tab → **AI Setup Validation** → **Run workflow**. This runs the checks in the runner workspace and writes the report to the job summary. The workflow also listens for `issue_comment` events so a `/setup` comment triggers it automatically when you use the action instead of the app — restricted to trusted commenters (`OWNER`/`MEMBER`/`COLLABORATOR`) because the run executes with the operator's API keys. Note the workflow matches `/setup` / `/oc setup` at the start of the comment (case-insensitive); the App's `parseCommand` is slightly more lenient (tolerates leading whitespace).

## What Gets Checked

| # | Check | Passes when | Common failure |
|---|-------|-------------|----------------|
| 1 | **Secrets** | `GITHUB_TOKEN`/`INPUT_GITHUB_TOKEN` (or a GitHub App `APP_ID` + private key via `PRIVATE_KEY`/`APP_PRIVATE_KEY`/`PRIVATE_KEY_PATH`) is set, and (when a non-`opencode/*` model is configured) at least one provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENCODE_API_KEY`) is set | `Missing required secrets: GITHUB_TOKEN / INPUT_GITHUB_TOKEN (or APP_ID + private key for a GitHub App)` |
| 2 | **Permissions** | The token can read the repository (`pull` access); write scopes (`issues: write` / `pull-requests: write`) are not surfaced by the repo permissions endpoint for fine-grained tokens, so they are reported as an informational note rather than a hard failure | `Token cannot read owner/repo — ensure the token can read the repository` |
| 3 | **OpenCode CLI** | `opencode` resolves on PATH (or is auto-installed) and reports version `>= 1.1.1` | `OpenCode CLI v1.0.0 is below the minimum supported version v1.1.1` |
| 4 | **Model connectivity** | A lightweight probe (`Reply with a single word: ok`) succeeds against the configured review model within 30s (all configured models with `probe_all_models: true`) | `1 of 1 model probe(s) failed — check your API keys and model names` |
| 5 | **Config** | `.opencode-reviewer.yml` parses against the schema and referenced paths exist (audit prompts dir, target dirs, category prompt files). A missing config is valid | `Config file .opencode-reviewer.yml is valid but has 1 invalid path reference(s): ...` |

> **Design notes**
> - Secrets are checked for **presence only**; real usability is validated by the model connectivity probe.
> - The `opencode/*` model family needs **no external API key**, so a default-model deployment passes the secrets check with just a GitHub token.
> - Checks run **independently** and all results are reported — one failure never masks the others.
> - Probing uses `withRetryAndTimeout` with a 30s per-model cap plus a hard `Promise.race` timeout, so each probe always terminates within the configured budget.
> - The permissions probe issues a single API request (`GET /repos/{owner}/{repo}`) with retries disabled so an unreachable GitHub API degrades to `skip` quickly instead of burning backoff.
> - The engine does not depend on the review engine: setup works even when the main pipeline would crash (e.g. missing model keys).

## Example Report

```markdown
## 🚀 Setup Validation Report

### ✅ Secrets — PASS
All required tokens present (3)

### ✅ Permissions — PASS
Repository access verified for owner/repo

### ✅ OpenCode CLI — PASS
OpenCode CLI v1.2.3 installed

### ❌ Model Connectivity — FAIL
1 of 1 model probe(s) failed — check your API keys and model names

### ✅ Config — PASS
Config file .opencode-reviewer.yml is valid

---
**Overall: ❌ FAIL** — 1 of 5 check(s) failed.

_Setup completed in 4.2s._
```

Each failing check includes a `<details>` block with the underlying error output to guide the fix.

## Action Outputs

| Output | Description |
|--------|-------------|
| `setup_passed` | `true`/`false` — whether every check passed |
| `setup_report` | The full markdown report |

The `setup.yml` workflow fails the job when `setup_passed == false`, so a broken configuration is caught at onboarding time instead of during the first review.
