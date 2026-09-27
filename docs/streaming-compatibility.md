# Streaming Compatibility

This document describes how the proxy handles Anthropic Messages SSE from upstream providers.

The proxy expects Anthropic stream events such as `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, and `error`.

## SSE Wire Format

Streaming clients call `POST /v1/messages` with `stream: true` or send `Accept: text/event-stream`.

The proxy emits:

```text
content-type: text/event-stream; charset=utf-8
cache-control: no-cache
connection: keep-alive
```

Each event uses standard SSE framing:

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"public-claude","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":4}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}
```

Network chunks are not event boundaries. The proxy buffers incoming text until it has a full blank-line-delimited SSE block, then parses that event.

## Request Shape

The upstream request remains Anthropic-native:

```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 256,
  "stream": true,
  "system": [
    {
      "type": "text",
      "text": "Use the project glossary.",
      "cache_control": {
        "type": "ephemeral"
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Explain streaming fallback."
        }
      ]
    }
  ]
}
```

The proxy may map `model`, sanitize top-level `system` billing text, and force `stream: true` for streaming clients.

It preserves native Anthropic fields such as `cache_control`, `tools`, `tool_choice`, content arrays, thinking blocks, and tool results.

`proxy_stream_mode` is proxy-local and is removed before forwarding upstream.

## Stream Modes

`normalized` is the default.

In normalized mode, the proxy parses events, buffers metadata until usable output appears, and rewrites `message_start.message.model` to the client-requested model alias.

In raw mode, the proxy forwards upstream SSE blocks with minimal changes after the same usable-output commit gate. Raw mode preserves the upstream model in events.

Selection priority:

1. Request body `proxy_stream_mode`
2. Request header `x-proxy-stream-mode`
3. Environment variable `PROXY_STREAM_MODE`
4. Default `normalized`

## Usable Output

Usable output is the boundary between safe pre-commit fallback and committed client output.

The proxy treats these Anthropic events as usable output:

| Event | Usable condition |
| --- | --- |
| `content_block_delta` | `delta.type` is `text_delta` and `delta.text` is nonempty. |
| `content_block_delta` | `delta.type` is `thinking_delta` and `delta.thinking` is nonempty. |
| `content_block_delta` | `delta.type` is `signature_delta` and `delta.signature` is nonempty. |
| `content_block_delta` | `delta.type` is `input_json_delta` and `delta.partial_json` is a string. |
| `content_block_start` | `content_block.type` is `tool_use`. |

Metadata-only events such as `message_start`, empty text starts, `ping`, and `message_stop` do not commit fallback by themselves.

## Fallback Boundary

Fallback is allowed only before usable output is written to the client.

Before commit, the proxy may try the next endpoint for connect errors, connect timeouts, body timeouts, upstream 5xx, retryable 4xx, and compatibility 4xx.

It may also switch for invalid JSON, empty output, no usable stream output, and missing usage where the path can still switch safely.

After commit, the proxy does not switch providers. If the stream times out or errors after usable output, the client stays on the active response path.

For post-commit timeouts or read failures that the proxy detects, it writes a terminal Anthropic error event when the response is still writable:

```text
event: error
data: {"type":"error","error":{"type":"server_error","message":"Stream timeout"}}
```

## Non-Stream SSE Synthesis

Some upstreams return `text/event-stream` even when the client requested JSON.

For non-stream clients, the proxy reads the SSE body, parses Anthropic events, and synthesizes a Messages JSON response when usable output is present.

Text deltas are appended into final `text` content blocks.

Thinking deltas are appended into `thinking` blocks. `signature_delta` sets the block signature.

Tool calls start from `tool_use` content blocks. `input_json_delta.partial_json` chunks are joined and parsed into the final `tool_use.input` object on `content_block_stop`.

`message_delta` contributes `stop_reason`, `stop_sequence`, and usage fields.

If synthesis succeeds, the response model is restored to the client-requested model alias.

## Tool Use Stream Example

```text
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"SF\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}
```

The first `tool_use` block start is already usable output, so provider switching is no longer allowed once that block is sent.

## Usage And Cache Fields

The proxy extracts usage from `message_start.message.usage`, `message_delta.usage`, and synthesized or direct JSON `usage` objects.

Anthropic fields are mapped internally as:

| Anthropic field | Internal stats field |
| --- | --- |
| `input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `cache_creation_input_tokens` | `cacheCreationInputTokens` |
| `cache_read_input_tokens` | `cacheReadInputTokens` |

Usage can appear more than once during a stream. The proxy merges observed usage fields as they arrive.

If a completed stream produced usable output but no extractable usage, the proxy records `stream_missing_usage` for diagnostics. It does not switch providers after output has been committed.

If a non-stream JSON response has usable content but no usage and fallback is still available, the proxy may try another endpoint before returning a final response.

## Timeout Defaults

Active defaults are:

| Timeout | Default |
| --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `30000` |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `300000` |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `30000` |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `12000` |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `60000` |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `600000` |

`PROXY_UPSTREAM_TIMEOUT_MS` covers the initial streaming upstream fetch.

`PROXY_NON_STREAM_TIMEOUT_MS` covers the initial non-stream upstream fetch.

`PROXY_FIRST_BYTE_TIMEOUT_MS` covers waiting for the first body chunk.

`PROXY_FIRST_TEXT_TIMEOUT_MS` covers waiting for usable stream output before commit.

`PROXY_STREAM_IDLE_TIMEOUT_MS` covers gaps between stream chunks.

`PROXY_TOTAL_REQUEST_TIMEOUT_MS` covers the full request lifetime.

## Debug Captures

SSE failure capture is controlled by:

```env
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
```

Missing-usage stream capture is controlled by:

```env
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
```

Capture files can contain prompts, response text, tool data, provider errors, and token usage. Enable them only for local or protected incident work.
