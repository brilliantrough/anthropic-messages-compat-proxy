# 快速开始

[English](../quickstart.md) | [中文](./quickstart.md)

这份指南会从仓库跟踪的公开示例文件启动一个本地 Anthropic Messages 代理实例。

客户端向本代理发送 Anthropic `POST /v1/messages` 请求。代理把 Anthropic Messages 请求转发到上游，并调用由 base URL 拼出的上游 `/v1/messages` 和 `/v1/models` 端点。

## 环境要求

- `Node 22+`
- `npm`
- 一个接受 Anthropic 风格 `/v1/messages` 的上游 provider

## 1. 安装依赖

```bash
npm install
```

## 2. 创建运行时文件

复制仓库中的 example 实例，再从示例文件创建本地运行时文件：

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

真实 key 放在 `instances/proxy-11234/` 中。运行时副本会被 git 忽略，`*.example` 文件保持公开安全。

## 3. 配置渠道与模型

编辑 `instances/proxy-11234/fallback.json`，至少声明一个渠道和它服务的模型：

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

代理把 Messages 调用发送到 `<base_url>/v1/messages`，模型列表发送到 `<base_url>/v1/models`，`base_url` 会去掉结尾斜杠。

客户端可以发送任意本地 `x-api-key`，该值不会转发到上游；出站上游 `x-api-key` 来自实际服务该请求的渠道。

只有 `models` 里列出的 canonical model 可以被请求。`public-claude` 是 alias：转发前解析为 `claude-sonnet-4-5`，响应回显客户端请求的别名。

## 4. 检查实例文件路径

示例 `.env` 已经把 runtime 与 admin UI 指向复制出的文件：

```env
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

`fallback.json` 就是第 3 步的路由文档。用量历史默认写在它旁边的 `usage.sqlite`，除非用 `PROXY_USAGE_DB_PATH` 覆盖。

## 5. 构建

```bash
npm run build
```

## 6. 加载实例环境并启动

```bash
node --env-file=instances/proxy-11234/.env dist/anthropic-proxy.js
```

该命令会运行编译后的 Anthropic 代理入口。`PROXY_ENV_PATH` 告诉 runtime，admin reload 流程应读取哪个 `.env` 文件。

## 7. 检查健康状态

```bash
curl -s http://127.0.0.1:11234/healthz
```

预期字段包括 `ok`、`instanceName`、`primaryProviderName`、`upstreamMessagesUrl`、`upstreamModelsUrl`、`anthropicVersion`、`modelMappings` 和 `claudeBillingHeaderMode`。

## 8. 发送非流式消息

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

请求体是 Anthropic 原生形状，使用 `model`、`max_tokens` 和 `messages`。

由于 `public-claude` 是 alias，代理会向上游发送 `claude-sonnet-4-5`，并在成功 JSON 响应中回显 `public-claude`。

## 9. 发送流式消息

```bash
curl -N http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"public-claude","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'
```

你应该看到 Anthropic SSE 事件，例如 `message_start`、`content_block_start`、`content_block_delta`、`message_delta` 和 `message_stop`。

默认 `normalized` 模式下，代理会在可用输出开始后，把 `message_start` 中的模型改回客户端请求的别名。

## 10. 打开 Admin 页面

- Config UI: `http://127.0.0.1:11234/admin`
- Monitor UI: `http://127.0.0.1:11234/admin/monitor`
- Usage UI: `http://127.0.0.1:11234/admin/usage`

Admin 路由默认只允许 localhost。只有在可信网络控制之后，才设置 `PROXY_ADMIN_ALLOW_HOST=1`。

## 推荐首次运行设置

仓库中的示例使用这些有效默认值和起步值：

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

策略键都可以省略：runtime 会回落到上表默认值，而不是启动失败。

## 常见错误

- `fallback.json` 里没有渠道，或在 `models` 里引用了未在 `channels` 声明的渠道 id。
- 渠道 `base_url` 指向的 host 不提供 `/v1/messages`。
- 启动时没有加载 `instances/proxy-11234/.env`。
- 修改了仓库跟踪的 `*.example` 文件，而不是本地运行时文件。
- 把 `PROXY_ENDPOINT_FAILURE_THRESHOLD` 这类已弃用键留在 `.env`：它会被忽略并警告，而且管理页拒绝保存仍带该键的草稿。
- 以为 reload 后 `HOST` 或 `PORT` 会让已经运行的 listener 自动迁移，不需要重启。

## 下一步

- `docs/examples.md` 展示 `cache_control`、tools、stream mode 和 sanitized system text 的请求体。
- `docs/configuration.md` 列出当前 runtime key 和默认值。
- `docs/streaming-compatibility.md` 解释 Anthropic SSE 处理与 fallback 边界。
