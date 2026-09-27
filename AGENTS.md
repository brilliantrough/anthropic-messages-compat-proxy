# Project Contract

## Protocol Surface

This repository is an Anthropic Messages compatibility proxy. The active client surface is `POST /v1/messages` for JSON and streaming Messages requests, plus `GET /v1/models` for model listing.

The proxy forwards Anthropic Messages shaped requests upstream. It preserves native Anthropic request fields, including `cache_control` blocks inside `system`, `messages`, tool inputs, and other content parts.

Streaming support follows Anthropic SSE events such as `message_start`, `content_block_start`, `content_block_delta`, `message_delta`, `message_stop`, `ping`, and `error`.

## Instance Configuration

Each runtime instance keeps its own configuration under `instances/<instance-name>/`. Treat instance files as the runtime source for routing, health policy, and credentials.

Scalar settings live in the instance `.env`: listener, timeouts, `PROXY_HEALTH_*`, `PROXY_CHANNEL_MAX_ATTEMPTS`, `PROXY_CHANNEL_RETRY_DELAY_MS`, `PROXY_QUOTA_COOLDOWN_MS`, `PROXY_USAGE_DB_PATH`, stream mode, and debug switches.

The routing document lives in `fallback.json` beside it and is the only source of `channels`, `models`, `aliases`, and `default_model`. Channels hold inline credentials plus `base_url`; each canonical model lists its channels in fallback priority order; aliases only resolve to a canonical model. Both files must stay at mode `0600`.

Every channel is addressed at `<base_url>/v1/messages` and `<base_url>/v1/models`, with trailing slashes removed from `base_url`. Only configured canonical models can be requested; unknown model names are rejected locally.

`MODEL_MAP_PATH`, `PRIMARY_PROVIDER_*`, `PROXY_ENDPOINT_*`, and `PROXY_MAX_FALLBACK_ATTEMPTS` are retired. The runtime ignores them with a startup warning, and the admin config view refuses to save a draft that still carries a deprecated key.

`ANTHROPIC_VERSION` supplies the default outbound `anthropic-version` header when the client does not send one. Optional `ANTHROPIC_BETA` supplies `anthropic-beta` when the client does not send one.

OpenAI Responses, Codex compaction, prompt-cache hint injection, and response caching are out of scope here. Do not add a compact route, prompt cache keys, or a response cache to this proxy.

## Header and Prompt Stability Rules

Never forward a client supplied `x-api-key` upstream. The outbound upstream `x-api-key` must come from the channel that serves the request.

Prompt caching stays native to Anthropic Messages. Preserve `cache_control` where the client places it. Do not add synthetic cache keys, retention hints, random IDs, timestamps, or request IDs to prompt content.

Gateway billing attribution can appear in top-level `system` text. Keep that prefix stable by sanitizing top-level `system` according to `PROXY_CLAUDE_BILLING_HEADER_MODE`.

The default billing-header mode is `strip_line`. `strip_cch` is available when the text must remain but the dynamic `cch=` field must be removed.

Usage accounting keeps the three Anthropic input components separate: `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. The inclusive total input is their sum, a component the upstream did not report stays `NULL`, and each real upstream attempt is one row that a later cumulative SSE usage update overwrites instead of duplicating.

## Streaming and Fallback Boundary

Fallback is allowed only before usable output has been committed to the client. Once recognized usable output is written, later upstream failures must be reported on the active response path.

Usable stream output includes nonempty `text_delta`, `thinking_delta`, `signature_delta`, any string `input_json_delta.partial_json`, and `tool_use` content block starts. Metadata-only events do not commit fallback.

Normalized stream mode may rewrite the model in `message_start` back to the requested client alias. Raw stream mode passes upstream SSE bytes after the same usable-output commit gate.

Non-stream paths may reconstruct JSON from Anthropic SSE when the upstream returns an event stream to a JSON client. Reconstruction must preserve tool and thinking blocks when possible.

## Source-of-Truth Order

Use current source and checks first when behavior is unclear. The most direct files are `src/anthropic-*.ts`, `src/routing-config.ts`, `src/routing-policy.ts`, `src/channel-health.ts`, `src/upstream-router.ts`, `src/runtime-config.ts`, `src/usage-*.ts`, `src/uptime.ts`, `src/admin-api.ts`, and `checks/check-anthropic-*`.

Use instance files next for local runtime behavior. `.opencode/memory/anthropic-messages-proxy.md` is ignored local memory and can summarize current facts, but source and checks outrank it.

Use `README.md` for public usage guidance. Do not copy provider-specific incidents, live secrets, or private instance values into tracked documentation or local memory.

## Legacy Responses Code

Some shared helpers still carry Responses-era names because this repository was forked from a Responses proxy. Treat those names as lineage unless current Anthropic source and checks prove behavior.

`src/json-proxy.ts` and `src/responses-*.ts` are not reachable from `src/anthropic-proxy.ts`; keep them out of the Messages path and leave removal to a separate cleanup decision.

Historical Responses migration notes under `docs/superpowers/memory/` do not describe the current Anthropic Messages runtime. Keep them only for lineage context.

<!-- memory-system:start -->
## Project Memory System

This project uses a three-layer memory system (Magic Context + StrictDoc + claude-mem).

- **At session start**: run the `load-mem` skill before doing substantial work.
- **At milestones and before ending work**: run the `save-mem` skill.

### Rules that always apply (even if the skills are not loaded)

1. `docs/` is a single StrictDoc project with two trees: `project_memory/` (memory: decisions, journal) and `handbook/` (durable documents). Only nodes with `STATUS: Active` are current canon; `Deprecated`/`Superseded`/`Proposed` nodes are history — never quote them as current practice.
2. Never delete or rewrite memory nodes. Retire via `STATUS` change plus a `Supersedes` relation to the successor node.
3. After editing any `.sdoc` file, validate immediately: run `strictdoc export .` inside `docs/`. Prefer the `strictdoc` on PATH (the activated conda/uv/venv env is inherited by the agent shell); if absent, detect the project env (e.g. `.venv/bin/strictdoc`, `uv run strictdoc`) — do not assume a specific env manager. Never leave the tree broken.
4. On conflict between memory sources, `ctx_memory` (the injected `<project-memory>` block) wins.

### Context window (always applies)

- Big output never enters context: bulk commands / multi-file analysis -> `ctxm_batch_execute`, one-off computation -> `ctxm_execute`, reading a file -> `ctxm_execute_file`. Web -> the configured MCP tools first (`tavily_search` for facts/news, `firecrawl_search` for ranked results, `firecrawl_scrape` for a known page), over any host built-in like WebFetch; `ctxm_fetch_and_index` only for a page you will re-query (how-to lives in the `context-mode` skill).
- Recall and durable knowledge go through Magic Context: `ctx_search` before asking the user, `ctx_memory` for facts future sessions need, `ctx_note` for "later".
- Native `Read`/`Grep`/`Glob` stay right when you need the exact bytes or will edit the file — never route those through `ctxm_*`.

### Steering the agent (always applies)

- Steer with prompts, skills and tool descriptions — never with hard blocks. Guidance keeps judgement and variety; deny rules are a last resort for damage, not for preference.
- Adding an MCP server: keep tool names short (pi-mcp-adapter `toolPrefix: "none"`) and descriptions rich — the description is all the model reads before choosing.
- When a behaviour goes wrong, fix the system that produced it (a line here, a skill, or a fork patch), not just the config of the machine you noticed it on.

### Code taste (always applies when writing or changing code)

- Running code without errors IS the verification — no tests, no TDD, no verification scripts unless explicitly asked.
- No over-encapsulation, no defensive programming, no speculative abstraction. Minimum code that works.
- Report results in one line; no summary essays.
- Script/repo comments carry usage and necessary function notes only. The reasoning behind a change — alternatives weighed, measurements, upstream drift, failure modes — is development process and belongs in the local memory system (the gitignored StrictDoc tree and session memory), never in the repository files.

**Placement**: paste this whole block at the *tail* of a project's own `AGENTS.md` — the project's own content stays on top, this block is the accelerator we append. `bash sync-agents-block.sh <项目目录…>` refreshes it (block missing → appended, present → replaced in place).

(Procedures for reading/writing memory live in the `load-mem`/`save-mem` skills — keep this file short.)
<!-- memory-system:end -->

---

## Deployment topology (since 2026-09-27)

Production instances run on a dedicated server; this checkout is dev/test only. The full internal runbook (host, unit names, port inventory, deploy/rollback commands) lives in local `DEPLOY.local.md` (gitignored — never commit it).

Ground rules:

- `instances/proxy-*/` is runtime config and server-authoritative. Deploy rsync must exclude `instances/`; `--delete` must never touch it.
- Deploy flow: rsync code (exclude `instances/`, `node_modules/`, local workspace dirs) → `npm ci` on the server when the lockfile changed → `systemctl restart` the affected instance units → probe `/v1/models` on each port.
- New instances are created on the production host (`instances/proxy-<port>/` plus a unit); local testing always uses non-production ports and stops afterwards.
- Rollback: `git revert` locally, redeploy; instance config is untouched by deploys.
