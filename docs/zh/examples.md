# 示例

[English](../examples.md) | [中文](./examples.md)

这些示例使用公开占位值。请把 host、model 和 key 换成你的本地实例设置。

每个请求体都是 Anthropic Messages 形状。代理会保留原生 Anthropic 字段，除非必须映射模型、移除 `proxy_stream_mode`，或清理顶层 `system` billing 文本。

## 客户端使用的 Headers

```bash
-H 'Content-Type: application/json' \
-H 'x-api-key: local-client-key' \
-H 'anthropic-version: 2023-06-01'
```

客户端 `x-api-key` 会被接受以兼容客户端，但不会转发到上游。

上游 `x-api-key` 会替换为实际服务该请求的渠道的 API key。

如果客户端发送 `anthropic-version`，代理会转发它。否则代理会发送配置中的 `ANTHROPIC_VERSION`。

## 非流式消息

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

上游收到的仍是 Anthropic body。不同之处是 `model` 可能被映射成 provider 模型 ID。

## 流式消息

```bash
curl -N http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'
```

客户端会收到 Anthropic SSE 事件。`normalized` 模式下，代理可以在 `message_start` 中恢复客户端请求的模型别名。

## 可选 anthropic-beta Header

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: interleaved-thinking-2025-05-14' \
  -d '{"model":"public-claude","max_tokens":256,"messages":[{"role":"user","content":"Think briefly, then answer."}]}'
```

如果客户端省略 `anthropic-beta`，代理只会在 `ANTHROPIC_BETA` 已配置且非空时发送它。

## 模型别名

`fallback.json` 中的别名：

```json
{
  "aliases": {
    "public-claude": "claude-sonnet-4-5"
  }
}
```

请求：

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"messages":[{"role":"user","content":"Summarize this in one sentence."}]}'
```

代理向上游发送 `claude-sonnet-4-5`。成功 JSON 响应和 normalized stream `message_start` 事件会在客户端可见模型中使用 `public-claude`。

## 原生 cache_control

Anthropic prompt caching 位于 content block 内，不是代理级 cache key。

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":256,"system":[{"type":"text","text":"Use the project glossary when answering.","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"Explain the proxy fallback boundary."}]}]}'
```

代理会在 Anthropic Messages 请求体携带 `cache_control` 的任何位置保留它，包括 `system`、`messages`、tool input 和其他 content part。

## Tool Use

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":512,"tools":[{"name":"get_weather","description":"Get weather for a city.","input_schema":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}],"messages":[{"role":"user","content":"What is the weather in San Francisco?"}]}'
```

工具调用是原生 Anthropic `tool_use` content block。代理会把 `tool_use` block 视为 stream fallback 判定中的可用输出。

## 流式 Tool Deltas

流式工具调用通常以 `content_block_start` 开始，然后用 `input_json_delta` 追加 JSON：

```text
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"SF\"}"}}
```

当代理为非流式客户端从上游 stream 合成 JSON 时，会拼接 partial JSON。解析成功后，它会放入最终 `tool_use.input` 对象。

## 顶层 system Billing Header 清理

有些网关会把 attribution 文本加到顶层 Anthropic `system` 文本前面：

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

默认 `PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line` 时，代理会转发：

```json
{
  "system": "Stable system prompt"
}
```

使用 `strip_cch` 时，代理会保留该行，但删除动态 `cch=` 字段。

只有顶层 `system` 文本会被清理。用户消息会保持原样。

## 渠道路由与 Fallback

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

凭据 inline 存在路由文档里，因此文件权限必须保持 `0600`。`disable_cooldown: true` 只豁免该渠道的普通自动熔断，额度耗尽与人工阻断依然生效。

渠道按列表顺序尝试，每个渠道最多 `PROXY_CHANNEL_MAX_ATTEMPTS` 次，并受总时间预算限制。

## 可用输出后不切换 fallback

流式 fallback 只允许在可用输出到达客户端之前发生。

可用输出包括非空 `text_delta`、非空 `thinking_delta`、非空 `signature_delta`、任何字符串 `input_json_delta.partial_json`，以及 `tool_use` block start。

到达这个边界后，代理不再切换渠道。后续 stream 失败会留在当前响应路径上，通常表现为上游事件或终止性的 Anthropic `error` 事件。

## Stream Mode Override

除非客户端需要原始上游字节，否则使用默认 normalized 模式。

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

`proxy_stream_mode` 是代理本地字段，会在请求发送到上游前移除。
