# Operations

Deployment, process management, and operational procedures for the Anthropic Messages Compatibility Proxy.

Before publishing this repository, review `docs/publishing-checklist.md`.

## Table of Contents

- [Multi-Instance Layout](#multi-instance-layout)
- [Do Not Commit Real Instance Directories](#do-not-commit-real-instance-directories)
- [Build and Run Commands](#build-and-run-commands)
- [Active Routes](#active-routes)
- [Local Admin UI](#local-admin-ui)
- [Routing, Breakers, and Quota](#routing-breakers-and-quota)
- [Usage and Uptime](#usage-and-uptime)
- [Logs and Captures](#logs-and-captures)
- [Docker Deployment](#docker-deployment)
- [Safe Restart Pattern](#safe-restart-pattern)
- [Systemd Template](#systemd-template)
- [Migration from Local Working Directory](#migration-from-local-working-directory)

## Multi-Instance Layout

Each runtime instance has its own directory under `instances/`. The directory usually includes the port in its name so operators can match files, services, and health checks quickly.

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

Create a new instance from a tracked example directory:

```bash
cp -r instances/example-11234 instances/proxy-NEWPORT
cp instances/proxy-NEWPORT/.env.example instances/proxy-NEWPORT/.env
cp instances/proxy-NEWPORT/fallback.json.example instances/proxy-NEWPORT/fallback.json
chmod 600 instances/proxy-NEWPORT/fallback.json
```

Edit `instances/proxy-NEWPORT/.env` and set `PORT`, `HOST`, `INSTANCE_NAME`, `PROXY_ENV_PATH`, and `FALLBACK_CONFIG_PATH`.

Then edit `fallback.json` and fill in `channels`, `models`, `aliases`, and `default_model`. Channels hold the base URL and API key that were previously split between `.env` and a provider JSON file.

Every channel is addressed at `<base_url>/v1/messages` and `<base_url>/v1/models`, with trailing slashes removed from `base_url`.

## Do Not Commit Real Instance Directories

Real instance directories are ignored by git because they can contain secrets, local paths, provider names, logs, captures, and usage history.

Never commit `instances/proxy-*`, real `.env` files, live `fallback.json`, `usage.sqlite`, `logs/`, `captures/`, or generated debug output.

Tracked `example-*` directories are public-safe templates. Copy them before adding provider keys.

## Build and Run Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm run proxy:start` | Run `node dist/anthropic-proxy.js`. |
| `npm run proxy` | Run `src/anthropic-proxy.ts` through `tsx`. |
| `npm run proxy:dev` | Same development entrypoint as `npm run proxy`. |

Production runs should build first, then start the compiled entrypoint.

```bash
npm run build
node --env-file=instances/proxy-11234/.env dist/anthropic-proxy.js
```

`run.sh` runs `npm run build` and then execs `npm run proxy:start`. It does not load `instances/<instance-name>/.env` for you.

The deployed services in this repository run the compiled entrypoint through the systemd template below. A development instance started with `npm run proxy:dev` runs the TypeScript source through `tsx` instead, so a source edit is picked up on the next process start without a build step.

Use systemd or Docker when you want the instance environment loaded by the process manager.

## Active Routes

### GET /healthz

Returns a runtime status snapshot. It includes instance identity, the loaded routing config path, channel and canonical model counts, the default model, Anthropic header defaults, the health window and attempt policy, `activeRequests`, and whether usage history is available.

```bash
curl -s http://127.0.0.1:11234/healthz
```

### GET /v1/models

Proxies the upstream model list through the highest-priority available channel of the requested model route. Alias entries are exposed when their canonical target appears upstream.

```bash
curl -s http://127.0.0.1:11234/v1/models \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01'
```

### POST /v1/messages

Accepts Anthropic Messages JSON requests and streaming requests. The proxy forwards Anthropic-shaped payloads upstream with header normalization, canonical model routing, per-channel retry, ordered fallback, and stream handling.

```bash
curl -s http://127.0.0.1:11234/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-latest","max_tokens":128,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

An alias resolves to its canonical model before the request goes upstream, and the response echoes the model string the client sent. For streaming clients, set `stream: true` in the body and use `curl -N` or another SSE-capable client.

### /admin/*

Admin routes serve the config UI, monitor UI, usage history, config API, stats API, reload flow, and rollback flow. They are localhost-only unless `PROXY_ADMIN_ALLOW_HOST=1` is set.

Do not expose `/admin/*` directly to the public internet. Use an SSH tunnel, localhost-bound Docker port, or an authenticated local reverse proxy.

## Local Admin UI

Open the config UI on the proxy host:

```text
http://127.0.0.1:<PORT>/admin
```

The UI shows five views — Channels, Models, Aliases, Environment, and Runtime — plus the monitor and usage pages. It marks unsaved drafts before they are applied, and a draft survives view switches until it is saved or discarded.

### Validate

Validate checks the current draft through `POST /admin/config/validate`. It reports field errors and warnings without writing files.

### Save

Save sends `PUT /admin/config`. The server creates a `.bak` file, writes `fallback.json`, and reloads the runtime snapshot from disk.

Secret fields stay unchanged when the draft uses `apiKeyAction: "keep"` or `secretAction: "keep"`. Only explicit replacement values change stored secrets.

The admin writer serializes `fallback.json` and `.env`. It does not preserve comments, quotes, or multiline formatting in `.env`, and it refuses to save a draft that still carries a deprecated key.

### Reload

Reload calls `POST /admin/config/reload`. It rereads the current `fallback.json` and `.env` from disk without saving the browser draft.

Use reload after editing instance files outside the UI.

### Rollback

Rollback calls `POST /admin/config/rollback`. It restores the last `.bak` files for `.env` and `fallback.json`, then reloads runtime config.

If no `.bak` files exist, rollback returns success with an empty restored list.

### Restart-Required Fields

Runtime reload applies channel, canonical model, alias, timeout, logging, and policy changes without restarting.

Changes to `HOST` or `PORT` are reported in `restartRequiredFields`. They take effect only after the process restarts.

### Monitor

Open the monitor on the proxy host:

```text
http://127.0.0.1:<PORT>/admin/monitor
```

The monitor reads `GET /admin/monitor/stats` once per second while visible. Polling is quiet and does not add one log line per refresh.

It shows global counters, the routing overview with every model route and its channel priority, per-channel and per-model health windows, quota cooldowns, manual breaker state, and a lightweight active-request trend kept in browser memory.

Each channel row has immediate breaker controls: `Trip now` opens a manual block with the default cooldown, and `Restore` clears every block and failure window for that channel. A restore also discards a late in-flight result so it cannot overwrite the new state.

`GET /admin/stats` returns the same operator data as JSON for diagnostics and scripts.

### Usage

Open the usage page on the proxy host:

```text
http://127.0.0.1:<PORT>/admin/usage
```

It reads `GET /admin/usage/stats` for the selected range plus `GET /admin/uptime` for the availability band. Each real upstream attempt is one row, including fallback failures; admin calls, health checks, locally rejected requests, and cached-response reads are never counted.

## Routing, Breakers, and Quota

Health is tracked per channel for the ordinary Messages route, and per channel plus model for each model window. One real upstream attempt counts once at completion, its start time and channel are recorded with the canonical model, and a successful attempt does not clear the window.

A channel opens its automatic breaker only when both conditions hold inside the rolling window: failures reach `PROXY_HEALTH_FAILURE_THRESHOLD` and the failure rate is strictly above `PROXY_HEALTH_FAILURE_RATE_THRESHOLD`. The breaker stays open for `PROXY_HEALTH_COOLDOWN_MS`. There is no half-open probe budget: after the cooldown the channel starts collecting a fresh window, and only statistics collected after recovery decide the next block.

`disable_cooldown` exempts a channel from the automatic breaker only. Quota exhaustion and manual control still apply to it.

Quota exhaustion is isolated from the request as well: the remaining attempts for that request are skipped, the channel is parked until `min(now + PROXY_QUOTA_COOLDOWN_MS, next 00:02 Beijing time)`, and a late success cannot clear it.

When every candidate route is already blocked and no upstream request has started, the proxy answers `503 model_channels_unavailable` with `Retry-After`. When at least one attempt started and every available route failed, the response keeps the `fallback_exhausted` semantics.

Reload validates the whole document before it swaps the runtime snapshot, health settings, and topology, keeps state whose fingerprint still matches, and ignores leases issued under the previous topology.

To take a channel out of rotation on purpose, use the manual breaker in the monitor instead of editing its API key or deleting it from a route. The manual block survives reloads, is visible in the uptime history, and can be lifted with one click.

## Usage and Uptime

`usage.sqlite` in the instance directory stores attempt history and uptime samples. The server samples uptime every 180 seconds on the UTC boundary, keeps thirty days, and reads local state only — sampling never calls upstream.

Anthropic accounting keeps the three reported input components separate and derives the inclusive input as `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. A component the upstream did not report stays `NULL` rather than becoming `0`, and the coverage counters show how many rows reported complete data.

Back up an instance by copying its runtime directory, including `.env`, `fallback.json`, and `usage.sqlite`. Keep backups outside git and protect them like secrets.

```bash
mkdir -p backups
tar -czf backups/proxy-11234-config.tgz instances/proxy-11234
```

Delete or move `usage.sqlite` only while the process is stopped. A pending row becomes `interrupted` on the next start, so an unclean shutdown does not invent a successful request.

## Logs and Captures

Runtime logs go to stdout and stderr unless your process manager redirects them. Use `journalctl` for systemd and `docker compose logs` for Docker.

Debug capture settings are off by default. Enable them only during incident work, then disable them and delete captured files.

```env
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
PROXY_STREAM_MODE=normalized
```

Capture files can contain prompts, tool input, provider errors, and upstream responses. Treat them as sensitive operational data. Logs record channel ids, canonical models, attempt outcomes, and fallback reasons; they never print API keys.

## Docker Deployment

Docker runs the proxy as one foreground process with `node dist/anthropic-proxy.js`.

Prepare the local runtime instance first:

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

Fill `instances/proxy-11234/.env` with listener values and local file paths:

```env
ANTHROPIC_VERSION=2023-06-01
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

Channel base URLs and API keys belong in `fallback.json`, not in `.env`.

Start compose:

```bash
docker compose up --build
```

The compose file loads `./instances/proxy-11234/.env`, mounts `./instances/proxy-11234` at `/app/instances/proxy-11234`, binds `127.0.0.1:11234:11234`, and sets `PROXY_ADMIN_ALLOW_HOST=1`.

The localhost bind keeps `/admin/*` available from the host without publishing it broadly. Add stronger protection if you change the bind address.

Host URLs after startup:

```text
http://127.0.0.1:11234/v1/messages
http://127.0.0.1:11234/v1/models
http://127.0.0.1:11234/admin
http://127.0.0.1:11234/admin/monitor
http://127.0.0.1:11234/admin/usage
```

Use Docker lifecycle commands for logs and shutdown:

```bash
docker compose logs -f
docker compose down
```

Admin UI writes persist to the host because the instance directory is mounted read-write. Usage history lands in the same mounted directory.

## Safe Restart Pattern

Use `wait-proxy-idle.sh` before restarting a user-level systemd instance. It polls `/healthz` until `activeRequests` is zero or the service is already stopped.

```bash
./wait-proxy-idle.sh proxy-11234 11234
systemctl --user restart anthropic-messages-proxy@proxy-11234.service
```

The script defaults to `anthropic-messages-proxy@<instance-name>` for `WAIT_PROXY_IDLE_SERVICE` and derives the port from the instance name suffix when possible.

Useful overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WAIT_PROXY_IDLE_PORT` | derived from instance name, else `11236` | Override the health port. |
| `WAIT_PROXY_IDLE_INTERVAL` | `0.5` | Seconds between polls. |
| `WAIT_PROXY_IDLE_SERVICE` | `anthropic-messages-proxy@<instance-name>` | Override the systemd unit. |
| `WAIT_PROXY_IDLE_STATUS_URL` | `http://127.0.0.1:<PORT>/healthz` | Override the health URL. |

One-line restart:

```bash
./wait-proxy-idle.sh proxy-11234 11234 && systemctl --user restart anthropic-messages-proxy@proxy-11234.service
```

For system-level services, use the same wait command with a matching `WAIT_PROXY_IDLE_SERVICE`, then call `sudo systemctl restart`.

## Systemd Template

The tracked template is `deploy/systemd/anthropic-messages-proxy@.service.example`.

It uses this deployment path:

```text
/opt/anthropic-messages-compat-proxy
```

Template contents:

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

Install a user-level service:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/anthropic-messages-proxy@.service.example ~/.config/systemd/user/anthropic-messages-proxy@.service
systemctl --user daemon-reload
systemctl --user enable --now anthropic-messages-proxy@proxy-11234.service
```

Install a system-level service:

```bash
sudo cp deploy/systemd/anthropic-messages-proxy@.service.example /etc/systemd/system/anthropic-messages-proxy@.service
sudo systemctl daemon-reload
sudo systemctl enable --now anthropic-messages-proxy@proxy-11234.service
```

For system services, change `WantedBy=multi-user.target` if your host policy expects that target.

`%i` becomes the instance directory name. `anthropic-messages-proxy@proxy-11234.service` loads `/opt/anthropic-messages-compat-proxy/instances/proxy-11234/.env`.

`EnvironmentFile` is what loads the instance env for systemd. `run.sh` does not do that when called directly.

Keep local unit edits, hostnames, private paths, and service names out of git.

`TimeoutStopSec=120` gives in-flight streams two minutes to finish during stop or restart. Align it with `PROXY_TOTAL_REQUEST_TIMEOUT_MS` so systemd does not kill the process too early.

## Migration from Local Working Directory

Build in the target deployment path:

```bash
cd /opt/anthropic-messages-compat-proxy
npm ci
npm run build
npm prune --omit=dev
```

Copy instance files into the target path:

```bash
mkdir -p instances/proxy-11234
cp /path/to/old/instances/proxy-11234/.env instances/proxy-11234/.env
cp /path/to/old/instances/proxy-11234/fallback.json instances/proxy-11234/fallback.json
chmod 600 instances/proxy-11234/fallback.json
```

Update file paths in the copied `.env`:

```env
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
PROXY_SSE_FAILURE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DIR=./instances/proxy-11234/captures/anthropic-proxy-11234/stream/missing-usage
```

Install and start `anthropic-messages-proxy@proxy-11234.service` with the systemd template.

Verify the migrated instance:

```bash
curl -s http://127.0.0.1:11234/healthz
curl -s http://127.0.0.1:11234/v1/models
curl -s http://127.0.0.1:11234/admin/stats
curl -s http://127.0.0.1:11234/admin/monitor/stats
```

After the new instance is healthy, stop the old process. Remove old real instance directories, `.env` files, logs, and captures from the previous working directory.
