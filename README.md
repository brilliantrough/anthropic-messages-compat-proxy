# Anthropic Messages Compatibility Proxy

A TypeScript compatibility proxy for upstream providers that expose Anthropic-style `/v1/messages` and `/v1/models` endpoints.

It is designed as a transparent Anthropic-to-Anthropic proxy: clients send Anthropic Messages API requests to this proxy, and the proxy forwards Anthropic Messages API requests upstream with compatibility normalization, model aliases, streaming passthrough, and safer default handling around gateway-added attribution text.

This is not an official Anthropic project.

## What It Helps With

- Proxy `POST /v1/messages` for JSON and streaming clients.
- Proxy `GET /v1/models` with optional model alias exposure.
- Preserve Anthropic Messages API request and response shapes.
- Forward Anthropic SSE streams such as `message_start`, `content_block_delta`, `message_delta`, and `message_stop`.
- Inject a default `anthropic-version` header when clients do not provide one.
- Avoid forwarding client `x-api-key` values upstream; upstream auth comes from local proxy config.
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
cp instances/proxy-11234/model-map.json.example instances/proxy-11234/model-map.json
```

Edit `instances/proxy-11234/.env` and fill at least:

```env
PRIMARY_PROVIDER_NAME=anthropic-compatible-provider
PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.com
PRIMARY_PROVIDER_API_KEY=your_api_key_here
PRIMARY_PROVIDER_DEFAULT_MODEL=claude-sonnet-4-5
ANTHROPIC_VERSION=2023-06-01
```

Build and start the proxy with that instance configuration loaded:

```bash
npm run build
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
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

`model-map.json` can expose local aliases while sending provider model IDs upstream:

```json
{
  "model_mappings": {
    "public-claude": "claude-sonnet-4-5"
  }
}
```

If a client requests `public-claude`, the proxy forwards `claude-sonnet-4-5` upstream and rewrites successful JSON responses back to `public-claude`.

## Anthropic Headers

- `x-api-key` sent by clients is not forwarded upstream.
- The upstream `x-api-key` comes from `PRIMARY_PROVIDER_API_KEY`.
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

## Checks

```bash
npm run check
npm run build
```

## Current Scope

This first version implements a transparent Anthropic Messages proxy with JSON forwarding, model aliases, header normalization, top-level `system` billing-header cleanup, `/v1/models`, `/healthz`, and SSE passthrough.

Fallback routing, admin UI, and monitor assets are kept in the repository skeleton for follow-up parity work with the Responses proxy, but they are not wired into the Anthropic entrypoint yet.

## Friendly Links

- [linux.do](https://linux.do)

## License

MIT. See `LICENSE`.
