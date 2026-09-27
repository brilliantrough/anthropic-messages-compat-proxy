# 流式兼容性

[English](../streaming-compatibility.md) | [中文](./streaming-compatibility.md)

本文说明代理如何处理上游 provider 返回的 Anthropic Messages SSE。

代理期望的 Anthropic stream events 包括 `message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`、`ping` 和 `error`。

## SSE Wire Format

流式客户端调用 `POST /v1/messages`，并在请求体中设置 `stream: true`，或发送 `Accept: text/event-stream`。

代理输出：

```text
content-type: text/event-stream; charset=utf-8
cache-control: no-cache
connection: keep-alive
```

每个事件使用标准 SSE framing：

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

网络 chunk 不是 event 边界。代理会缓冲收到的文本，直到拿到完整的空行分隔 SSE block，再解析该 event。

## Request Shape

上游请求保持 Anthropic-native：

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

代理可能映射 `model`，清理顶层 `system` billing 文本，并为流式客户端强制 `stream: true`。

它会保留原生 Anthropic 字段，例如 `cache_control`、`tools`、`tool_choice`、content arrays、thinking blocks 和 tool results。

`proxy_stream_mode` 是代理本地字段，会在转发上游前移除。

## Stream Modes

`normalized` 是默认值。

在 normalized 模式下，代理会解析 events，缓冲 metadata 直到可用输出出现，并把 `message_start.message.model` 改为客户端请求的模型别名。

在 raw 模式下，代理在相同的可用输出 commit gate 之后，以最少改动转发上游 SSE blocks。Raw 模式会保留 event 中的上游模型。

选择优先级：

1. Request body `proxy_stream_mode`
2. Request header `x-proxy-stream-mode`
3. Environment variable `PROXY_STREAM_MODE`
4. Default `normalized`

## Usable Output

可用输出是安全 pre-commit fallback 与已提交客户端输出之间的边界。

代理把这些 Anthropic events 视为可用输出：

| Event | Usable condition |
| --- | --- |
| `content_block_delta` | `delta.type` is `text_delta` and `delta.text` is nonempty. |
| `content_block_delta` | `delta.type` is `thinking_delta` and `delta.thinking` is nonempty. |
| `content_block_delta` | `delta.type` is `signature_delta` and `delta.signature` is nonempty. |
| `content_block_delta` | `delta.type` is `input_json_delta` and `delta.partial_json` is a string. |
| `content_block_start` | `content_block.type` is `tool_use`. |

Metadata-only events 不会自行提交 fallback，例如 `message_start`、empty text starts、`ping` 和 `message_stop`。

## Fallback Boundary

Fallback 只允许在可用输出写给客户端之前发生。

Commit 前，代理可以为 connect errors、connect timeouts、body timeouts、upstream 5xx、retryable 4xx 和 compatibility 4xx 尝试下一个 endpoint。

在仍能安全切换的路径上，代理也可以为 invalid JSON、empty output、no usable stream output 和 missing usage 切换 endpoint。

Commit 后，代理不再切换 providers。如果 stream 在可用输出后 timeout 或 error，客户端会留在当前响应路径上。

对于代理检测到的 post-commit timeout 或 read failure，如果响应仍可写，代理会写入终止性的 Anthropic error event：

```text
event: error
data: {"type":"error","error":{"type":"server_error","message":"Stream timeout"}}
```

## Non-Stream SSE Synthesis

有些上游即使客户端请求 JSON，也会返回 `text/event-stream`。

对于非流式客户端，代理会读取 SSE body，解析 Anthropic events，并在存在可用输出时合成 Messages JSON response。

Text deltas 会追加到最终 `text` content blocks。

Thinking deltas 会追加到 `thinking` blocks。`signature_delta` 会设置 block signature。

Tool calls 从 `tool_use` content blocks 开始。`input_json_delta.partial_json` chunks 会拼接，并在 `content_block_stop` 时解析到最终 `tool_use.input` 对象。

`message_delta` 提供 `stop_reason`、`stop_sequence` 和 usage fields。

如果合成成功，响应 model 会恢复为客户端请求的模型别名。

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

第一个 `tool_use` block start 已经是可用输出。因此该 block 发送后，provider switching 不再允许。

## Usage 与 Cache Fields

代理从 `message_start.message.usage`、`message_delta.usage`，以及 synthesized 或 direct JSON `usage` objects 中提取 usage。

Anthropic fields 在内部映射为：

| Anthropic field | Internal stats field |
| --- | --- |
| `input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `cache_creation_input_tokens` | `cacheCreationInputTokens` |
| `cache_read_input_tokens` | `cacheReadInputTokens` |

Usage 可以在 stream 中出现多次。代理会在字段到达时合并已观察到的 usage fields。

如果完成的 stream 产生了可用输出，但没有可提取 usage，代理会记录 `stream_missing_usage` 用于诊断。输出已提交后不会切换 provider。

如果非流式 JSON 响应有可用内容但没有 usage，且 fallback 仍可用，代理可能在返回最终响应前尝试另一个 endpoint。

## Timeout Defaults

有效默认值是：

| Timeout | Default |
| --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `30000` |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `300000` |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `30000` |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `12000` |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `60000` |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `600000` |

`PROXY_UPSTREAM_TIMEOUT_MS` 覆盖初始流式上游 fetch。

`PROXY_NON_STREAM_TIMEOUT_MS` 覆盖初始非流式上游 fetch。

`PROXY_FIRST_BYTE_TIMEOUT_MS` 覆盖等待第一个 body chunk。

`PROXY_FIRST_TEXT_TIMEOUT_MS` 覆盖 commit 前等待可用 stream output。

`PROXY_STREAM_IDLE_TIMEOUT_MS` 覆盖 stream chunks 之间的空闲间隔。

`PROXY_TOTAL_REQUEST_TIMEOUT_MS` 覆盖完整请求生命周期。

## Debug Captures

SSE failure capture 由以下设置控制：

```env
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
```

Missing-usage stream capture 由以下设置控制：

```env
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
```

Capture files 可能包含 prompts、response text、tool data、provider errors 和 token usage。只在本地或受保护的 incident work 中开启。
