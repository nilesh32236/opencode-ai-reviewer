# OpenCode model intelligence research

**Snapshot:** 2026-09-25 (live queries run approximately 06:54–07:06 UTC)  
**Scope:** the official OpenCode CLI/source, OpenCode Zen, OpenRouter, models.dev, and first-party provider documentation. No credentials, model inference calls, repository code, issues, or GitHub state were changed.

## Executive answer

The next small, safe improvement should be **model discovery as an opt-in diagnostic/preflight**, not a hardcoded fallback or an automatic free-model router:

1. Run the pinned CLI's `opencode models <provider> --verbose` (with the same isolated environment/config as the real run), record the exact model IDs and metadata, and compare the requested model to the live list.
2. Report missing/deprecated/non-tool-capable models and current candidates. **Do not silently substitute another model.**
3. Keep the existing tiny connectivity probe as the ground truth for provider entitlement, quota, region, and capacity; catalog metadata cannot prove those properties.
4. Treat a free model as a policy choice, not merely a zero price. OpenCode's current Zen documentation gives materially different data-use terms for the free models, and the repository's current default is a contributor-trained model.

This is safer than a dynamic “free fallback” because a free model can disappear, change provider, be rate-limited, collect private PR content, or produce materially worse review comments. The recommendation is consistent with the current OpenRouter guidance: keep one harness/model pinned for a comparison, use real project prompts, and put explicit cost/quality ceilings around agent runs.

## 1. Version boundary and OpenCode discovery

### Stable pin versus current v2 documentation

The repository tests OpenCode **v1.18.31**, released 2026-09-14; the latest official v1 release observed was v1.18.32 (2026-09-21). The live documentation is marked updated 2026-09-24, and the v2 site is a separate/next line. Do not implement against whichever schema happens to be current without a version gate. The v1 tag has the `models [provider] --verbose --refresh` command; v2 documents a different server/CLI contract (including the `provider/model#variant` reference form and the `permissions`/`providers` vocabulary). The official [V1→V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/) says the server API/client contracts changed and that V1 fields without V2 equivalents are intentionally ignored.

Sources:

- [v1.18.31 release API](https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.18.31), [current release API](https://api.github.com/repos/anomalyco/opencode/releases/latest)
- [current V1 config docs](https://opencode.ai/docs/config/), [current V1 CLI docs](https://opencode.ai/docs/cli/)
- [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/), [V2 model docs](https://opencode.ai/v2/docs/models/)

### `run`, `--continue`, and `--session`

The pinned v1 source and CLI docs establish the following semantics:

| Invocation | Behavior |
|---|---|
| `opencode run --continue "next message"` | Selects the newest root session from the session list, then sends the supplied message. If no root session exists, the CLI creates a new one rather than failing. |
| `opencode run --session <id> "next message"` | Fetches that exact session; a missing session is a hard error. The supplied message is still required and is sent after the session is selected. |
| `--fork` | Clones the selected session before the new message, preserving the original history. |
| `--format json` | Emits machine-readable events, including `sessionID`; the default formatter is not a reliable event protocol for extracting IDs. |

The source calls `client.session.prompt({ sessionID, parts: [...] })` after selecting the session. Thus these flags are **conversation continuation**, not a documented no-input “resume the interrupted in-flight turn” primitive. A command such as `--session <id> "continue"` appends another user message; it does not merely restart the failed generation. `--continue` is safe only when the “last root session” is the intended one. The source orders session listing by most recently updated time and `--continue` takes the first root entry.

The v1 source also performs transient provider retries itself, up to five attempts with exponential backoff and `Retry-After` handling. A process-level retry therefore compounds an already capable in-session retry path.

Sources:

- [v1.18.31 `run` source](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/run.ts) (session selection and `session.prompt`: see the `session` and non-interactive paths)
- [v1.18.31 session implementation](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/session.ts)
- [v1.18.31 retry policy](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/retry.ts)
- [official V1 CLI docs](https://opencode.ai/docs/cli/)

**Implication for this repository:** its opt-in network resume path inserts `--session <id>` while preserving the original prompt, and its normal run creates/deletes an isolated HOME. That makes the current behavior best-effort conversation continuation inside one logical invocation, not durable cross-run checkpoint recovery. If this is addressed later, capture the ID from `--format json` and do not call the same operation a checkpoint. The current behavior is visible in [`lib/src/opencode.ts`](../../lib/src/opencode.ts#L3907-L3951) and the isolated-store rationale in [`lib/src/opencode.ts`](../../lib/src/opencode.ts#L3577-L3589).

### Configuration format and precedence

OpenCode supports JSON and JSONC. The v1 documented precedence (later sources override conflicting keys, while non-conflicting keys are merged) is:

`remote` → global `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` → project `opencode.json` → `.opencode` directories → `OPENCODE_CONFIG_CONTENT` → managed files/preferences.

The project search starts in the working directory and walks upward to the nearest Git directory. `OPENCODE_CONFIG_CONTENT` is therefore a high-precedence override, not a complete replacement for all merged configuration. The current public schema is [`https://opencode.ai/config.json`](https://opencode.ai/config.json), and `opencode debug config` is the version-aware way to inspect resolved sources.

The current V2 docs describe `permissions`, `providers`, and `provider/model#variant`; the V1 tag/docs describe `permission`, `provider`, and the V1 `--variant` flag. The repository already contains version-gated dual emission for this transition. A model-intelligence feature should consume CLI/API metadata, not parse or emit an unversioned config shape.

Sources: [V1 config source](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.31/packages/web/src/content/docs/config.mdx), [V1 schema](https://opencode.ai/config.json), [V2 config](https://opencode.ai/v2/docs/config/), [V2 migration](https://opencode.ai/v2/docs/migrate-v1/).

### Provider/model loading and metadata

The official v1 models command is implemented as follows:

- `opencode models` prints `provider/model` IDs.
- `opencode models <provider>` filters to one provider.
- `--verbose` prints a pretty JSON metadata object after each ID; this is not a single JSON document.
- `--refresh` forces a models.dev cache refresh.

The provider loader is stateful and project-specific. It combines the models.dev catalog with plugin/config providers, environment credentials, stored auth, custom providers, model/provider allowlists and denylists, and model status filtering. Deprecated models are removed; alpha models are hidden unless experimental models are enabled. `Provider.list()` is the authority for what the current process can load; a models.dev record alone is not an availability assertion.

The useful model metadata includes:

- `id`, provider ID, name/family, release date/status;
- modalities, context/input/output limits;
- tool-call, reasoning, structured-output, temperature, attachment capabilities;
- input/output/cache cost and variants;
- API/npm package information and provider-specific options/headers.

The v1 source's `Provider.Info` additionally records provider `source` (`env`, `config`, `custom`, or `api`) and `env` names. A model can therefore be present in the catalog but absent from `opencode models` because the provider is unconfigured, disabled, out of scope for the project, or its model status is filtered.

The OpenCode models service uses a cached models.opencode.ai/models.dev feed, treats a fresh cache as usable for about five minutes, refreshes in the background about every 60 minutes, and ignores refresh failures. `OPENCODE_MODELS_PATH` and `OPENCODE_MODELS_URL` can pin or redirect the catalog. A preflight should record the catalog/cache timestamp and treat refresh failure as advisory rather than inventing availability.

Sources:

- [v1.18.31 `models` command source](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/models.ts)
- [v1.18.31 provider loader](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/provider/provider.ts)
- [v1.18.31 models.dev cache service](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/core/src/models-dev.ts)
- [official models.dev API documentation](https://github.com/anomalyco/models.dev/blob/dev/README.md)
- [OpenCode models docs](https://opencode.ai/docs/models/)

The repository's `KNOWN_PROVIDERS` array is explicitly only an informational warning allowlist; unknown providers are still attempted. That is compatible with a live discovery feature, but it is not an availability list ([`lib/src/utils/model-string.ts`](../../lib/src/utils/model-string.ts#L4-L32)).

### What “available” must mean

Use these levels rather than a boolean “free/available” flag:

1. **Catalogued:** present in models.dev/provider metadata.
2. **Configured:** provider is enabled and has a valid project-specific auth/config path.
3. **Routable now:** the provider has a live endpoint/entitlement for the account, region, and request features.
4. **Capable:** the model supports the required text/tool/reasoning behavior.
5. **Successful:** a bounded connectivity probe completes.

Only the last two are meaningful for a review run. An API key, catalog record, or zero price does not establish quota, moderation, capacity, SLA, or data-retention policy.

## 2. Free-model snapshot

This is a dated observation, not a constant list. The safest implementation reads the APIs at runtime and labels the result; it should never embed the IDs below as a fallback chain.

### OpenCode Zen

The public [`https://opencode.ai/zen/v1/models`](https://opencode.ai/zen/v1/models) endpoint returned 80 model IDs at retrieval. The current Zen docs list **nine free entries**: eight text/tool-capable entries (`mimo-v2.6-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `big-pickle`, `space-bunny-free`, and `muse-spark-1.3-contributor-free`) plus `jev-1.13-free`, a structured decision model rather than a general chat model. The endpoint also still contained older IDs, including `muse-spark-1.2-contributor-free`, which the live models.dev source marked deprecated shortly after the query. This is a concrete example of why endpoint membership and hardcoded lists drift.

The v1 source's unauthenticated OpenCode provider path retains models whose catalog input price is zero, removes non-zero-input models, and uses a public sentinel. That is a useful source-level behavior, but it still is not a guarantee of inference capacity or an SLA. The docs say Zen is optional and paid by request; the free exceptions are time-limited and have different data policies:

- **Space Bunny Free:** zero retention and prompts/completions are not used for training.
- **Big Pickle, MiMo, and Ling:** prompts and/or completions may be used to improve the models.
- **Nemotron:** trial-only endpoints, requests/results are logged, and confidential use is not allowed.
- **Muse Spark Contributor:** prompts and completions are shared for training future Meta models.
- **Jev:** a decision/structured-output model, not a normal coding-chat substitute.

The current repository default is `opencode/muse-spark-1.3-contributor-free` ([`action/src/inputs.ts`](../../action/src/inputs.ts#L543-L549)). That is a privacy-policy mismatch for private repositories unless explicitly accepted. This is evidence for a warning/choice, not an automatic replacement.

Sources: [Zen docs](https://opencode.ai/docs/zen/), [current Zen docs source](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx), [Zen models API](https://opencode.ai/zen/v1/models), [v1.18.31 provider source](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/provider/provider.ts).

### OpenRouter

At retrieval, [`GET /api/v1/models`](https://openrouter.ai/api/v1/models) returned 20 IDs ending in `:free` and 24 zero-priced catalog entries overall. The extra zero-priced entries included the `openrouter/free` router, two Lyria media models, and a promotional/zero-price Space Bunny entry; zero price alone therefore does not mean “free coding chat.” All 20 `:free` entries had at least one endpoint in the official endpoint query at that moment, but this is a live observation, not a guarantee.

OpenRouter's first-party documentation says:

- `:free` is a catalog variant with its own pricing, context window, endpoints, and rate limits; append it only to a model that has a free entry.
- `openrouter/free` randomly selects an available free model after filtering for requested capabilities such as tool calling. It is intended for experimentation/learning, not deterministic production routing.
- Free-model limits are 20 requests/minute, 50 requests/day without credits, and 1,000 requests/day once the account has at least $10 in lifetime credits.
- Catalog variants can disappear; a `:free` request without a matching catalog entry fails rather than falling back to the paid base model.
- The model API and the endpoint API are separate: the catalog tells you what exists, while `/api/v1/models/{id}/endpoints` tells you which providers are currently eligible for that model.

Sources: [models API](https://openrouter.ai/api/v1/models), [free variant](https://openrouter.ai/docs/guides/routing/model-variants/free.md), [free router](https://openrouter.ai/docs/guides/routing/routers/free-router.md), [limits](https://openrouter.ai/docs/api_reference/limits.md), [model variants](https://openrouter.ai/docs/guides/routing/model-variants/overview.md), [model catalog guide](https://openrouter.ai/docs/guides/overview/models.md).

OpenRouter also exposes request-level privacy controls such as `zdr`, `data_collection: "deny"`, provider allowlists, and fallback controls. The current OpenCode provider integration does not make those choices automatically, so “OpenRouter free” is not a privacy guarantee for a private PR.

Source: [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection.md).

### models.dev

The live [`https://models.dev/api.json`](https://models.dev/api.json) response contained 223 providers and 8,178 model records; 637 records had zero input and output cost at the time of the query. That number is **not** a free hosted-model count: the database mixes free endpoints, free trials, subscription/code-plan providers, local/self-hosted models, media/decision models, and records whose provider-specific price is absent or zero. The project README says the data is community contributed TOML and provides separate provider, model, and combined catalogs.

The current API record for a model can contain provider, modality, capability, limit, cost, status, and release/update fields, but it does not prove that a particular account has a key, quota, region, endpoint, or data policy. A models.dev source commit at 2026-09-25 06:53:22 UTC marked `muse-spark-1.2-contributor-free` deprecated while the Zen API still exposed the ID. Use status filtering and a timestamp, never a stale copy.

Sources: [models.dev API](https://models.dev/api.json), [models.dev source/README](https://github.com/anomalyco/models.dev/blob/dev/README.md), [live deprecation commit](https://github.com/anomalyco/models.dev/commit/1deb3739c1a54b252689b6dad1dbd1dd74aac046).

### First-party provider examples

These illustrate why “free” needs a plan and privacy qualifier:

- **Google Gemini:** the official pricing page currently labels Gemini 3.8 Flash free-tier input/output as free, but the free tier is limited to certain models, has model/project-specific RPM/TPM/RPD limits, and uses content to improve Google products. Active limits are exposed in AI Studio, not a universal static number. [`pricing.md.txt`](https://ai.google.dev/gemini-api/docs/pricing.md.txt), [`rate-limits.md.txt`](https://ai.google.dev/gemini-api/docs/rate-limits.md.txt), [`models`](https://ai.google.dev/gemini-api/docs/models.md.txt).
- **Groq:** the official billing page has a $0 Free tier, while the rate-limit page says limits are organization-level and the exact current values are in the account dashboard. The hosted model list is account/API-key dependent through `GET https://api.groq.com/openai/v1/models`. [`billing`](https://console.groq.com/settings/billing/plans), [`rate limits`](https://console.groq.com/docs/rate-limits.md), [`models`](https://console.groq.com/docs/models.md).
- **Cerebras:** its catalog explicitly says public endpoints are available on a free **trial** and pay-as-you-go tiers, subject to rate limits and pricing. This is not a permanent free entitlement. [`model catalog`](https://inference-docs.cerebras.ai/models/overview), [`rate limits`](https://inference-docs.cerebras.ai/support/rate-limits.md).
- **NVIDIA/other providers:** provider catalogs and trial terms change independently. OpenCode Zen's current policy is a more precise source for the specific Nemotron trial exception than a generic models.dev price of zero.

## 3. Benchmarks, routing, and checkpoint guidance

### Benchmarks are useful only under a pinned harness

- [SWE-bench Verified](https://www.swebench.com/verified.html) is a 500-instance, human-validated subset. Its own guidance says model comparisons using mini-SWE-agent are only apples-to-apples within the same release/configuration; 1.x and 2.x use different tool-invocation setups. A score change can come from the harness rather than the model.
- [Terminal-Bench 4.0](https://www.tbench.ai/) (released 2026-08-28) reports resolution rate alongside cost and tokens, and its task set is continuously versioned. This supports tracking cost, latency, and tokens, not only a quality score.
- [LiveCodeBench](https://livecodebench.github.io/) continuously adds problems and explicitly reports that model ordering varies across code generation, execution, and test-output tasks. It also documents contamination concerns; a static leaderboard is not a current availability signal.

These evaluate issue resolution or coding/terminal tasks, not this reviewer's false-positive rate, actionable-comment quality, or GitHub side-effect safety. A model-intelligence change should have a project-specific canary set before any default change.

OpenRouter's first-party [Ori Eval guidance](https://openrouter.ai/docs/guides/ori/eval.md) is especially relevant: it recommends real project prompts/tool assertions, a stable harness, one pinned model per run, explicit maximum cost, baseline history, and separate CI credentials. It explicitly says a prompt cannot change the pinned model/harness during a run.

### Routing and fallback

OpenRouter's [Pareto coding router](https://openrouter.ai/docs/guides/routing/routers/pareto-router.md) selects from a curated shortlist ranked by coding percentile, then chooses the cheapest available model in the tier. Its own limitations say the shortlist changes as models/benchmarks move, the model can change, and the router cannot directly cap per-request cost or latency. Session stickiness helps within a conversation but does not make a run reproducible.

OpenRouter [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md) can retry on context errors, moderation, rate limits, and downtime, and the response reports the model actually used. That is useful for an explicitly configured availability policy, but a silent fallback can change review quality, privacy, and cost. For this project, fallback should be opt-in, logged, and evaluated—not inferred from a free-model list.

### Checkpoint pattern

OpenRouter's [long-horizon agent guidance](https://openrouter.ai/docs/cookbook/building-agents/long-horizon-agents.md) recommends hard ceilings (`maxCost`, step/token limits), persisted conversation state, and a no-new-input resume (`input: []`). That pattern avoids appending a duplicate user turn; for mutating tools, the surrounding application still needs idempotence/approval controls so a resumed call cannot duplicate a side effect. This is materially different from the OpenCode CLI's `run --session <id> "same prompt"` behavior.

For a review-only subagent, a bounded retry is relatively safe; for autofix or any run that can commit/push, the checkpoint semantics need a separate design.

## 4. Recommended small change

### Minimal scope

Add an opt-in **model discovery preflight** to the existing setup/diagnostic path (the setup engine already probes configured models with `runOpenCode` at [`lib/src/setup/engine.ts`](../../lib/src/setup/engine.ts#L466-L551)):

1. Feature-detect the installed CLI's `models --help` and use the v1 command when supported; on v2, use the versioned server/model API instead of assuming the v1 flags.
2. Run discovery with the same `HOME`, XDG paths, `OPENCODE_CONFIG_CONTENT`, provider keys, and provider config as the intended run. Do not use the developer machine's global auth.
3. Record exact IDs plus `status`, `toolcall`, `cost`, limits/modalities, and the catalog timestamp/source. For a missing model, show a small, capability-filtered candidate list and tell the operator to choose; do not rewrite the configured model.
4. Keep the existing one-word connectivity probe as the final entitlement/capacity check. Make metadata discovery advisory and bounded; a models.dev/API outage must not turn a review into a hard failure.
5. If a zero-price model is selected, surface its current provider privacy terms and mark trial/limited-availability models separately. Never infer “zero data retention” from the ID or price.

A conservative resolver can use this live sequence:

```bash
# Same environment and pinned binary as the run; provider is derived from the requested model.
opencode models "$provider" --verbose
# Optional explicit refresh; bounded and advisory.
opencode models "$provider" --verbose --refresh
# OpenRouter-specific, when that provider is configured.
curl -fsSL "https://openrouter.ai/api/v1/models/$model/endpoints"
```

Do not parse an unversioned human-formatted table as the canonical model contract. If metadata is needed on the hot path, prefer the CLI's typed/server API for the installed channel and retain a versioned fixture for tests.

### What not to do in this small change

- Do not add a static list of today's free IDs as a silent fallback.
- Do not make `openrouter/free` the default; it is random and can change behavior between reviews.
- Do not use a models.dev `cost == 0` result as proof of free hosted access, privacy, or quality.
- Do not call OpenCode's `--session` path an exact checkpoint; either fix the semantics separately or document it as conversation continuation.
- Do not add a second retry layer on top of OpenCode's five in-session transient retries without measuring duplicate work and cost.

## Uncertainty and watch items

- Live catalogs changed during this research window: Zen/models.dev already disagreed on a deprecated free ID, and OpenRouter free availability is endpoint/time dependent.
- The repository's stable pin is v1.18.31 while the public site now exposes v2; model/config/API contracts must be tested against the exact installed release.
- Provider account limits, regional availability, moderation, credits, and data policies are not represented by a public model ID.
- No benchmark here measures this reviewer's comment precision/recall or GitHub side-effect safety; any model default change needs a canary and a rollback plan.
- The report intentionally records dated representative IDs and counts, not a catalog to copy into production.

## Primary source index

- [OpenCode V1 CLI](https://opencode.ai/docs/cli/) · [models](https://opencode.ai/docs/models/) · [config](https://opencode.ai/docs/config/) · [providers](https://opencode.ai/docs/providers/) · [Zen](https://opencode.ai/docs/zen/)
- [OpenCode v1.18.31 source](https://github.com/anomalyco/opencode/tree/v1.18.31) · [models command](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/models.ts) · [run](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/run.ts) · [provider](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/provider/provider.ts) · [retry](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/retry.ts)
- [OpenCode Zen models API](https://opencode.ai/zen/v1/models) · [current Zen policy source](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx)
- [OpenRouter models API](https://openrouter.ai/api/v1/models) · [free variant](https://openrouter.ai/docs/guides/routing/model-variants/free.md) · [free router](https://openrouter.ai/docs/guides/routing/routers/free-router.md) · [limits](https://openrouter.ai/docs/api_reference/limits.md) · [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection.md)
- [models.dev API](https://models.dev/api.json) · [models.dev source](https://github.com/anomalyco/models.dev) · [deprecation commit](https://github.com/anomalyco/models.dev/commit/1deb3739c1a54b252689b6dad1dbd1dd74aac046)
- [SWE-bench Verified](https://www.swebench.com/verified.html) · [Terminal-Bench 4.0](https://www.tbench.ai/) · [LiveCodeBench](https://livecodebench.github.io/) · [Ori Eval](https://openrouter.ai/docs/guides/ori/eval.md) · [long-horizon checkpoint guidance](https://openrouter.ai/docs/cookbook/building-agents/long-horizon-agents.md)
