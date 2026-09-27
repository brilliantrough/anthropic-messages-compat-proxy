# Anthropic Messages Compatibility Proxy

A TypeScript compatibility proxy for upstream providers that expose Anthropic-style `/v1/messages` and `/v1/models` endpoints.

It is designed as a transparent Anthropic-to-Anthropic proxy: clients send Anthropic Messages API requests to this proxy, and the proxy forwards Anthropic Messages API requests upstream with compatibility normalization, canonical model routing, ordered channel fallback, streaming passthrough, and safer default handling around gateway-added attribution text.

This is not an official Anthropic project.

## What It Helps With

- Proxy `POST /v1/messages` for JSON and streaming clients.
- Proxy `GET /v1/models` through the selected model route.
- Route each canonical model to an ordered channel list, with per-channel retry and ordered fallback.
- Open a rolling-window breaker per channel, isolate quota exhaustion, and control channels manually from the monitor page.
- Record every real upstream attempt with Anthropic input-split token accounting at `/admin/usage`, with a three-minute uptime band.
- Preserve Anthropic Messages API request and response shapes.
- Forward Anthropic SSE streams such as `message_start`, `content_block_delta`, `message_delta`, and `message_stop`.
- Inject a default `anthropic-version` header when clients do not provide one.
- Avoid forwarding client `x-api-key` values upstream; upstream auth comes from the channel that serves the request.
- Strip Claude Code / Anthropic billing header text or dynamic `cch=...` fields from top-level `system` text so cacheable prompt prefixes stay stable across gateways.

## Requirements

- `Node 22+` and `npm` are recommended for local runs.
- Docker is available through the included `Dockerfile` and `docker-compose.yaml`.

## Quick Start

Install dependencies and create a local runtime instance from the tracked example files:

```bash
npm install
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

Edit `instances/proxy-11234/fallback.json` and declare the channels and models this instance serves:

```json
{
  "default_model": "claude-sonnet-4-5",
  "channels": [
    {
      "id": "provider-a",
      "name": "Provider A",
      "base_url": "https://api.anthropic.com",
      "api_key": "your_api_key_here"
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

`channels` holds the base URL and API key, `models` gives each canonical model an ordered channel list, and `aliases` resolve a client-facing name to one canonical model. Only configured models can be requested.

`instances/proxy-11234/.env` keeps the listener and runtime paths:

```env
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=anthropic-proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
ANTHROPIC_VERSION=2023-06-01
```

Recommended runtime timeout and policy settings:

```env
PROXY_UPSTREAM_TIMEOUT_MS=30000
PROXY_NON_STREAM_TIMEOUT_MS=300000
PROXY_FIRST_BYTE_TIMEOUT_MS=30000
PROXY_FIRST_TEXT_TIMEOUT_MS=12000
PROXY_STREAM_IDLE_TIMEOUT_MS=60000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=600000
PROXY_MAX_CONCURRENT_REQUESTS=128
PROXY_MAX_FALLBACK_TOTAL_MS=30000
PROXY_HEALTH_WINDOW_MS=180000
PROXY_HEALTH_FAILURE_THRESHOLD=15
PROXY_HEALTH_FAILURE_RATE_THRESHOLD=0.5
PROXY_HEALTH_COOLDOWN_MS=600000
PROXY_CHANNEL_MAX_ATTEMPTS=3
PROXY_CHANNEL_RETRY_DELAY_MS=500
PROXY_QUOTA_COOLDOWN_MS=7200000
PROXY_USAGE_DB_PATH=./instances/proxy-11234/usage.sqlite
```

Every policy key may be omitted; the runtime applies the defaults above.

Build and start the proxy with that instance configuration loaded:

```bash
npm run build
node --env-file=instances/proxy-11234/.env dist/anthropic-proxy.js
```

Check health:

```bash
curl -s http://127.0.0.1:11234/healthz
```

Verify a non-streaming request:

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

Verify a streaming request:

```bash
curl -N http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'
```

## Model Aliases

The routing document can expose local aliases while sending the canonical model upstream:

```json
{
  "aliases": {
    "public-claude": "claude-sonnet-4-5"
  }
}
```

If a client requests `public-claude`, the proxy forwards `claude-sonnet-4-5` upstream and echoes `public-claude` in successful JSON responses and in normalized stream `message_start` events.

## Anthropic Headers

- `x-api-key` sent by clients is not forwarded upstream.
- The upstream `x-api-key` comes from the channel that serves the request.
- `anthropic-version` is forwarded from the client when present; otherwise `ANTHROPIC_VERSION` is injected.
- `anthropic-beta` is forwarded from the client when present; otherwise `ANTHROPIC_BETA` is used when configured.

## Claude Code Gateway Compatibility

If requests reach this proxy through Claude Code-oriented gateways, `x-anthropic-billing-header: ...` attribution text can end up inside Anthropic `system` text.

That line often carries dynamic `cch=...` values, which can break prefix-based prompt caching.

Keep this compatibility setting enabled unless you have a reason to preserve the attribution text:

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

`strip_line` is the default and removes the whole billing header line. If you need to keep the attribution text, use `strip_cch` to remove only the dynamic `cch=...` field. User messages are left untouched.

## Prompt Cache Control

By default the proxy passes every client-placed `cache_control` through untouched.

`standardize` mode rewrites the caching strategy instead: it strips every `cache_control` the client placed anywhere in the request, then marks the last content block of the last message with a single `"type": "ephemeral"` breakpoint and the configured TTL. For incrementally growing conversations this caches the whole prefix each turn and the next turn reads it back as a cache hit.

```env
PROXY_CACHE_CONTROL_MODE=off
PROXY_CACHE_CONTROL_TTL=5m
```

- `PROXY_CACHE_CONTROL_MODE` - `off` (default, pass through) or `standardize` (strip all, single breakpoint on the last message's last content block)
- `PROXY_CACHE_CONTROL_TTL` - breakpoint TTL, `5m` (default) or `1h`; `1h` writes cost 2x input tokens, `5m` writes cost 1.25x

Note `standardize` also replaces breakpoints clients such as Claude Code place on `system` and `tools`; the effect is visible in `/admin/usage` via `cache_creation_input_tokens` / `cache_read_input_tokens`.

## Checks

```bash
npm run check
npm run build
```

## Runtime Timeout, Routing, And Health Knobs

- `PROXY_UPSTREAM_TIMEOUT_MS` - connect timeout for streaming upstream requests, default `30000`
- `PROXY_NON_STREAM_TIMEOUT_MS` - connect timeout for non-stream requests, default `300000`
- `PROXY_FIRST_BYTE_TIMEOUT_MS` - max wait for first upstream body chunk, default `30000`
- `PROXY_FIRST_TEXT_TIMEOUT_MS` - max wait for first usable stream content, default `12000`
- `PROXY_STREAM_IDLE_TIMEOUT_MS` - max idle gap between upstream stream chunks, default `60000`
- `PROXY_TOTAL_REQUEST_TIMEOUT_MS` - total request lifetime cap, default `600000`
- `PROXY_MAX_CONCURRENT_REQUESTS` - local active-request ceiling, default `128`
- `PROXY_MAX_FALLBACK_TOTAL_MS` - total wall-clock fallback budget per request, default `30000`
- `PROXY_CHANNEL_MAX_ATTEMPTS` - attempts per request per channel including the first, default `3`
- `PROXY_CHANNEL_RETRY_DELAY_MS` - delay between two attempts on the same channel, default `500`
- `PROXY_CACHE_CONTROL_MODE` - cache_control rewrite policy, `off` (default, pass through) or `standardize` (strip all client markers, single ephemeral breakpoint on the last message's last content block)
- `PROXY_CACHE_CONTROL_TTL` - breakpoint TTL for `standardize` mode, `5m` (default) or `1h`
- `PROXY_HEALTH_WINDOW_MS` - rolling window for the shared channel counters, default `180000`
- `PROXY_HEALTH_FAILURE_THRESHOLD` - failures in the window needed to open the breaker, default `15`
- `PROXY_HEALTH_FAILURE_RATE_THRESHOLD` - failure rate that must be strictly exceeded, default `0.5`
- `PROXY_HEALTH_COOLDOWN_MS` - breaker cooldown once both thresholds hold, default `600000`
- `PROXY_QUOTA_COOLDOWN_MS` - quota-exhaustion cooldown, default `7200000`, capped at the next 00:02 Beijing time
- `PROXY_USAGE_DB_PATH` - usage history database, default `usage.sqlite` in the instance directory

Deprecated keys such as `PROXY_ENDPOINT_FAILURE_THRESHOLD` and `PROXY_MAX_FALLBACK_ATTEMPTS` are ignored with a startup warning. The admin config view marks them as stopped and refuses to save a draft that still carries them.

## Current Scope

This version implements a transparent Anthropic Messages proxy with JSON forwarding, canonical model routing, ordered channel fallback, per-channel retry, a rolling-window breaker with quota isolation and manual control, model aliases, header normalization, top-level `system` billing-header cleanup, `/v1/models`, `/healthz`, and the `/admin`, `/admin/monitor`, and `/admin/usage` pages.

Usage history records every real upstream attempt with the Anthropic input-split accounting, and the uptime band samples the ordinary model routes every three minutes.

## Friendly Links

- [linux.do](https://linux.do)

## License

MIT. See `LICENSE`.
