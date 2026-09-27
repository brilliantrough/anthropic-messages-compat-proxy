# 运维说明

Anthropic Messages 兼容代理的部署、进程管理与运维流程。

发布仓库前先看 `docs/publishing-checklist.md`。

## 目录

- [多实例目录结构](#多实例目录结构)
- [不要提交真实实例目录](#不要提交真实实例目录)
- [构建与运行命令](#构建与运行命令)
- [活跃路由](#活跃路由)
- [本地 Admin UI](#本地-admin-ui)
- [路由、熔断与额度](#路由熔断与额度)
- [Usage 与 Uptime](#usage-与-uptime)
- [日志与 Captures](#日志与-captures)
- [Docker 部署](#docker-部署)
- [安全重启模式](#安全重启模式)
- [Systemd 模板](#systemd-模板)
- [从本地工作目录迁移](#从本地工作目录迁移)

## 多实例目录结构

每个运行实例在 `instances/` 下有自己的目录，目录名通常带端口，便于把文件、服务与健康检查对上。

```text
instances/
  example-11234/
    .env.example
    fallback.json.example
  proxy-11234/
    .env
    fallback.json
    usage.sqlite
```

从仓库内的示例目录创建新实例：

```bash
cp -r instances/example-11234 instances/proxy-NEWPORT
cp instances/proxy-NEWPORT/.env.example instances/proxy-NEWPORT/.env
cp instances/proxy-NEWPORT/fallback.json.example instances/proxy-NEWPORT/fallback.json
chmod 600 instances/proxy-NEWPORT/fallback.json
```

编辑 `instances/proxy-NEWPORT/.env`，设置 `PORT`、`HOST`、`INSTANCE_NAME`、`PROXY_ENV_PATH`、`FALLBACK_CONFIG_PATH`。

然后编辑 `fallback.json`，填好 `channels`、`models`、`aliases`、`default_model`。渠道持有 base URL 与 API key，也就是过去分散在 `.env` 与 provider JSON 里的那部分。

每个渠道统一使用 `<base_url>/v1/messages` 与 `<base_url>/v1/models`，`base_url` 会去掉结尾斜杠。

## 不要提交真实实例目录

真实实例目录已被 git 忽略，因为它们可能含密钥、本地路径、上游名称、日志、抓取产物与用量历史。

永远不要提交 `instances/proxy-*`、真实 `.env`、线上 `fallback.json`、`usage.sqlite`、`logs/`、`captures/` 或调试产物。

仓库内的 `example-*` 目录是公开安全模板，加 provider key 前先复制一份。

## 构建与运行命令

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 把 TypeScript 编译到 `dist/`。 |
| `npm run proxy:start` | 运行 `node dist/anthropic-proxy.js`。 |
| `npm run proxy` | 用 `tsx` 运行 `src/anthropic-proxy.ts`。 |
| `npm run proxy:dev` | 与 `npm run proxy` 相同的开发入口。 |

生产环境先构建，再启动编译产物：

```bash
npm run build
node --env-file=instances/proxy-11234/.env dist/anthropic-proxy.js
```

`run.sh` 会先跑 `npm run build` 再 exec `npm run proxy:start`，它不会替你加载 `instances/<instance-name>/.env`。

本仓库实际部署的服务通过下面的 systemd 模板运行编译产物。用 `npm run proxy:dev` 启动的开发实例走 `tsx` 直跑源码，因此改源码后下次启动进程即生效，不需要构建步骤。

需要由进程管理器加载实例环境时使用 systemd 或 Docker。

## 活跃路由

### GET /healthz

返回运行状态快照：实例标识、当前加载的路由配置路径、渠道与 canonical model 数量、默认模型、Anthropic header 默认值、健康窗口与尝试策略、`activeRequests`，以及用量历史是否可用。

```bash
curl -s http://127.0.0.1:11234/healthz
```

### GET /v1/models

通过目标模型路由中最高优先级的可用渠道代理上游模型列表。当 canonical 目标出现在上游列表中时，alias 条目也会一并暴露。

```bash
curl -s http://127.0.0.1:11234/v1/models \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01'
```

### POST /v1/messages

接受 Anthropic Messages 的 JSON 请求与流式请求。代理在转发原生 Anthropic 报文的同时做 header 规范化、canonical model 选路、每渠道重试、有序 fallback 与流式处理。

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-latest","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

alias 会在转发前解析成 canonical model，响应回显客户端发送的模型字符串。流式客户端在请求体里设 `stream: true`，用 `curl -N` 或任意支持 SSE 的客户端。

### /admin/*

管理路由提供配置页、监控页、用量页、配置 API、stats API、reload 与 rollback 流程。默认只允许本机访问，除非设置了 `PROXY_ADMIN_ALLOW_HOST=1`。

不要把 `/admin/*` 直接暴露到公网。用 SSH 隧道、只监听本机的 Docker 端口映射，或带认证的本地反向代理。

## 本地 Admin UI

在代理主机上打开配置页：

```text
http://127.0.0.1:<PORT>/admin
```

界面有五个视图——渠道、模型路由、别名、环境、运行态——以及监控页与用量页。未保存的草稿会被标记，切视图不会丢草稿，直到保存或丢弃。

### 校验

校验通过 `POST /admin/config/validate` 检查当前草稿，报告字段错误与警告，不写文件。

### 保存

保存发送 `PUT /admin/config`。服务端先写 `.bak`，再写 `fallback.json`，然后从磁盘重载 runtime snapshot。

草稿里渠道用 `apiKeyAction: "keep"`、环境项用 `secretAction: "keep"` 时密钥保持不变，只有显式替换才会改动已存密钥。

管理端写盘会重新序列化 `fallback.json` 与 `.env`：`.env` 的注释、引号与多行格式不会被保留，且带已弃用键的草稿会被拒绝保存。

### 重载

重载调用 `POST /admin/config/reload`，从磁盘重新读取 `fallback.json` 与 `.env`，不影响浏览器草稿。

在 UI 之外改了实例文件后用它。

### 回滚

回滚调用 `POST /admin/config/rollback`，恢复 `.env` 与 `fallback.json` 的最近 `.bak`，然后重载 runtime config。

没有 `.bak` 时回滚返回成功，恢复列表为空。

### 需要重启的字段

运行态重载可以即时应用渠道、canonical model、alias、超时、日志与策略改动。

`HOST` 或 `PORT` 的变化会在 `restartRequiredFields` 里列出，只有进程重启后才生效。

### 监控

在代理主机上打开监控页：

```text
http://127.0.0.1:<PORT>/admin/monitor
```

监控页在可见时每秒读取一次 `GET /admin/monitor/stats`，轮询保持安静，不会每次刷新都写一行日志。

页面展示全局计数、每个模型路由及其渠道优先级的概览、每渠道与每模型的健康窗口、额度冷却、人工熔断状态，以及只存在浏览器内存里的活跃请求趋势。

每个渠道行带即时熔断控制：`立即熔断` 用默认时长打开人工阻断，`立即恢复` 清除该渠道的全部阻断与失败窗口。恢复时迟到的在途结果会被丢弃，不会覆盖新状态。

`GET /admin/stats` 以 JSON 返回同样的运维数据，供排查与脚本使用。

### 用量

在代理主机上打开用量页：

```text
http://127.0.0.1:<PORT>/admin/usage
```

它按所选时间范围读取 `GET /admin/usage/stats`，并从 `GET /admin/uptime` 取可用性灯带。每次真实上游尝试算一行，包含 fallback 失败；管理调用、健康检查、本地拒绝的请求与响应缓存读取都不计数。

## 路由、熔断与额度

健康状态按渠道记录普通 Messages 路由的共享窗口，另外按渠道+模型记录每个模型窗口。每次真实上游尝试在结束时计一次，记录开始时间与渠道，并关联 canonical model；成功不清空窗口。

只有当滚动窗口内两个条件同时成立时渠道才打开自动熔断：失败数达到 `PROXY_HEALTH_FAILURE_THRESHOLD`，且失败率严格高于 `PROXY_HEALTH_FAILURE_RATE_THRESHOLD`。熔断保持 `PROXY_HEALTH_COOLDOWN_MS`。这里没有半开探测预算：冷却结束后重新开始统计新窗口，只有恢复后收集到的统计才决定下一次阻断。

`disable_cooldown` 只豁免自动熔断，额度与人工阻断对这类渠道依然生效。

额度耗尽与请求隔离：该请求的剩余尝试立即跳过，渠道被停放到 `min(now + PROXY_QUOTA_COOLDOWN_MS, 下一个北京时间 00:02)`，迟到的成功不能清除它。

当所有候选路由都已被阻断且尚未开始任何上游请求时，代理返回 `503 model_channels_unavailable` 并带 `Retry-After`。如果至少开始过一次尝试且所有可用路由都失败，则保留 `fallback_exhausted` 语义。

reload 会先完整校验新文档，再同步替换 runtime snapshot、health 设置与 topology；fingerprint 仍然匹配的状态会保留，旧 topology 下签发的 lease 会被忽略。

要有意让某个渠道下线，请用监控页的人工熔断，而不是改它的 API key 或把它从路由里删掉。人工阻断能跨 reload 保留，会出现在可用性历史里，并且一键即可解除。

## Usage 与 Uptime

实例目录下的 `usage.sqlite` 保存尝试历史与可用性采样。服务端每 180 秒在 UTC 边界采样一次，保留 30 天，并且只读本地状态——采样过程从不请求上游。

Anthropic 口径把三项输入分开保存，总输入按 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` 派生。上游未上报的分量保持 `NULL` 而不是 `0`，覆盖率计数会显示有多少行报告了完整数据。

备份实例时连带 `.env`、`fallback.json` 与 `usage.sqlite` 一起复制运行目录，备份放在 git 之外并按密钥同等保护。

```bash
mkdir -p backups
tar -czf backups/proxy-11234-config.tgz instances/proxy-11234
```

只有在进程停止时才能删除或移动 `usage.sqlite`。未完成的记录会在下次启动时变成 `interrupted`，因此非正常退出不会凭空产生一条成功记录。

## 日志与 Captures

运行日志默认写到 stdout 与 stderr，除非进程管理器重定向。systemd 用 `journalctl`，Docker 用 `docker compose logs`。

抓取调试默认关闭，只在事故处理期间打开，事后关闭并删掉抓取文件。

```env
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
PROXY_STREAM_MODE=normalized
```

抓取文件可能包含 prompt、工具入参、上游错误与上游响应，按敏感运维数据处理。日志记录渠道 id、canonical model、尝试结果与 fallback 原因，从不打印 API key。

## Docker 部署

Docker 以前台单进程方式运行 `node dist/anthropic-proxy.js`。

先准备本地运行实例：

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

在 `instances/proxy-11234/.env` 填监听值与本地文件路径：

```env
ANTHROPIC_VERSION=2023-06-01
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

渠道 base URL 与 API key 属于 `fallback.json`，不放进 `.env`。

启动 compose：

```bash
docker compose up --build
```

compose 会加载 `./instances/proxy-11234/.env`，把 `./instances/proxy-11234` 挂到 `/app/instances/proxy-11234`，绑定 `127.0.0.1:11234:11234`，并设置 `PROXY_ADMIN_ALLOW_HOST=1`。

只绑本机让 `/admin/*` 在主机可用而不会对外发布。若改动绑定地址，需要补更强的保护。

启动后的主机地址：

```text
http://127.0.0.1:11234/v1/messages
http://127.0.0.1:11234/v1/models
http://127.0.0.1:11234/admin
http://127.0.0.1:11234/admin/monitor
http://127.0.0.1:11234/admin/usage
```

日志与停止用 Docker 生命周期命令：

```bash
docker compose logs -f
docker compose down
```

实例目录以读写方式挂载，因此管理页的写入会落到主机，用量历史同样落在该目录。

## 安全重启模式

重启用户级 systemd 实例前先用 `wait-proxy-idle.sh`，它轮询 `/healthz` 直到 `activeRequests` 为 0，或服务已经停止。

```bash
./wait-proxy-idle.sh proxy-11234 11234
systemctl --user restart anthropic-messages-proxy@proxy-11234.service
```

脚本默认用 `anthropic-messages-proxy@<instance-name>` 作为 `WAIT_PROXY_IDLE_SERVICE`，并尽量从实例名后缀推导端口。

可用覆盖项：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WAIT_PROXY_IDLE_PORT` | 从实例名推导，否则 `11236` | 覆盖健康检查端口。 |
| `WAIT_PROXY_IDLE_INTERVAL` | `0.5` | 轮询间隔秒数。 |
| `WAIT_PROXY_IDLE_SERVICE` | `anthropic-messages-proxy@<instance-name>` | 覆盖 systemd unit。 |
| `WAIT_PROXY_IDLE_STATUS_URL` | `http://127.0.0.1:<PORT>/healthz` | 覆盖健康检查 URL。 |

一行重启：

```bash
./wait-proxy-idle.sh proxy-11234 11234 && systemctl --user restart anthropic-messages-proxy@proxy-11234.service
```

系统级服务用同样的等待命令并配上对应的 `WAIT_PROXY_IDLE_SERVICE`，然后 `sudo systemctl restart`。

## Systemd 模板

仓库内模板是 `deploy/systemd/anthropic-messages-proxy@.service.example`。

它使用的部署路径是：

```text
/opt/anthropic-messages-compat-proxy
```

模板内容：

```ini
[Unit]
Description=Anthropic Messages Compatibility Proxy (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/anthropic-messages-compat-proxy
EnvironmentFile=/opt/anthropic-messages-compat-proxy/instances/%i/.env
ExecStart=/usr/bin/env npm run proxy:start
Restart=on-failure
RestartSec=5
TimeoutStopSec=120

[Install]
WantedBy=default.target
```

安装用户级服务：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/anthropic-messages-proxy@.service.example ~/.config/systemd/user/anthropic-messages-proxy@.service
systemctl --user daemon-reload
systemctl --user enable --now anthropic-messages-proxy@proxy-11234.service
```

安装系统级服务：

```bash
sudo cp deploy/systemd/anthropic-messages-proxy@.service.example /etc/systemd/system/anthropic-messages-proxy@.service
sudo systemctl daemon-reload
sudo systemctl enable --now anthropic-messages-proxy@proxy-11234.service
```

系统级服务按主机策略把 `WantedBy=default.target` 改成 `multi-user.target`。

`%i` 就是实例目录名。`anthropic-messages-proxy@proxy-11234.service` 加载 `/opt/anthropic-messages-compat-proxy/instances/proxy-11234/.env`。

systemd 靠 `EnvironmentFile` 加载实例环境，直接调用 `run.sh` 时不会加载。

本地 unit 改动、主机名、私有路径与服务名不要进 git。

`TimeoutStopSec=120` 给在途流两分钟收尾时间。让它与 `PROXY_TOTAL_REQUEST_TIMEOUT_MS` 对齐，避免 systemd 过早杀进程。

## 从本地工作目录迁移

在目标部署路径构建：

```bash
cd /opt/anthropic-messages-compat-proxy
npm ci
npm run build
npm prune --omit=dev
```

把实例文件复制到目标路径：

```bash
mkdir -p instances/proxy-11234
cp /path/to/old/instances/proxy-11234/.env instances/proxy-11234/.env
cp /path/to/old/instances/proxy-11234/fallback.json instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

更新复制过来的 `.env` 路径：

```env
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
```

用 systemd 模板安装并启动 `anthropic-messages-proxy@proxy-11234.service`。

验证迁移后的实例：

```bash
curl -s http://127.0.0.1:11234/healthz
curl -s http://127.0.0.1:11234/v1/models
curl -s http://127.0.0.1:11234/admin/stats
curl -s http://127.0.0.1:11234/admin/monitor/stats
```

新实例健康后停掉旧进程，并清理上一个工作目录里的真实实例目录、`.env`、日志与抓取产物。
