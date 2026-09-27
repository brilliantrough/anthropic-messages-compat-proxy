# Quickstart

This guide starts one local Anthropic Messages proxy instance from the tracked public example files.

The client sends Anthropic `POST /v1/messages` requests to this proxy. The proxy forwards Anthropic Messages requests upstream and calls the upstream `/v1/messages` and `/v1/models` endpoints built from your configured base URL.

## Requirements

- `Node 22+`
- `npm`
- An upstream provider that accepts Anthropic-style `/v1/messages`

## 1. Install Dependencies

```bash
npm install
```

## 2. Create Runtime Files

Copy the checked-in example instance, then create local runtime files from the examples:

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

Keep real keys in `instances/proxy-11234/`. The runtime copy is gitignored, while the `*.example` files stay public-safe.

## 3. Configure Channels And Models

Edit `instances/proxy-11234/fallback.json` and declare at least one channel plus the models it serves:

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
    "public-claude": "claude-sonnet-4-5"
  }
}
```

The proxy sends Messages calls to `<base_url>/v1/messages` and model-list calls to `<base_url>/v1/models`, with trailing slashes removed from `base_url`.

The client may send any local `x-api-key`; that value is never forwarded upstream. The outbound upstream `x-api-key` comes from the channel that serves the request.

Only the canonical models listed under `models` can be requested. `public-claude` is an alias: it resolves to `claude-sonnet-4-5` before the request goes upstream, and responses echo the alias the client asked for.

## 4. Check Instance File Paths

The example `.env` already points the runtime and admin UI at the copied files:

```env
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

`fallback.json` is the routing document from step 3. Usage history is written to `usage.sqlite` beside it unless `PROXY_USAGE_DB_PATH` overrides the path.

## 5. Build

```bash
npm run build
```

## 6. Load The Instance Environment And Start

```bash
node --env-file=instances/proxy-11234/.env dist/anthropic-proxy.js
```

The command runs the compiled Anthropic proxy entrypoint. `PROXY_ENV_PATH` tells the runtime which `.env` file the admin reload flow should read.

## 7. Check Health

```bash
curl -s http://127.0.0.1:11234/healthz
```

Expected fields include `ok`, `instanceName`, `primaryProviderName`, `upstreamMessagesUrl`, `upstreamModelsUrl`, `anthropicVersion`, `modelMappings`, and `claudeBillingHeaderMode`.

## 8. Send A Non-Streaming Message

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

The body is Anthropic-native. It uses `model`, `max_tokens`, and `messages`.

Because `public-claude` is an alias, the proxy forwards `claude-sonnet-4-5` upstream and echoes `public-claude` in successful JSON responses.

## 9. Send A Streaming Message

```bash
curl -N http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'
```

You should see Anthropic SSE events such as `message_start`, `content_block_start`, `content_block_delta`, `message_delta`, and `message_stop`.

In default `normalized` mode, the proxy rewrites the model in `message_start` back to the client-requested alias after usable output begins.

## 10. Open Admin Pages

- Config UI: `http://127.0.0.1:11234/admin`
- Monitor UI: `http://127.0.0.1:11234/admin/monitor`
- Usage UI: `http://127.0.0.1:11234/admin/usage`

Admin routes are localhost-only by default. Set `PROXY_ADMIN_ALLOW_HOST=1` only behind trusted network controls.

## Recommended First-Run Settings

The checked-in example uses these active defaults and starting values:

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
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
```

Any of the policy keys may be omitted: the runtime falls back to the defaults above instead of failing to start.

## Common Mistakes

- Leaving `fallback.json` without a channel, or listing a channel id under `models` that was never declared in `channels`.
- Pointing a channel `base_url` at a host that lacks `/v1/messages`.
- Starting without loading `instances/proxy-11234/.env`.
- Editing tracked `*.example` files instead of local runtime files.
- Keeping a deprecated key such as `PROXY_ENDPOINT_FAILURE_THRESHOLD` in `.env`: it is ignored with a warning, and the admin UI refuses to save a draft that still carries it.
- Expecting `HOST` or `PORT` reloads to move the already-running listener without a restart.

## Next Steps

- `docs/examples.md` shows request bodies for `cache_control`, tools, stream mode, and sanitized system text.
- `docs/configuration.md` lists current runtime keys and defaults.
- `docs/streaming-compatibility.md` explains Anthropic SSE handling and fallback boundaries.
