# jev-decide

Reusable composite action that queries the **Jev decision-only model** (System One
API: `POST <endpoint>`) with a caller-defined `state` and `questions` map, and
returns the structured `answers` map. **Bash + curl + jq only** — no TypeScript,
no npm dependencies.

## Usage

```yaml
- id: triage
  uses: ./.github/actions/jev-decide
  with:
    state: ${{ steps.fetch.outputs.triage_state }}
    questions: |
      {
        "triage": {
          "type": "choice",
          "instructions": "Classify this GitHub issue for an autonomous fix bot.",
          "criteria": {
            "ready": "Clear bug report or actionable task the bot can fix now",
            "needs_input": "Needs a human question answered or requirements clarified first",
            "spam": "Spam, nonsense, test, or not a real task"
          }
        }
      }
    model: jev-1.13-free
    api_key: ${{ secrets.OPENCODE_API_KEY }}
```

Read the verdict with `fromJSON(steps.triage.outputs.answers).triage.choice`
(Jev `choice` answer shape: `{type:'choice', choice:'<option>', probabilities:{...}}`).

## curl equivalent

The action performs exactly this request (with `--max-time` and fail-open handling):

```bash
curl --max-time 20 -X POST https://opencode.ai/zen/v1/systemone \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "jev-1.13-free",
    "state": "TITLE:\n<issue title>\n\nBODY:\n<issue body, truncated>",
    "questions": {
      "triage": {
        "type": "choice",
        "instructions": "Classify this GitHub issue for an autonomous fix bot.",
        "criteria": {
          "ready": "Clear bug report or actionable task the bot can fix now",
          "needs_input": "Needs a human question answered or requirements clarified first",
          "spam": "Spam, nonsense, test, or not a real task"
        }
      }
    }
  }' | jq '.answers'
```

## Inputs / outputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `state` | yes | — | Free-form decision context |
| `questions` | yes | — | JSON object string, caller-chosen ids |
| `model` | no | `jev-1.13-free` | Use `jev-1.13` for paid |
| `api_key` | yes | — | Masked via `::add-mask::` first thing |
| `endpoint` | no | `https://opencode.ai/zen/v1/systemone` | Override for tests |
| `timeout_seconds` | no | `20` | Passed to `curl --max-time` |

| Output | Meaning |
|---|---|
| `answers` | Compact JSON of the response `answers` map, or `{}` on any failure |
| `ok` | `true` only on HTTP 200 + valid JSON with an `answers` object; else `false` |
| `model` | Echo of response `.model`; empty on failure |

## Fail-open contract

The action **ALWAYS exits 0** and never fails the calling workflow. Every failure
emits a `::warning::` (with HTTP status where known, never the key or full state).

| Failure | `ok` | `answers` | HTTP call? |
|---|---|---|---|
| Missing `api_key` | `false` | `{}` | No |
| `questions` not a valid JSON object | `false` | `{}` | No |
| curl error / timeout | `false` | `{}` | Attempted |
| Non-200 HTTP status | `false` | `{}` | Yes (status in warning) |
| Invalid JSON response | `false` | `{}` | Yes |
| Valid JSON but missing `.answers` object | `false` | `{}` | Yes |
