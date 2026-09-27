# Anthropic Messages Compatibility Proxy 中文文档

[English](../../README.md) | [中文](./README.md)

这是一个 TypeScript 兼容代理，面向暴露 Anthropic 风格 `/v1/messages` 与 `/v1/models` 端点的上游 provider。

客户端向本代理发送 Anthropic Messages API 请求。代理继续向上游发送 Anthropic Messages API 请求，并处理兼容规范化、canonical model 选路、有序渠道 fallback、流式透传与网关附加文本清理。

这不是 Anthropic 官方项目。

## 它解决什么

- 代理 `POST /v1/messages`，支持 JSON 与流式客户端。
- 代理 `GET /v1/models`，通过所选模型路由选渠道。
- 每个 canonical model 绑定有序渠道列表，支持每渠道重试与有序 fallback。
- 按渠道维护滑动窗口熔断，隔离额度耗尽，并可在监控页人工熔断/恢复。
- 在 `/admin/usage` 按 Anthropic 输入拆分口径记录每次真实上游尝试，并附带三分钟粒度的可用性灯带。
- 保留 Anthropic Messages API 的请求与响应形状。
- 转发 Anthropic SSE 事件，例如 `message_start`、`content_block_delta`、`message_delta` 和 `message_stop`。
- 当客户端没有提供 `anthropic-version` 时，注入默认 header。
- 不把客户端 `x-api-key` 转发到上游。上游认证来自实际服务该请求的渠道。
- 清理顶层 `system` 文本中的 Claude Code / Anthropic billing header 文本或动态 `cch=...` 字段，帮助可缓存 prompt 前缀保持稳定。

## 中文文档导航

- [快速开始](./quickstart.md)
- [示例](./examples.md)
- [配置说明](./configuration.md)
- [流式兼容性](./streaming-compatibility.md)
- [运维说明](./operations.md)
- [发布检查清单](./publishing-checklist.md)

## 推荐阅读顺序

1. 先看 [快速开始](./quickstart.md)，创建本地实例并发起请求。
2. 再看 [配置说明](./configuration.md)，理解路由文档、文件路径、超时、健康策略与用量口径。
3. 如果需要排查流式行为，继续看 [流式兼容性](./streaming-compatibility.md)。
4. 如果要部署、Docker 化或使用 systemd，查看 [运维说明](./operations.md)。

## 快速开始

安装依赖，并从仓库跟踪的示例文件创建本地运行实例：

```bash
npm install
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

编辑 `instances/proxy-11234/fallback.json`，声明这个实例服务的渠道与模型：

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

`channels` 保存 base URL 与 API key，`models` 给每个 canonical model 一个有序渠道列表，`aliases` 把客户端名字解析到一个 canonical model。只有配置过的模型可以被请求。

`instances/proxy-11234/.env` 保留监听与运行路径：

```env
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=anthropic-proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
ANTHROPIC_VERSION=2023-06-01
```

建议使用这些起步超时与策略设置：

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

策略键都可以省略，runtime 会回落到上表默认值。

构建并加载该实例配置启动代理：

```bash
npm run build
node --env-file=instances/proxy-11234/.env dist/anthropic-proxy.js
```

检查健康状态：

```bash
curl -s http://127.0.0.1:11234/healthz
```

验证非流式请求：

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

验证流式请求：

```bash
curl -N http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'
```

## 模型别名

路由文档可以对客户端暴露本地别名，同时把 canonical model 发给上游：

```json
{
  "aliases": {
    "public-claude": "claude-sonnet-4-5"
  }
}
```

如果客户端请求 `public-claude`，代理会向上游发送 `claude-sonnet-4-5`，并在成功的 JSON 响应与 normalized 流的 `message_start` 中回显 `public-claude`。

## Anthropic Headers

- 客户端发送的 `x-api-key` 不会转发到上游。
- 上游 `x-api-key` 来自实际服务该请求的渠道。
- 客户端提供 `anthropic-version` 时会原样转发，否则使用 `ANTHROPIC_VERSION`。
- 客户端提供 `anthropic-beta` 时会原样转发，否则在配置了 `ANTHROPIC_BETA` 时使用它。

## Claude Code Gateway 兼容

如果请求先经过面向 Claude Code 的网关，`x-anthropic-billing-header: ...` attribution 文本可能进入 Anthropic 顶层 `system` 文本。

这行文本常带动态 `cch=...` 值，可能破坏基于前缀的 prompt caching。

除非你有理由保留 attribution 文本，否则建议保持默认设置：

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

`strip_line` 是默认值，会删除整行 billing header。若需要保留 attribution 文本，可使用 `strip_cch` 只删除动态 `cch=...` 字段。用户消息不会被修改。

## 检查

```bash
npm run check
npm run build
```

## 运行时超时、路由与健康开关

- `PROXY_UPSTREAM_TIMEOUT_MS`，流式上游请求的连接超时，默认 `30000`
- `PROXY_NON_STREAM_TIMEOUT_MS`，非流式请求的连接超时，默认 `300000`
- `PROXY_FIRST_BYTE_TIMEOUT_MS`，等待首个上游 body chunk 的最长时间，默认 `30000`
- `PROXY_FIRST_TEXT_TIMEOUT_MS`，等待首段可用流内容的最长时间，默认 `12000`
- `PROXY_STREAM_IDLE_TIMEOUT_MS`，上游流 chunk 间最大空闲时间，默认 `60000`
- `PROXY_TOTAL_REQUEST_TIMEOUT_MS`，请求总生命周期上限，默认 `600000`
- `PROXY_MAX_CONCURRENT_REQUESTS`，本地活跃请求上限，默认 `128`
- `PROXY_MAX_FALLBACK_TOTAL_MS`，每次请求的 fallback 总耗时预算，默认 `30000`
- `PROXY_CHANNEL_MAX_ATTEMPTS`，每请求每渠道的尝试上限（含首次），默认 `3`
- `PROXY_CHANNEL_RETRY_DELAY_MS`，同渠道两次尝试之间的等待，默认 `500`
- `PROXY_HEALTH_WINDOW_MS`，共享渠道计数的滑动窗口，默认 `180000`
- `PROXY_HEALTH_FAILURE_THRESHOLD`，窗口内打开熔断所需的失败次数，默认 `15`
- `PROXY_HEALTH_FAILURE_RATE_THRESHOLD`，必须严格超过的失败率，默认 `0.5`
- `PROXY_HEALTH_COOLDOWN_MS`，两个阈值同时成立后的熔断时长，默认 `600000`
- `PROXY_QUOTA_COOLDOWN_MS`，额度耗尽冷却，默认 `7200000`，最晚到下一个北京时间 00:02
- `PROXY_USAGE_DB_PATH`，用量历史数据库，默认实例目录下的 `usage.sqlite`

`PROXY_ENDPOINT_FAILURE_THRESHOLD`、`PROXY_MAX_FALLBACK_ATTEMPTS` 等旧键会被忽略并在启动时警告；管理页把它们标为已停用，并拒绝保存仍带这些键的草稿。

## 当前范围

当前版本实现透明 Anthropic Messages 代理，包含 JSON 转发、canonical model 选路、有序渠道 fallback、每渠道重试、带额度隔离与人工控制的滑动窗口熔断、模型别名、header 规范化、顶层 `system` billing header 清理、`/v1/models`、`/healthz`，以及 `/admin`、`/admin/monitor`、`/admin/usage` 三个页面。

用量历史按 Anthropic 的输入拆分口径记录每一次真实上游尝试，可用性灯带每三分钟对普通模型路由采样一次。

## 友情链接

- [linux.do](https://linux.do)

## License

MIT. See `LICENSE`.
