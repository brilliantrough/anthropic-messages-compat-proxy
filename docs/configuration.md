# Configuration

The Anthropic Messages proxy reads scalar settings from `.env` and the routing document from `fallback.json` beside it.

Scalars cover listeners, timeouts, the rolling-window policy, and debug switches. The routing document owns channels, canonical models, aliases, and the default model. Nothing else decides where a request goes.

## Anthropic Headers

```env
ANTHROPIC_VERSION=2023-06-01
ANTHROPIC_BETA=
```

`ANTHROPIC_VERSION` supplies the outbound `anthropic-version` header when the client does not send one. Its code default and example value are `2023-06-01`.

`ANTHROPIC_BETA` supplies the outbound `anthropic-beta` header only when the client omits the header and this value is nonempty.

Client `x-api-key` is never forwarded upstream. The outbound key always comes from the channel that serves the request.

## Instance Files

Each instance keeps its runtime files under `instances/<instance-name>/`:

```env
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=anthropic-proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

Defaults in code are `PORT=11234`, `HOST=0.0.0.0`, and `INSTANCE_NAME=anthropic-proxy-${PORT}`.

`PROXY_ENV_PATH` is read at startup to create the runtime config store. Changing it needs a process restart.

`FALLBACK_CONFIG_PATH` defaults to `fallback.json` beside the instance `.env`. The usage database defaults to `usage.sqlite` in the same directory and `PROXY_USAGE_DB_PATH` overrides it.

`MODEL_MAP_PATH` is ignored; aliases come from the routing document, and startup logs a warning when the key is still present.

`fallback.json` and its backups hold credentials. Keep the file mode at `0600`.

## Routing Document

`fallback.json` is the only source of channels, canonical models, aliases, and the default model:

```json
{
  "default_model": "claude-sonnet-4-5",
  "channels": [
    {
      "id": "provider-a",
      "name": "Provider A",
      "base_url": "https://provider-a.example",
      "api_key": "replace-me"
    }
  ],
  "models": {
    "claude-sonnet-4-5": { "channel_ids": ["provider-a"] }
  },
  "aliases": {
    "claude-latest": "claude-sonnet-4-5"
  }
}
```

`channels` holds inline credentials plus an optional display `name` and an optional `disable_cooldown`.

`models` maps each canonical model to an ordered channel list. The order is the fallback priority, and the admin UI keeps it as the drag-and-drop order.

`aliases` resolve to a canonical model only. An alias has no route and no health state of its own.

`default_model` may be an alias; the runtime resolves it to a canonical model at load time. Only configured models can be requested — unknown names are rejected locally instead of being forwarded.

Every channel is addressed at `<base_url>/v1/messages` and `<base_url>/v1/models`, with trailing slashes removed from `base_url`.

The Messages handler keeps native Anthropic authentication, SSE event shapes, tools, thinking blocks, model echo, and `cache_control` passthrough. OpenAI Responses and Codex compaction are out of scope for this proxy, so there is no compact route, no prompt-cache hint injection, and no response cache.

## Timeout And Concurrency Controls

These defaults are active in `src/anthropic-config.ts` and the checked-in example env files:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `30000` | Initial upstream fetch timeout for streaming requests. |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `300000` | Initial upstream fetch timeout for non-stream requests. |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `30000` | Max wait for the first response body chunk. |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `12000` | Max wait for usable stream output before pre-commit fallback. |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `60000` | Max idle gap between upstream stream chunks. |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `600000` | Total request lifetime cap. |
| `PROXY_MAX_CONCURRENT_REQUESTS` | `128` | Active request ceiling before overload rejection. |

Set a timeout to `0` only when the source code path documents that zero disables that specific guard. The example env keeps all timeout guards enabled.

## Health, Retry, And Quota Policy

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_HEALTH_WINDOW_MS` | `180000` | Rolling window for the shared channel health counters. |
| `PROXY_HEALTH_FAILURE_THRESHOLD` | `15` | Failures inside the window needed before the breaker can open. |
| `PROXY_HEALTH_FAILURE_RATE_THRESHOLD` | `0.5` | Failure rate inside the window that must be strictly exceeded. |
| `PROXY_HEALTH_COOLDOWN_MS` | `600000` | Breaker cooldown after both thresholds are met. |
| `PROXY_CHANNEL_MAX_ATTEMPTS` | `3` | Attempts per request per channel, including the first. |
| `PROXY_CHANNEL_RETRY_DELAY_MS` | `500` | Delay between two attempts on the same channel. |
| `PROXY_QUOTA_COOLDOWN_MS` | `7200000` | Quota-exhaustion cooldown before the channel is retried. |

Every real upstream attempt counts once at completion. The channel window is shared across the ordinary model routes of that channel, while each model route keeps its own window. Both `failures >= threshold` and `failure_rate > rate threshold` must hold to open the breaker, and a success does not clear the window.

`disable_cooldown` on a channel exempts it from the ordinary automatic breaker only. Quota exhaustion and manual control still apply.

Quota exhaustion skips the remaining attempts for that request and parks the channel. The cooldown ends at the earlier of `PROXY_QUOTA_COOLDOWN_MS` and the next 00:02 Beijing time (`min(now + quotaCooldownMs, next 16:02 UTC)`), so a daily quota refill releases the channel without operator action. A late success cannot clear a quota cooldown.

Deprecated keys are ignored with a startup warning: `PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS`, `PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS`, `PROXY_ENDPOINT_AUTH_COOLDOWN_MS`, `PROXY_ENDPOINT_FAILURE_THRESHOLD`, `PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES`, and `PROXY_MAX_FALLBACK_ATTEMPTS`. The admin config view marks them as stopped and refuses to save a draft that still carries them.

## Fallback Policy

A request walks the route of its canonical model from the highest-priority available channel downward. Each channel gets up to `PROXY_CHANNEL_MAX_ATTEMPTS` attempts with `PROXY_CHANNEL_RETRY_DELAY_MS` in between, then routing moves to the next channel.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_MAX_FALLBACK_TOTAL_MS` | `30000` | Wall-clock budget for fallback switching. |
| `PROXY_FALLBACK_ON_RETRYABLE_4XX` | enabled | Allow fallback for `408`, `409`, `423`, `425`, and `429`. |
| `PROXY_FALLBACK_ON_COMPAT_4XX` | enabled | Allow fallback for compatibility-style 4xx errors. |
| `PROXY_FALLBACK_COMPAT_PATTERNS` | see below | Text patterns that classify 4xx responses as compatibility failures. |
| `PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS` | see below | Text patterns that keep client errors on the current channel. |

Default compatibility fallback patterns are `model not found`, `unsupported model`, `未配置模型`, `does not support`, `unsupported parameter`, and `store must be false`.

Default client-error patterns are `invalid json`, `maximum context length`, `context length exceeded`, `too many input tokens`, `invalid tool schema`, and `json schema is invalid`.

Fallback stops immediately when a request already produced valid output, and an emitted SSE stream is never replayed. A response with valid output but missing usage is returned as-is instead of being retried, and the missing usage fields stay `NULL` in history.

## Stream, Logging, And Debug Controls

```env
PROXY_STREAM_MODE=normalized
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
```

`PROXY_STREAM_MODE` accepts `normalized` and `raw`. Unsupported or empty values become `normalized`.

Clients can override stream mode with `proxy_stream_mode` in the request body or `x-proxy-stream-mode` in headers. The body field is stripped before forwarding upstream.

`PROXY_LOG_REQUEST_BODY=1` logs request and normalized-body previews. Keep it off outside local debugging.

`PROXY_DEBUG_SSE=1` logs parsed SSE event debug data.

SSE failure and missing-usage captures can include prompts, responses, and provider errors. Keep capture settings off by default and never commit capture output.

## Admin Editing And Secrets

Admin routes are available under `/admin`, `/admin/config`, `/admin/stats`, `/admin/monitor`, and `/admin/usage`.

They are localhost-only unless explicitly opened:

```env
PROXY_ADMIN_ALLOW_HOST=0
```

Set `PROXY_ADMIN_ALLOW_HOST=1` only behind trusted network controls.

`/admin` edits the routing document in five views: channels, models, aliases, environment, and runtime. Edits stay in a draft until `Save` is pressed, so switching views or dragging a route never reaches disk on its own. `Validate` reports draft errors and warnings, `Reload` discards the draft, and `Rollback` restores the previous file.

Saving writes `fallback.json` and then reloads the runtime snapshot in one step. `POST /admin/config/reload` reloads the same document without a UI draft.

Secrets are masked on read and require explicit replacement on write. When the admin API writes `.env`, comments, quotes, and multiline formatting are not preserved.

If `HOST` or `PORT` changes, the reload response lists those names in `restartRequiredFields`. The running listener still needs a process restart before those address changes take effect.

## Usage And Uptime Storage

`/admin/usage` reads history from `usage.sqlite` in the instance directory. Each real upstream attempt becomes one row keyed by channel, canonical model, and kind, and repeated cumulative SSE usage updates that same row instead of adding a new one.

Anthropic accounting keeps the three reported input components separate and derives the inclusive input:

```
total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

The three raw values are stored as reported, and a component the upstream did not report stays `NULL` instead of becoming `0`. `usageKnown` and `cacheKnown` count the rows that reported complete input and cache data, so coverage is visible next to the sums. Cache hit rate is weighted `SUM(cache_read) / SUM(total input)` over the rows that reported both fields. `GET /admin/usage/stats` serves the aggregates and `GET /admin/uptime` the sampling history.

Uptime sampling runs on the server every 180 seconds on the UTC boundary and stores thirty days per model route. A yellow light means one threshold holds inside that model window, a red light means a real shared, quota, or manual block, green includes routes without traffic, and grey means the route was never sampled. Sampling reads local state only and never calls upstream.

## Billing-Header Sanitation

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

This setting handles gateway-added `x-anthropic-billing-header: ...` text that appears inside top-level Anthropic `system` text.

`strip_line` is the default. It removes the whole billing header line and keeps the stable system prompt.

`strip_cch` keeps the attribution line but removes the dynamic `cch=...` field.

Only top-level `system` text is sanitized. User-role content and other native Anthropic request fields are preserved.

## Prompt Cache Control Rewriting

```env
PROXY_CACHE_CONTROL_MODE=off
PROXY_CACHE_CONTROL_TTL=5m
```

`off` is the default: every client-placed `cache_control` passes through untouched, matching Anthropic-native prompt caching.

`standardize` rewrites the strategy: all client `cache_control` markers anywhere in the request (including `system` and `tools`) are stripped, then the last content block of the last message gets a single `{"type":"ephemeral","ttl":...}` breakpoint. Growing conversations then write the full prefix as a cache entry each turn and read it back on the next turn.

`PROXY_CACHE_CONTROL_TTL` picks `5m` (default, 1.25x write) or `1h` (2x write, survives longer idle gaps). The effect is observable in `/admin/usage` through the separate `cache_creation_input_tokens` / `cache_read_input_tokens` columns.
