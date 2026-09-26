# MCP tools-list caching

The MCP client caches each server's tool list so repeated calls do not re-issue
`listTools` on every request. The cache is populated at connect time where the
connect path primes it, and is otherwise refreshed on demand.

## Configuring the TTL

By default a cached list never expires, which is the pre-existing behaviour.

| Setting | Scope | Effect |
| --- | --- | --- |
| `mcp_servers[].toolsCacheTtlMs` | one server | TTL for that server's list |
| `MCP_TOOLS_CACHE_TTL_MS` | all servers | default TTL, used where a server sets none |

Precedence is **per-server → env → never-expire**.

These are read from the environment on every resolution, not captured at import,
so a TTL can be changed or switched off without restarting the process. Setting
the variable to `0`, to a negative value, or removing it restores never-expire.

`MCP_TOOLS_CACHE_TTL_MS` is read from the process environment. A consuming
GitHub Actions workflow must set it through the step's `env:` block; there is no
`action.yml` input for it.

`toolsCacheTtlMs` is floored at **1000 ms**. A sub-second TTL is almost
certainly a mistake, and combined with an unreachable server it would turn every
call into a fresh `listTools` retry ladder. Values below the floor are rejected
by the schema rather than silently honoured.

Note that `mcp_servers` is parsed with `safeParse`, and a validation failure
falls back to the default server list. A malformed `toolsCacheTtlMs` therefore
disables the whole MCP configuration, not just this setting.

## Behaviour on expiry

Within the TTL the cached list is returned with no network call. Past the TTL a
single refresh is attempted; concurrent callers share that one call.

If the refresh fails, the **stale** list is returned and no further attempt is
made for 30 seconds. Without that backoff, an unreachable server would cost a
full retry ladder (3 attempts plus backoff) on *every* call, forever. After the
backoff window elapses the next call retries.

Cancellation always propagates; it is never converted into stale data.

## Is a stale tool list a security problem?

No. `allowedTools` is re-read and re-applied on every call, so narrowing a
server's allowed tools takes effect immediately regardless of how old the cached
list is. A stale list can only:

- attempt a tool the server has since removed — the server rejects it, and
- miss a tool added since the list was fetched — which fails safe.

These are correctness and availability concerns, not privilege escalation.

## What this is not

This covers the tools-list cache only. It is unrelated to
[OpenCode CLI checksum verification](./opencode-checksums.md), which governs the
CLI binary rather than MCP tool metadata.
