# Setup Validation Flow

The reviewer ships an onboarding wizard (`setup` mode) that validates a deployment before the first review/audit hits a cryptic error deep in the pipeline. It runs a set of independent, non-destructive pre-flight checks and produces a clear pass/fail report with actionable messages.

## Triggering Setup

### Option 1 — `/setup` slash command (GitHub App)

Comment `/setup` (or `/oc setup`) on any issue. The Probot app clones the repository into a temp workspace, runs all checks against it, and posts the report as a comment on the issue.

### Option 2 — Manual `workflow_dispatch` (GitHub Action)

Open the **Actions** tab → **AI Setup Validation** → **Run workflow**. This runs the checks in the runner workspace and writes the report to the job summary. The workflow also listens for `issue_comment` events so a `/setup` comment triggers it automatically when you use the action instead of the app.

## What Gets Checked

| # | Check | Passes when | Common failure |
|---|-------|-------------|----------------|
| 1 | **Secrets** | `GITHUB_TOKEN`/`INPUT_GITHUB_TOKEN` is set, and (when a non-`opencode/*` model is configured) at least one provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENCODE_API_KEY`) is set | `Missing required secrets: GITHUB_TOKEN / INPUT_GITHUB_TOKEN` |
| 2 | **Permissions** | The token can read the repository and has `push` (read/write) access; GitHub App deployments also need `APP_ID` + a private key | `Token has read-only access to owner/repo — grant pull-requests: write and issues: write` |
| 3 | **OpenCode CLI** | `opencode` resolves on PATH (or is auto-installed) and reports version `>= 1.1.1` | `OpenCode CLI v1.0.0 is below the minimum supported version v1.1.1` |
| 4 | **Model connectivity** | A lightweight probe (`Reply with a single word: ok`) succeeds against the configured review model within 30s | `1 of 1 model probe(s) failed — check your API keys and model names` |
| 5 | **Config** | `.opencode-reviewer.yml` parses against the schema and referenced paths exist (audit prompts dir, target dirs, category prompt files). A missing config is valid | `Config file .opencode-reviewer.yml is valid but has 1 invalid path reference(s): ...` |

> **Design notes**
> - Secrets are checked for **presence only**; real usability is validated by the model connectivity probe.
> - The `opencode/*` model family needs **no external API key**, so a default-model deployment passes the secrets check with just a GitHub token.
> - Checks run **independently** and all results are reported — one failure never masks the others.
> - Probing uses `withRetryAndTimeout` with a 30s per-model cap so the whole run stays well under the 30-second acceptance budget.
> - The engine does not depend on the review engine: setup works even when the main pipeline would crash (e.g. missing model keys).

## Example Report

```markdown
## 🚀 Setup Validation Report

### ✅ Secrets — PASS
All required tokens present (3)

### ✅ Permissions — PASS
Read/write access verified for owner/repo

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
