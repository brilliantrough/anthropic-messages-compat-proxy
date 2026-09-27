# 配置说明

[English](../configuration.md) | [中文](./configuration.md)

Anthropic Messages 代理从 `.env` 读取标量设置，从同目录的 `fallback.json` 读取路由文档。

标量负责监听、超时、滑动窗口策略与调试开关；路由文档独占渠道、canonical model、alias 与默认模型。除此之外没有第二个地方决定请求去向。

## Anthropic Headers

```env
ANTHROPIC_VERSION=2023-06-01
ANTHROPIC_BETA=
```

`ANTHROPIC_VERSION` 在客户端未发送时补上出站 `anthropic-version`，代码默认值与示例值都是 `2023-06-01`。

`ANTHROPIC_BETA` 只在客户端未发送且本值非空时补上出站 `anthropic-beta`。

客户端的 `x-api-key` 永不转发到上游，出站密钥始终来自实际服务该请求的渠道。

## 实例文件

每个实例把运行文件放在 `instances/<instance-name>/` 下：

```env
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=anthropic-proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

代码默认值为 `PORT=11234`、`HOST=0.0.0.0`、`INSTANCE_NAME=anthropic-proxy-${PORT}`。

`PROXY_ENV_PATH` 在启动时读取以创建 runtime config store，改动需要重启进程。

`FALLBACK_CONFIG_PATH` 默认指向实例 `.env` 旁的 `fallback.json`。Usage 数据库默认是同目录的 `usage.sqlite`，可用 `PROXY_USAGE_DB_PATH` 覆盖。

`MODEL_MAP_PATH` 已不再读取，alias 一律来自路由文档；该 key 仍存在时启动会打印警告。

`fallback.json` 及其备份包含凭据，文件权限保持 `0600`。

## 路由文档

`fallback.json` 是渠道、canonical model、alias 与默认模型的唯一来源：

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

`channels` 保存 inline 凭据，以及可选的显示名 `name` 和可选 `disable_cooldown`。

`models` 为每个 canonical model 指定有序渠道列表，顺序即 fallback 优先级，也正是管理页拖拽保存的顺序。

`aliases` 只解析到 canonical model，自身没有 route、没有 health state。

`default_model` 可以是 alias，运行时会解析成 canonical model。只有配置过的模型可以被请求，未知模型名会被本地拒绝而不是转发出去。

每个渠道统一使用 `<base_url>/v1/messages` 与 `<base_url>/v1/models`，`base_url` 会去掉结尾斜杠。

Messages 处理保持原生 Anthropic 认证、SSE 事件形状、工具、thinking、模型回显与 `cache_control` 透传。本代理不涉及 OpenAI Responses 与 Codex 压缩，因此没有 compact 路由、没有 prompt cache hint 注入、没有响应缓存。

## Timeout 与并发控制

以下默认值在 `src/anthropic-config.ts` 与仓库内示例 env 中生效：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `30000` | 流式请求首次上游 fetch 超时。 |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `300000` | 非流式请求首次上游 fetch 超时。 |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `30000` | 等待首个响应体分片的上限。 |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `12000` | 提交前等待可用流式输出的上限。 |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `60000` | 两个上游流分片之间的最大空闲。 |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `600000` | 单个请求的总生命周期上限。 |
| `PROXY_MAX_CONCURRENT_REQUESTS` | `128` | 活跃请求上限，超过即拒绝。 |

只有在源码路径明确写明 0 会关闭该保护时才把超时设为 `0`。示例 env 保持全部超时保护开启。

## 健康、重试与额度策略

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_HEALTH_WINDOW_MS` | `180000` | 共享渠道健康计数的滑动窗口。 |
| `PROXY_HEALTH_FAILURE_THRESHOLD` | `15` | 窗口内打开熔断所需的失败次数。 |
| `PROXY_HEALTH_FAILURE_RATE_THRESHOLD` | `0.5` | 窗口内必须严格超过的失败率。 |
| `PROXY_HEALTH_COOLDOWN_MS` | `600000` | 两个阈值同时成立后的熔断时长。 |
| `PROXY_CHANNEL_MAX_ATTEMPTS` | `3` | 每请求每渠道的尝试上限，含首次。 |
| `PROXY_CHANNEL_RETRY_DELAY_MS` | `500` | 同渠道两次尝试之间的等待。 |
| `PROXY_QUOTA_COOLDOWN_MS` | `7200000` | 额度耗尽后的冷却时长。 |

每次真实上游尝试在结束时计一次。渠道窗口对该渠道的普通模型路由共享，每个模型路由另有自己的窗口。必须同时满足 `失败数 >= 阈值` 与 `失败率 > 阈值` 才熔断，且成功不清空窗口。

渠道上的 `disable_cooldown` 只豁免普通自动熔断，额度与人工阻断依然生效。

额度耗尽会立即跳过该请求的剩余尝试并停放该渠道。冷却结束时间取 `PROXY_QUOTA_COOLDOWN_MS` 与下一个北京时间 00:02（即 `min(now + quotaCooldownMs, 下一个 16:02 UTC)`）中更早者，因此每日额度刷新无需人工介入。迟到的成功不能清除额度冷却。

以下旧键会被忽略并在启动时警告：`PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS`、`PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS`、`PROXY_ENDPOINT_AUTH_COOLDOWN_MS`、`PROXY_ENDPOINT_FAILURE_THRESHOLD`、`PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES`、`PROXY_MAX_FALLBACK_ATTEMPTS`。管理页会把它们标为已停用，并拒绝保存仍带这些键的草稿。

## Fallback 策略

请求按 canonical model 的路由从最高优先级可用渠道往下走。每个渠道最多尝试 `PROXY_CHANNEL_MAX_ATTEMPTS` 次、间隔 `PROXY_CHANNEL_RETRY_DELAY_MS`，之后切换到下一个渠道。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_MAX_FALLBACK_TOTAL_MS` | `30000` | fallback 切换的总时间预算。 |
| `PROXY_FALLBACK_ON_RETRYABLE_4XX` | 开启 | 允许 `408`、`409`、`423`、`425`、`429` 触发 fallback。 |
| `PROXY_FALLBACK_ON_COMPAT_4XX` | 开启 | 允许兼容性风格的 4xx 触发 fallback。 |
| `PROXY_FALLBACK_COMPAT_PATTERNS` | 见下 | 把 4xx 归类为兼容性失败的文本模式。 |
| `PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS` | 见下 | 让客户端错误留在当前渠道的文本模式。 |

默认兼容性模式为 `model not found`、`unsupported model`、`未配置模型`、`does not support`、`unsupported parameter`、`store must be false`。

默认客户端错误模式为 `invalid json`、`maximum context length`、`context length exceeded`、`too many input tokens`、`invalid tool schema`、`json schema is invalid`。

请求已经产出有效输出后 fallback 立即停止，已输出的 SSE 也绝不重放。有效输出但缺 usage 的响应按原样返回，缺的字段在历史里保持 `NULL`。

## Stream、Logging 与 Debug 控制

```env
PROXY_STREAM_MODE=normalized
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
```

`PROXY_STREAM_MODE` 接受 `normalized` 与 `raw`，空值或不支持的值会回落到 `normalized`。

客户端可用请求体的 `proxy_stream_mode` 或请求头 `x-proxy-stream-mode` 覆盖流模式。该请求体字段在转发前会被剥离。

`PROXY_LOG_REQUEST_BODY=1` 会记录请求体与规范化后的预览，本地调试之外保持关闭。

`PROXY_DEBUG_SSE=1` 记录解析后的 SSE 事件调试数据。

SSE 失败与缺 usage 抓取可能包含 prompt、响应和上游错误，默认保持关闭，且不要提交抓取产物。

## Admin 与 Runtime Reload

管理路由位于 `/admin`、`/admin/config`、`/admin/stats`、`/admin/monitor`、`/admin/usage`。

默认只允许本机访问，需要显式放开：

```env
PROXY_ADMIN_ALLOW_HOST=0
```

只有在受信网络控制之后才设置 `PROXY_ADMIN_ALLOW_HOST=1`。

`/admin` 用五个视图编辑路由文档：渠道、模型路由、别名、环境与运行态。所有编辑先留在草稿里，只有点 `保存` 才落盘，因此切视图或拖拽路由本身不会写盘。`校验` 报告草稿的错误与警告，`重载` 丢弃草稿，`回滚` 恢复上一版文件。

保存会写入 `fallback.json` 并同步重载 runtime snapshot。`POST /admin/config/reload` 用同一份文档重载，不涉及界面草稿。

密钥读取时掩码，写入时必须显式替换。管理 API 写 `.env` 时不保留注释、引号与多行格式。

`HOST` 或 `PORT` 变化时，reload 响应会在 `restartRequiredFields` 里列出这些名字。运行中的监听地址仍需重启进程才会变化。

## Usage 与 Uptime 存储

`/admin/usage` 从实例目录的 `usage.sqlite` 读取历史。每次真实上游尝试产生一行，按渠道、canonical model 与 kind 归类；SSE 中重复出现的累计 usage 只更新同一行，不新增行。

Anthropic 口径把三项输入分开保存，并派生出总输入：

```
总输入 = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

三项原始值按上游上报保存，上游未上报的项保持 `NULL` 而不是变成 `0`。`usageKnown` 与 `cacheKnown` 统计报告了完整输入与缓存数据的行数，覆盖率与求和并列可见。缓存命中率按报告了这两个字段的行做加权 `SUM(cache_read) / SUM(总输入)`。`GET /admin/usage/stats` 提供聚合结果，`GET /admin/uptime` 提供采样历史。

Uptime 采样由服务端每 180 秒在 UTC 边界执行，每个模型路由保留 30 天。黄灯表示该模型窗口内只有一个阈值成立，红灯表示真实的共享、额度或人工阻断，绿灯包含无请求的路由，灰色表示该路由从未被采样。采样只读本地状态，从不请求上游。

## Billing-Header 清理

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

该设置处理网关塞进顶层 Anthropic `system` 文本里的 `x-anthropic-billing-header: ...`。

`strip_line` 是默认值，整行删除该 billing header，保留稳定的 system prompt。

`strip_cch` 保留归属行，只删掉动态的 `cch=...` 字段。

只有顶层 `system` 文本会被清理，user 角色内容与其他原生 Anthropic 请求字段保持不变。

## Prompt 缓存改写

```env
PROXY_CACHE_CONTROL_MODE=off
PROXY_CACHE_CONTROL_TTL=5m
```

`off` 是默认值：客户端放在任何位置的 `cache_control` 原样透传，与 Anthropic 原生 prompt caching 行为一致。

`standardize` 会改写缓存策略：先删掉请求里所有客户端 `cache_control`（包括 `system` 和 `tools` 上的），再在最后一条消息的最后一个 content 块上放唯一的 `{"type":"ephemeral","ttl":...}` 断点。逐轮增长的会话每轮写入全量前缀缓存，下一轮整段命中读回。

`PROXY_CACHE_CONTROL_TTL` 可选 `5m`（默认，写入 1.25x）或 `1h`（写入 2x，但能跨过更长的闲置间隔）。效果可在 `/admin/usage` 通过分立的 `cache_creation_input_tokens` / `cache_read_input_tokens` 列观测。
