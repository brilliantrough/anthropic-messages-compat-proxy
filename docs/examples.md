# Examples

These examples use public placeholders. Replace host, model, and key values with your local instance settings.

Every request body is Anthropic Messages shaped. The proxy preserves native Anthropic fields unless it must map the model, remove `proxy_stream_mode`, or sanitize top-level `system` billing text.

## Headers Used By Clients

```bash
-H 'Content-Type: application/json' \
-H 'x-api-key: local-client-key' \
-H 'anthropic-version: 2023-06-01'
```

The client `x-api-key` is accepted for client compatibility but is not forwarded upstream.

The upstream `x-api-key` is replaced with the API key of the channel that serves the request.

If the client sends `anthropic-version`, the proxy forwards it. Otherwise it sends `ANTHROPIC_VERSION` from config.

## Non-Streaming Message

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

The upstream receives the same Anthropic body, except the model may be mapped to a provider model ID.

## Streaming Message

```bash
curl -N http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'
```

The client receives Anthropic SSE events. In normalized mode, the proxy can restore the client-requested model alias in `message_start`.

## Optional anthropic-beta Header

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: interleaved-thinking-2025-05-14' \
  -d '{"model":"public-claude","max_tokens":256,"messages":[{"role":"user","content":"Think briefly, then answer."}]}'
```

If the client omits `anthropic-beta`, the proxy sends `ANTHROPIC_BETA` only when it is configured and nonempty.

## Model Alias

`fallback.json` aliases:

```json
{
  "aliases": {
    "public-claude": "claude-sonnet-4-5"
  }
}
```

Request:

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"messages":[{"role":"user","content":"Summarize this in one sentence."}]}'
```

The proxy forwards `claude-sonnet-4-5` upstream. Successful JSON responses and normalized stream `message_start` events use `public-claude` for the client-facing model.

## Native cache_control

Anthropic prompt caching is represented inside content blocks, not as proxy-level cache keys.

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":256,"system":[{"type":"text","text":"Use the project glossary when answering.","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"Explain the proxy fallback boundary."}]}]}'
```

The proxy preserves `cache_control` anywhere the Anthropic Messages request body carries it, including `system`, `messages`, tool inputs, and other content parts.

## Tool Use

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":512,"tools":[{"name":"get_weather","description":"Get weather for a city.","input_schema":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}],"messages":[{"role":"user","content":"What is the weather in San Francisco?"}]}'
```

Tool calls are native Anthropic `tool_use` content blocks. The proxy treats a `tool_use` block as usable output for stream fallback decisions.

## Streaming Tool Deltas

A streamed tool call usually starts with `content_block_start`, then appends JSON with `input_json_delta`:

```text
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"SF\"}"}}
```

When the proxy synthesizes JSON from an upstream stream for a non-stream client, it joins the partial JSON and places it on the final `tool_use.input` object when parsing succeeds.

## Top-Level system Billing Header Sanitation

Some gateways prepend attribution text to top-level Anthropic `system` text:

```json
{
  "model": "public-claude",
  "max_tokens": 128,
  "system": "x-anthropic-billing-header: cc_version=2.1.119; cch=dynamic-value;\n\nStable system prompt",
  "messages": [
    {
      "role": "user",
      "content": "Reply with exactly OK."
    }
  ]
}
```

With the default `PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line`, the proxy forwards:

```json
{
  "system": "Stable system prompt"
}
```

With `strip_cch`, it keeps the line but removes the dynamic `cch=` field.

Only top-level `system` text is sanitized. User messages are preserved.

## Channel Routes And Fallback

`fallback.json`:

```json
{
  "default_model": "claude-sonnet-4-5",
  "channels": [
    {
      "id": "primary",
      "name": "Primary",
      "base_url": "https://api.anthropic.com",
      "api_key": "anthropic-placeholder"
    },
    {
      "id": "fallback-a",
      "name": "Fallback A",
      "base_url": "https://fallback-a.example",
      "api_key": "fallback-a-placeholder"
    },
    {
      "id": "fallback-b",
      "name": "Fallback B",
      "base_url": "https://fallback-b.example",
      "api_key": "fallback-b-placeholder",
      "disable_cooldown": true
    }
  ],
  "models": {
    "claude-sonnet-4-5": { "channel_ids": ["primary", "fallback-a", "fallback-b"] }
  }
}
```

Credentials live inline in the routing document, so the file must stay at mode `0600`. `disable_cooldown: true` exempts that channel from the ordinary automatic breaker only; quota exhaustion and manual control still apply.

Channels are tried in the listed order, each one up to `PROXY_CHANNEL_MAX_ATTEMPTS` times, within the configured time budget.

## No-Switch Fallback After Usable Output

Streaming fallback is allowed only before usable output reaches the client.

Usable output includes nonempty `text_delta`, nonempty `thinking_delta`, nonempty `signature_delta`, any string `input_json_delta.partial_json`, and `tool_use` block starts.

After that point, the proxy does not switch channels. Later stream failures stay on the active response path, usually as the upstream event or a terminal Anthropic `error` event.

## Stream Mode Override

Use default normalized mode unless a client needs raw upstream bytes.

Header override:

```bash
curl -N http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-proxy-stream-mode: raw' \
  -d '{"model":"public-claude","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Stream one short sentence."}]}'
```

Body override:

```json
{
  "model": "public-claude",
  "max_tokens": 128,
  "stream": true,
  "proxy_stream_mode": "raw",
  "messages": [
    {
      "role": "user",
      "content": "Stream one short sentence."
    }
  ]
}
```

`proxy_stream_mode` is proxy-local and is removed before the upstream request is sent.
