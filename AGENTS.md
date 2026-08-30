# AGENTS.md — dsh-kernel-mesh maintainer documentation

This is the full engineering reference for `dsh-kernel-mesh`. It is written for
maintainers (human or agent) who need to understand, debug, or extend the mesh.
If you only want to *use* the plugin, read [`README.md`](README.md) instead.

---

## 1. What this package is

`dsh-kernel-mesh` is a **host-plane Cordis bundle** for DeepSeek Harness (DSH).
It makes foreign coding harnesses — Kimi Code, Grok Build, OpenAI Codex, and
MiniMax Mini-Agent — available inside DSH as first-class citizens, at three layers:

- **L1** (`llm.registerAdapter`): registers `kimi-kernel`, `grok-kernel`,
  `codex-kernel`, and `minimax-kernel` as DSH model *routes*. Any session or
  agent preset can then select those providers in the model picker, so the main
  agent itself runs on a foreign kernel.
- **L2** (`subagents.registerProvider`): registers each kernel's own subagent
  recipes (`kimi-agent`/`kimi-explore`/`kimi-plan`, `grok-agent`/`grok-explore`/
  `grok-plan`, `codex-agent`/`codex-explore`/`codex-worker`). The recipes live
  in each vendor plugin's `lib/subagents.js` (loaded dynamically by the mesh)
  and carry the upstream subagent prompts. minimax has no subagent tool
  upstream, so it contributes no recipes. These wrap DSH's built-in `spawn`
  provider and force the subagent onto a specific kernel + model with a fixed
  persona and tool filter.
- **Tools** (`tools.register`): `kernel_status`, `kernel_run`, `kernel_switch`,
  plus vendor search tools that are **opt-in per subscription**:
  `kimi_search`/`kimi_fetch` only when `dsh-kernel-kimi` is installed and a
  Moonshot credential exists; `grok_search`/`grok_fetch` only when
  `dsh-kernel-grok` is installed and a Grok OAuth credential exists. Official
  `ctx.web` can pin only one `searchProvider`, so these stay as separate
  model-facing tools. Never assume every user subscribed to every kernel.

The plugin is delivered as two files plus metadata. Since 0.1.6 `apply()` also
provides a tiny marker service (`ctx.provide('kernelMesh', { version })`): vendor
packages depend on the mesh and fallback-mount it when the host composition did
not; the marker (plus the `*-kernel` route check) is their idempotence guard.

- `lib/index.js` — the entire host plugin (`export { name, inject, apply }`).
- `cordis.patch.yml` — the bundle patch that inserts a `kernel-mesh` row into
  the host composition.
- `package.json` — points the DSH bundler at the patch via `dsh.bundle.patch`.

The source package lives under `harness-kernels/packages/dsh-kernel-mesh/`; this
release directory is a flattened, publishable copy.

---

## 2. Architecture: host-plane bundle, injection order, and lifecycle

DSH composes itself from Cordis plugins. `cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: kernel-mesh
      name: dsh-kernel-mesh
```

That row mounts `lib/index.js` on the **host plane** (the DSH Node.js process).
Being on the host plane matters: `llm`, `subagents`, and `tools` are host
services, and host code can reach the filesystem (for credential files) and the
network (for upstream APIs). A browser/client plugin could not do any of this.

### The `inject` list and why it matters

```js
export const name = 'dsh-kernel-mesh'
export const inject = ['llm', 'tools', 'subagents']
export function apply(ctx) { /* ... */ }
```

`inject` is a **hard dependency barrier**. Cordis will **not** call `apply()`
until every declared service is ready. This fixes the single most dangerous bug
class in this plugin's history:

> **Bug #1 — silent bundle no-op.** An early version omitted `inject` and read
> `ctx.get('llm')` at the top of `apply()`. During boot, `llm` was still
> `undefined`, so the plugin hit `if (!llm) return` and silently registered
> nothing — no error, no adapters, no tools. Adding `inject` guarantees the
> services exist before `apply()` runs, so the silent return is now a real
> safety net instead of a silent failure.

Within `apply()` the code re-reads the services through `ctx.get(...)` and
treats them as possibly-optional (`if (!llm) return`), because a service can
still be torn down mid-run. Never read an injected service as a bare `ctx.llm`
property without declaring it in `inject`.

Everything registered inside `apply()` — adapters, subagent providers, tools —
is bound to the plugin's Cordis **fiber**. When the row is removed, updated, or
the session ends, Cordis disposes it all automatically. Do not create
module-level side effects that outlive `apply()`.

---

## 3. The DSH service contracts the code depends on

These are the exact contracts `index.js` relies on. They are duck-typed: DSH
does not require subclasses, only methods returning the right shapes.

### 3.1 `llm.registerAdapter(providers, adapter)`

Registers an LLM adapter for one or more provider ids. The adapter object must
implement:

- **`providerInfo(provider) -> { id, name }`** — human-readable identity for the
  route. Every adapter here returns `{ id: provider, name: opts.name }`.
- **`providerRetryPolicy() -> undefined | policy`** — retry/backoff strategy.
  All four adapters return `undefined` (defer to DSH defaults). Do not return a
  fabricated policy object.
- **`listModels(provider) -> Promise<Model[]>`** — the model catalog for the
  picker. Each `Model` is `{ provider, id, name }` (context window and default
  max tokens may be attached, but `resolveModel` is authoritative for them).
- **`resolveModel(provider, model) -> Promise<ResolvedModel>`** — resolves a
  model id to `{ provider, id, name, context: { contextWindow }, defaultMaxTokens }`.
  Unknown ids fall through to a generous default (200k context / 32768 tokens).
  Responses-wire adapters additionally attach `reasoning: { efforts, defaultEffort }`.
- **`prepareCall(provider, model, signal) -> Promise<{ model, stream }>`** —
  **required since dsh-llm 0.1.1-rc.2.** The service calls this on the
  exact-model path (agent loop and `llm.stream`) and binds the returned
  one-generation `stream` entry point to the dispatch. Both factories implement
  the base-class default: `model` from `resolveModel`, `stream` closing over
  `this.stream`. Omitting it kills every turn with
  `registration.adapter.prepareCall is not a function` (wire test 0 guards it).
- **`stream(options) -> AsyncGenerator<Block>`** — the heart. `options` carries
  `model`, `messages`, `system`, `tools`, `maxTokens`, and (for responses wire)
  `reasoningEffort`, plus an AbortSignal. The generator must **yield DSH block
  events** in order (see 3.3) and end with a `usage` event and a `finish` event.
  Both factories yield **incrementally** from SSE (true TTFT); see §7.6 for the
  transport details and the JSON auto-fallback.

Both factories below adhere to this async-generator contract. A malformed
adapter (e.g. one that returns a Promise instead of an async generator, or that
forgets the final `finish` event) will silently hang or crash the calling run.

**Failure classification is part of the contract.** Thrown errors must carry
the canonical taxonomy as OWN data properties — `e.code` plus a matching
`e.failure = { message, code, status? }` snapshot — because dsh-llm's
adapter-failure normalization reads exactly those own properties from foreign
errors (no cross-instance `HarnessError` import needed or possible). Use
`llmFail(message, code, status?)` / `providerError(tag, wireError)`; never
throw a bare `Error` from an adapter boundary. The map: wire
`rate_limit_error`/`overloaded_error` → `RATE_LIMIT`, `api_error` → `SERVER`,
`authentication_error`/`permission_error` → `AUTH`, `request_too_large` →
`CONTEXT_WINDOW_EXCEEDED`, curl exit/spawn failure → `TRANSPORT`, unparseable
body → `SERVER`, abort → `ABORTED`. dsh-llm-retry's default normal policy
retries `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT` twice
with bounded backoff; `AUTH`/`INVALID_REQUEST`/`UNKNOWN` fail the turn once.
A bare Error is `UNKNOWN` — the pre-fix behavior, which let a transient 429
kill a turn with no retry.

### 3.2 `subagents.registerProvider(provider)`, `subagents.start(name, request)`, and `subagents.startContinuable(spec)`

A subagent *provider* backs one or more L2 subagent *types* visible to
`subagents.list()`. The provider object must implement:

- **`capabilities`** — a capabilities descriptor object. The recipes copy this
  verbatim from the wrapped `spawn` provider so the upstream subagents behave
  like native spawn subagents.
- **`inheritsParentContext`** — boolean; likewise copied from `spawn`.
- **`start(request) -> Promise<Run>`** — spawns one subagent run and returns a
  handle with at least `result` (resolving to `{ output, stopReason, ... }`) and
  `dispose()`. The recipes forward `request` to `spawn.start`, overriding two
  fields only when the caller did not already set them:
  - `agentOptions.provider` / `agentOptions.model` — force the kernel+model,
  - `persona` — the recipe's upstream persona.
  (`toolFilter` is intentionally NOT forwarded: since dsh-tools 0.1.1-rc.2,
  `tools.restrict()` accepts only GLOBAL tool names and rejects scope-local
  vendor names, and scoped registrations remain visible under any restriction.
  The child's tool mask is applied by the `agent/created` listener instead —
  see "Vendor tool surface on children" in §6.)
- **`prepareContinuable(request) -> Promise<{ seed? }>`** — the *continuable
  capability*: its mere presence authorizes the native background route,
  `subagents.startContinuable({ provider, label, request, signal })`, which
  resolves at inbox acceptance with `{ childId, messageId }` and never waits
  for the turn. The recipes forward verbatim to `spawn.prepareContinuable`.
  **Crucially, the continuable path never invokes `provider.start()`** — the
  continuation manager creates the child itself from the durable descriptor,
  which records exactly the request's `agentOptions.provider`/`model` and
  `persona` for cold resume. Callers (i.e. `kernel_run`)
  must therefore set those recipe fields on the request explicitly; the
  `start()` override above only covers the one-shot path.

`subagents.list()` returns the type names currently registered;
`subagents.getProvider(name)` returns a provider handle (used to read
`capabilities` / `inheritsParentContext` from `spawn`).

Continuable children are the DSH-standard background subagent experience for
free: they appear in `list_agents`, accept follow-ups through `send_message`,
are interruptible through `interrupt_agent`, cold-resume from their persisted
Session after a restart, and deliver a settlement notice (outcome + final
assistant message) to the parent when each Activation epoch ends.

### 3.3 The stream block event contract

Both adapters emit the same block-event vocabulary. Order matters:

| Event | `type` | Purpose |
| --- | --- | --- |
| block start | `block-start` | `{ index, blockType }` — open text / reasoning / tool-call |
| text delta | `text-delta` | `{ index, text }` |
| reasoning delta | `reasoning-delta` | `{ index, text }` |
| tool-call delta | `tool-call-delta` | `{ index, id, name, argumentsDelta }` |
| block end | `block-end` | `{ index, block: {...} }` — closed, complete block |
| usage | `usage` | `{ usage: { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? } }` |
| finish | `finish` | `{ reason: { kind } }` — `stop` / `max-tokens` / `tool-calls` |

`tool-call` blocks close with `arguments` as a **JSON string** (already
stringified), not an object. `reasoning` blocks close with `text`. Every block
opened with `block-start` **must** be closed with `block-end`; every stream
**must** end with `usage` then `finish`.

### 3.4 `tools.register(def)` — ToolDefinition shape

Each tool is registered with:

```js
{
  name,                // 'kernel_status' | 'kernel_run' | 'kernel_switch' | optional kimi_search/grok_search/...
  description,         // single-paragraph, includes the arg grammar
  parameters,          // JSON-Schema object for the tool input
  output: {
    schema,            // JSON-Schema for the tool result
    render,            // (args, value) => ContentBlock[] — REQUIRED, see below
  },
  execute,             // async (args, exec) => value
}
```

Two rules are load-bearing:

- **`output.schema` is an enforced subset.** Only fields declared in the schema
  are surfaced to the model/UI; extra fields on the returned object are dropped.
  The schemas here all set `additionalProperties: true` so dynamic fields
  (`error`, `kernel`, etc.) survive, but the declared `properties` define the
  *contractual* surface. Keep them in sync with what `execute` actually returns.
- **`render` is effectively required.** DSH needs a way to turn the returned
  value into content blocks. The code normalizes every definition through a
  helper that supplies a JSON-stringify fallback when `render` is absent —
  but a real tool should provide a genuine renderer. Treat the fallback as a
  safety net, not an API.

`execute` receives `(args, exec)` where `exec` exposes `agent` (the calling
agent), `signal` (AbortSignal for cancellation), and other execution context.
`kernel_run` refuses to run without `exec.agent`.

---

## 4. Wire-protocol truths (per kernel)

These are hard-won facts distilled from each harness's own source. Do not
"simplify" them casually — every header, header value, and block shape below was
verified against real traffic.

### 4.1 `kimi-kernel` — Anthropic Messages wire (Kimi Code CLI 0.39.1)

Verified against a LIVE 0.39.1 capture
(`.glm-test/kimi-code-distill/capture/req-*.json`; full distillation in that
directory's `REPORT.md`).

- URL: `https://api.kimi.com/coding/v1/messages?beta=true`.
- Auth: **`x-api-key: <OAuth access_token or static api_key>`** — NO
  `Authorization` header on `/messages`. `Bearer` is reserved for
  `/models`, `/usages`, `/me`, `/search`, `/fetch`. The OAuth path still goes
  through `freshKimiKey()` (in-process device-flow refresh against
  `auth.kimi.com`, write-back to the resolved credential file).
- Headers: `content-type: application/json`, `anthropic-version: 2023-06-01`,
  **`anthropic-beta: context-management-2025-06-27`**, `user-agent:
  kimi-code-cli/0.39.1`, `x-msh-platform: kimi_code_cli`,
  `x-msh-version: 0.39.1`, and the `X-Msh-Device-*` group
  (`-name` = `os.hostname()`, `-model` = `"<os.type> <os.release> <os.arch>"`,
  `-os-version` = `os.release()`, `-device-id` = `<kimi-code home>/device_id`).
  The whole device group is skipped when no `device_id` file exists.
- Body is a standard Anthropic Messages request plus 0.39.1 extras:
  - `thinking: {"type":"enabled"}` (0.39.1 is effort-based, NOT a token
    budget — the 1.49 `budget_tokens` ladder is gone) plus
    **`output_config: { effort }`** with the effort ladder
    `low|medium|high|xhigh|max` (default `high`);
  - **`context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }`**
    (requires the `anthropic-beta` header above);
  - **`metadata: { user_id: "session_<uuid>" }`** — one random uuid per adapter
    registration (upstream likewise generates one per CLI process);
  - **`system` as a single text block** with `cache_control:
    { type: "ephemeral" }` (`systemCacheControl: true` in the factory);
  - `stream: true`.
  The extras ride on the thinking block: a `session-title` call nulls
  `thinking` and sends NONE of them.
- **Completion budget: hard cap 128000, clamped to remaining context.**
  Upstream's `FALLBACK_MAX_TOKENS = 128000` is both the constructor fallback
  and the cap (captured `max_tokens: 128000` on a small request). The adapter
  estimates request tokens (`ascii/4` + 1 per non-ascii, plus a 1024-token
  safety margin) and sends `max_tokens = min(min(requested || 128000, 128000),
  remaining)`, floor 1 (`clampHardCap: 128000` on the shared clamp helper —
  minimax keeps the old 32000 default).
  `KIMI_MODEL_MAX_COMPLETION_TOKENS` (alias `KIMI_MODEL_MAX_TOKENS`) remains an
  optional hard cap; `0` / a negative value disables clamping. The catalog
  lists `k3-256k` (262144/131072), `k3` (1M/131072), and `kimi-for-coding`
  "Kimi K2.7 Code" (262144/32768); upstream also ships
  `kimi-for-coding-highspeed` (262144/32768) in its embedded catalog.
- **Thinking replay is verified — no signature replay needed.** Kimi returns
  `thinking` blocks in the response and accepts them back without the
  `signature` field that stock Anthropic requires for thinking passthrough.
  The adapter maps DSH `reasoning` blocks → Anthropic `thinking` blocks
  (`replayThinking: true`) and emits response `thinking` → DSH `reasoning`,
  with no `signature` bookkeeping anywhere.
- **Role-appropriate block filtering (regression-tested).** `thinking` and
  `tool_use` are emitted ONLY for assistant-role messages; in user-role
  messages the corresponding DSH `reasoning`/`tool-call` blocks are dropped,
  exactly like the native adapters (`flattenText` keeps text only). This is
  load-bearing for continuable subagents: a settlement notice embeds the
  child's final assistant message — reasoning and tool-call blocks included —
  as a USER message in the parent, and sending those as `thinking`/`tool_use`
  makes kimi reject the turn (`Invalid request: tokenization failed`).
  `_test` named export exposes the adapter factories so a
  local-HTTP-stub regression test can assert the wire shape offline (wire test
  11 asserts the full 0.39.1 body shape).
  (The Responses-wire factory in §4.2 was already role-safe: its user branch
  only ever emits text / `function_call_output` items.)
- Finish reasons come from `resp.stop_reason` (`max_tokens` → `max-tokens`,
  presence of `tool_use` → `tool-calls`).

### 4.2 `grok-kernel` — Responses wire (via proxy)

- URL: `https://cli-chat-proxy.grok.com/v1/responses`, proxied through
  `http://127.0.0.1:7897` (a local proxy is required in practice).
- **Five required headers** for the CLI proxy to accept the call:
  1. `content-type: application/json`
  2. `authorization: Bearer <key>`
  3. `X-XAI-Token-Auth: xai-grok-cli`
  4. `x-authenticateresponse: authenticate-response`
  5. one of `x-grok-client-mode: headless` and `x-grok-client-version: 1.0.12`
  (tracks `crates/codegen/xai-grok-version/Cargo.toml`)
  (plus `user-agent`)
- Body is a Responses request: `model`, `input` (an item list), optional
  `reasoning: { effort, summary }`, optional `tools` (as
  `{ type: 'function', name, description, parameters }`) and `tool_choice`.
- **Top-level `function_call` input items.** Assistant tool calls are pushed as
  top-level `{ type: 'function_call', call_id, name, arguments }` items; tool
  results as top-level `{ type: 'function_call_output', call_id, output }`
  items. They are *not* nested inside a message.
- **Reasoning replay is rejected by the proxy.** Grok can *emit* `reasoning`
  items (whose `summary` array of `{ text }` the adapter flattens into a DSH
  `reasoning` block), but the proxy will not accept `reasoning` items back on a
  subsequent request. The adapter therefore never replays reasoning into the
  `input` list — past reasoning is simply dropped.
- Effort is mapped: `low` / `medium` / `high` / `xhigh` pass through verbatim
  (upstream's wire enum accepts them 1:1 and grok-4.6 advertises `xhigh`);
  only `max` — advertised by no catalog model — collapses to `xhigh`.

### 4.3 `codex-kernel` — Responses wire (custom base URL)

- No dedicated wire of its own: it reuses the Responses-wire factory, but the
  endpoint comes from **user config**, not a hardcoded host.
- `~/.codex/config.toml` supplies `[model_providers.custom].base_url` and the
  top-level `model` key; `~/.codex/auth.json` supplies `OPENAI_API_KEY`.
- URL = `base_url` (trailing slashes stripped) + `/responses`.
- Headers: `content-type`, `authorization: Bearer <key>`, `user-agent`.
- Effort model is binary: `high` → `{ effort: 'high', summary: 'concise' }`,
  anything else (e.g. `none`) → no `reasoning` field at all. Deliberate
  divergence from upstream 0.151.0 (whose gpt-5.6 defaults are effort `low` /
  summary `none`): `high` + `concise` matches the DSH quality bar and surfaces
  reasoning summaries in the UI. The codex persona is model-aware: recipes and
  the vendor plugin's own persona pick `SYSTEM_PROMPT_GPT56` for `gpt-5.6-*`
  models via `personaForModel` (models.json `instructions_template`), and this
  module re-derives recipe personas whenever it overrides codex recipe models.

### 4.4 `minimax-kernel` — Anthropic Messages wire (CN, direct)

- URL: `https://api.minimaxi.com/anthropic/v1/messages`, CN direct (no proxy).
- Headers: `content-type`, `authorization: Bearer <key>`,
  `anthropic-version: 2023-06-01`, `user-agent`.
- Reuses the Anthropic adapter with model-dependent thinking:
  - **M2 models** (`MiniMax-M2*`): `thinkingFor` returns `null` → **no
    `thinking` block sent** (matches Mini-Agent's Anthropic client, which sends
    only `model` / `max_tokens` / `messages`).
  - **Other models**: `thinkingFor` returns `{ type: 'adaptive' }` → adaptive
    thinking.

---

## 5. Credential locations

Credentials are loaded lazily at `apply()` time from the current user's home
(`process.env.USERPROFILE || process.env.HOME || os.homedir()`) and are
**never** written into this repo. If a credential is missing, that kernel's
adapter is simply not registered.

**Cross-OS bridging (WSL).** Credential lookup does not stop at `$HOME`:
`credentialRoots()` also probes `/mnt/c/Users/<user>` when running under WSL
(process platform linux + `WSL_DISTRO_NAME` or a microsoft `/proc/version`),
so a WSL-side DSH reuses the Windows-side CLI logins without manual symlinks.
When several roots contain the same file, the **newest mtime wins** — the side
that re-logged most recently holds the fresh token. The kimi OAuth refresh
writes back to the *same* resolved file, so a WSL-side refresh is visible to
the Windows-side kimi CLI (and vice versa). Symlinks are followed, so users
who already bridged with `ln -s` see no change. Non-WSL hosts (native Windows,
plain Linux, macOS) behave exactly as before with a single root.

| Kernel | Location | Extracted field |
| --- | --- | --- |
| kimi | `~/.kimi-code/credentials/kimi-code.json` (OAuth, preferred) + `~/.kimi-code/config.toml` | `access_token` (OAuth) / `[providers.kimi-for-coding].api_key` (static fallback) |
| grok | `~/.grok/auth.json` | first key's `.key`; the 6 h JWT is **auto-refreshed in-process** (OIDC `grant_type=refresh_token` against `<oidc_issuer>/oauth2/token`, rotated RT written back to the resolved file — mirrors grok-build's `oidc_refresher.rs`) |
| codex | `~/.codex/config.toml` + `~/.codex/auth.json` | `base_url`, `model`, `OPENAI_API_KEY` |
| minimax | `~/.mini-agent/config.yaml` (fallback `~/.config/mini-agent/config.yaml`) | `api_key` (`sk-...`) |

The `codex` block also derives the default codex model id from `config.toml`'s
top-level `model` key, which feeds both the `codex-kernel` model catalog and
`kernel_switch('codex')`.

---

## 6. L2 recipe table

Each recipe pairs a kernel+model with a persona (the vendor's own subagent
prompt, composed in the vendor plugin's `lib/subagents.js`) and a `toolFilter`
allow-list. `kernel_run` maps `kernel` + `type` onto these recipe names.

| Recipe name | provider | model | toolFilter (allow) |
| --- | --- | --- | --- |
| `kimi-agent` | `kimi-kernel` | `k3-256k` | `Bash` `CronCreate` `CronDelete` `CronList` `Edit` `EnterPlanMode` `ExitPlanMode` `Glob` `Grep` `Read` `ReadMediaFile` `Skill` `TaskList` `TaskOutput` `TaskStop` `TodoList` `WaitFor` `WebSearch` `FetchURL` `Write` (0.39.1 `CODER_TOOLS` minus `mcp__*`; **no `Agent`/`AgentSwarm`** — upstream PR #2837) |
| `kimi-explore` | `kimi-kernel` | `k3-256k` | `Bash` `Read` `ReadMediaFile` `Glob` `Grep` `WebSearch` `FetchURL` |
| `kimi-plan` | `kimi-kernel` | `k3-256k` | `Read` `ReadMediaFile` `Glob` `Grep` `WebSearch` `FetchURL` (no shell, no write) |
| `grok-agent` | `grok-kernel` | `grok-4.6` | `run_terminal_cmd` `read_file` `search_replace` `list_dir` `grep` `web_search` `web_fetch` `todo_write` `task` `get_task_output` `kill_task` `enter_plan_mode` `exit_plan_mode` (upstream strips `ask_user_question` and `workflow` from every subagent) |
| `grok-explore` | `grok-kernel` | `grok-4.6` | `read_file` `list_dir` `grep` (read-only, no shell, no web) |
| `grok-plan` | `grok-kernel` | `grok-4.6` | `read_file` `list_dir` `grep` `web_search` `todo_write` (read-only, no shell, no edit) |
| `codex-agent` | `codex-kernel` | (from config) | full Codex surface (all 28 tools) |
| `codex-explore` | `codex-kernel` | (from config) | full Codex surface (all 28 tools) |
| `codex-worker` | `codex-kernel` | (from config) | full Codex surface (all 28 tools) |

minimax has no subagent type upstream, so there is no `minimax-agent` recipe.

`kernel_run` accepts `type` per kernel:

| Kernel | `type` values | default |
| --- | --- | --- |
| `kimi` | `coder` `explore` `plan` | `coder` |
| `grok` | `general` `explore` `plan` | `general` |
| `codex` | `explore` `worker` | `explore` |

minimax has no subagent type upstream, so `kernel_run` rejects `minimax`.

The `explore` / `plan` variants are strict read-only specializations; the agent
variants carry `write`/`edit` (and, for Grok, subagent-spawning) privileges.

### Vendor tool surface on children (parent-independent)

DSH's `spawn` provider hardcodes `composeFrom(parent)`, so a child normally
inherits the PARENT's preset tools. To make `kernel_run(kimi, …)` give the child
the KIMI tool surface regardless of the parent's preset, the mesh mounts the
vendor plugin on the child in the `agent/created` listener (which fires before
the child's first turn, for BOTH the continuable background path and the
one-shot foreground path):

1. `recipeForKernelChild(agent)` resolves the recipe from
   `agent.options.kernelSubagentType` (fresh creation) or, on cold resume, from
   the persisted persona in the seeded `subagent/descriptor` session event;
2. the listener mounts the vendor plugin on `agent.ctx` with
   `{ skipPersona: true, tools: recipe.toolFilter.allow }` (the vendor plugin
   registers ONLY the whitelisted names — the recipe allow-list is enforced at
   registration time, because since dsh-tools 0.1.1-rc.2 scope-local tools can
   no longer be named in a restriction), then
3. `tools.restrict({ allow: [] })` masks every inherited GLOBAL tool (parent
   preset + host), leaving the child's own scope-local vendor tools visible.

The vendor plugin modules are pre-loaded at `apply()` time (`VENDOR_MODULES`) so
the synchronous listener can mount them. `kernel_run` and the L2 provider's
`start` therefore do NOT put `toolFilter` in the request — the listener applies
it after the tools exist. `kernelSubagentType` is carried in `agentOptions`
(merge-extensible, like `reasoningEffort`).

### Lazy L2 registration (`ensureL2`)

`subagents` may not have its `spawn` provider registered yet when this row
applies at boot (registration order is not guaranteed). So L2 recipe providers
are registered **lazily**: `ensureL2()` runs at `apply()` time *and* on every
`kernel_run` / `kernel_status` call, retrying until `spawn` is visible. The
recipes themselves are loaded once at `apply()` time via `loadVendorRecipes()`
(dynamic import of each vendor plugin's `lib/subagents.js`). `ensureL2` only
registers a recipe if (a) it isn't already registered and (b) its backing kernel
adapter is actually registered in `llm.listProviders()` — so a missing credential
never leaves a dangling subagent type pointing at a nonexistent route.

---

## 7. Known gaps

These are documented limitations, not bugs to "fix" blindly — several require
upstream or harness changes beyond this package.

1. **Kimi thinking signature side table.** Kimi's thinking replay works without
   the Anthropic `signature` field, and 0.39.1's
   `context_management.edits: [clear_thinking_20251015, keep: "all"]` asks the
   provider to keep thinking blocks across turns, but there is still no local
   side table reconciling thinking blocks across a multi-turn conversation.
   Long Kimi conversations with heavy tool use may still drop reasoning in some
   sequences.
2. **Grok reasoning replay shape.** Grok emits reasoning as `reasoning.summary`
   items; the proxy rejects replayed reasoning, so past Grok reasoning is
   discarded. There is no lossless way to echo it back in the current Responses
   shape short of a proxy-side change.
3. **MiniMax needs an API key.** `minimax-kernel` only registers when an
   `api_key` (`sk-...`) is present in a mini-agent config. No key → no route, and
   `kernel_switch('minimax')` will report an unknown/unavailable provider only at
   resolve time.
4. **`loop_control` has no DSH knob.** Kimi's `loop_control`
   (`max_attempts_per_step` et al.) has no equivalent in DSH's agent loop, which
   only exposes `maxParallelToolCalls`. This is a documentation-level alignment;
   line-level parity is impossible until the harness exposes the knob.
5. ~~**Kimi `Agent` resume-by-`agent_id` / `run_in_background`.**~~ **RESOLVED.**
   `kernel_run` is now background-first on the native continuable route
   (`subagents.startContinuable`): it returns a durable child id that
   `list_agents` / `send_message` / `interrupt_agent` operate on, exactly like
   the stock `subagent` tool. See §3.2.
6. ~~**Non-streaming transports.**~~ **RESOLVED.** Both adapter factories now
   stream for real: `httpStream` sends `stream: true` with curl `-N`
   (unbuffered — without it piped curl 16 KiB-buffers and TTFT dies), parses
   SSE records incrementally (line-buffered across chunks, `ping`/comment lines
   ignored, `[DONE]` sentinel handled for OpenAI-compat wires), and maps them
   onto the §3.3 block events as they arrive. If a provider ignores
   `stream: true` and answers with one JSON body, the transport detects it (no
   SSE records + body starts with `{`) and the adapter falls back to the
   verbatim non-streaming translation — the wire regression suite asserts
   event-for-event equality of that path. There is still deliberately **no
   curl `-m` wall-clock cap**: cancellation is AbortSignal-driven end to end,
   and the idle-gap bounding native adapters get from their 300 s watchdog is
   approximated by the harness-level cancellation path.
7. **Responses-wire images are carried as `input_image` parts (proxy support
   unverified).** The Anthropic-wire factories (kimi, minimax) resolve DSH
   `image` blocks through the durable attachments service
   (`attachments.readImage`, the same channel the native pi-ai adapter uses via
   `config.resolveAttachments`) and emit standard Anthropic base64 `image`
   blocks. The Responses-wire factories (grok, codex) now do the same through
   `responsesImageBlock`, emitting a `{ type: 'input_image', image_url:
   'data:<mediaType>;base64,<data>' }` content part inside the user message.
   Unreadable attachments are omitted on both wires. The grok CLI proxy's
   `input_image` support is still unverified — if it rejects the part, adapt
   the shape in `responsesImageBlock` (the single choke point).

---

## 8. Testing procedures used

The mesh was validated with three complementary approaches. Rerun them whenever
the wire code changes.

1. **Headless CLI smoke test.** From a DSH session on the host plane, invoke
   `kernel_status` and confirm all expected kernels (for which credentials exist)
   and all 7 L2 recipe providers are listed.
2. **Tool-loop tests.** Drive `kernel_run` against each kernel/type pair with a
   trivial task (e.g. "list files in the workspace"). The default background
   route must return `{ kind: 'continuable', ok: true, subagentId }` and the
   child must appear in `list_agents`, settle with a runtime notice, and accept
   a `send_message` follow-up; `run_in_background: false` must return
   `{ kind: 'foreground', ok: true }` plus a non-empty `output`, exercising
   tool-call → tool-result round-trips on each wire.
3. **Differential test vs. real Kimi CLI — the 17-colors task.** Run the *same*
   task ("count CSS color values") on the real `kimi` CLI and on
   `kimi-kernel` + the pure-kimi tool surface, then compare results item by item.
   Acceptance: both report 17 colors (11 `#hex` + 6 `rgba`), the first card title
   is `KIMI`, and the tool surface is name-and-schema identical. An independent
   subagent re-verified the color counts by regex (`#[0-9a-fA-F]{3,8}` ×11,
   `rgba?\(` ×6). This is the real "assimilation" gate — the DSH kimi-kernel path
   must be indistinguishable from the native CLI on the same input.

---

## 9. Adding a new kernel, step by step

1. **Distill the wire.** Read the target harness's source to determine its wire
   (Anthropic Messages vs. Responses vs. other), its endpoint, and every
   mandatory header. Record them as a comment block, mirroring the header comment
   in `index.js`.
2. **Pick or extend a factory.** Anthropic-wire targets reuse
   `makeAnthropicAdapter(opts)`; Responses-wire targets reuse
   `makeResponsesAdapter(opts)`. If the wire is neither, add a new factory that
   emits the exact block-event contract in §3.3.
3. **Add credential loading** in `loadCredentials()` for the new config location,
   and model catalog entries in `apply()`.
4. **Register the adapter** in `apply()`, guarded by the credential presence, with
   `tag`, `name`, `url`, `headers`, `models`, and (responses wire) `efforts` /
   `defaultEffort` / `mapEffort`.
5. **Add L2 recipes** to the vendor plugin's `lib/subagents.js` (persona = the harness's own
   subagent prompt, plus an appropriate `toolFilter`), and extend the `TYPE_MAP`
   in `kernel_run`.
6. **Extend `kernel_switch`'s map** to include the new route and a `deepseek`
   fallback back to `deepseek-official/deepseek-v4-pro`.
7. **Update the `kernel_status` filter list** to include the new provider id.
8. **Test** per §8, and record any new wire quirks in §4 and new gaps in §7.

Do not touch `cordis.patch.yml` unless the row id/name must change — it only
mounts `lib/index.js`; all logic lives in JS.
