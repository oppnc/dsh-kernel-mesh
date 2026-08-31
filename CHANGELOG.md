# Changelog

## 0.1.8

- **npm.** `dsh-kernel-mesh@0.1.7` is on the registry. Preferred install is now `dsh plugin --profile web add dsh-kernel-mesh`.

## 0.1.7

- **Publish channels.** Preferred install is `dsh plugin --profile web add dsh-kernel-mesh` (npm, once published); GitHub remains a fallback because `lib/` ships in the repository. Keywords include `dsh-plugin`. Storefront screenshots are declared in `screenshots.json`. The awesome-dsh-plugin entry lives in `docs/awesome-dsh-plugin.yml`.

## 0.1.6

- **`kernelMesh` marker service.** `apply()` now provides
  `ctx.provide('kernelMesh', { version })` so vendor packages (which declare the
  mesh as a dependency and fallback-mount it when the host composition did
  not) can detect an existing mount and stay idempotent.

- **Grok OIDC auto-refresh.** `freshGrokKey()` is now async: when the 6-hour
  access JWT is within 60 s of expiry it runs a standard OIDC
  `refresh_token` exchange against `<oidc_issuer>/oauth2/token` (form fields
  incl. `principal_type`/`principal_id`, mirroring grok-build's
  `oidc_refresher.rs`), writes the rotated tokens back to the resolved
  `auth.json`, and dedupes concurrent refreshes. `grok_search`/`grok_fetch`
  share the same refresh path via an injected key provider. Previously an
  expired JWT failed every grok call until the user re-logged in the CLI.

- **Kimi Code CLI 0.39.1 wire sync** (`@moonshot-ai/kimi-code@0.39.1`, verified
  against a live capture in `.glm-test/kimi-code-distill/`):
  - URL gains `?beta=true`.
  - `/messages` auth is now `x-api-key` ONLY (no `Authorization` header);
    `Bearer` stays on `/search`/`/fetch` and the OAuth refresh. The
    `freshKimiKey()` OAuth refresh logic is unchanged.
  - New headers: `user-agent: kimi-code-cli/0.39.1`, `x-msh-platform:
    kimi_code_cli`, `x-msh-version: 0.39.1`, `anthropic-beta:
    context-management-2025-06-27`, and the `X-Msh-Device-*` group
    (OS-derived; the whole group is skipped when no `device_id` file exists).
    `kimiOAuthHeaders()` and `search-backends.js` carry the same values.
  - Body: `thinking: {"type":"enabled"}` + `output_config: { effort }`
    (effort ladder `low|medium|high|xhigh|max`, default `high`; the 1.49
    `KIMI_EFFORT_BUDGET` token-budget ladder is gone, `thinkingFor`'s
    `(model, effort)` signature is unchanged so minimax's adaptive callback is
    unaffected), `context_management.edits:
    [{ type: "clear_thinking_20251015", keep: "all" }]`, `metadata.user_id:
    "session_<uuid>"` (one random uuid per adapter registration), and `system`
    as a single text block with `cache_control: ephemeral`. A `session-title`
    call still nulls `thinking` and now sends NONE of the extras.
  - `max_tokens` hard cap is 128000 (upstream `FALLBACK_MAX_TOKENS`, the value
    seen on the wire), still clamped to the remaining context estimate;
    `clampKimiMaxTokens` gained an optional 5th `hardCap` arg and the factory a
    `clampHardCap` opt (minimax keeps the 32000 default). New factory opts
    `extraBodyFor(model, effort)` and `systemCacheControl`.
  - Effort catalog gains `xhigh`; `defaultEffort` corrected `max` → `high`
    (upstream default).
- **Wire test 11** asserts the full 0.39.1 body shape offline (thinking,
  output_config, context_management, metadata, cached system block, 128000
  cap, session-title suppression, effort fallback).
- AGENTS.md §4.1 rewritten to the 0.39.1 wire; §5 credential table now lists
  the OAuth token file; §6 kimi recipe rows updated to the 0.39.1 tool names.

## 0.1.5

- **DSH 0.1.1-rc.2 compatibility: implement `prepareCall`.** The new dsh-llm
  calls `adapter.prepareCall(provider, model, signal)` on the exact-model path
  (agent loop and `llm.stream`) and expects the base-class default shape
  `{ model, stream }`. Adapters without it failed every turn with
  `registration.adapter.prepareCall is not a function`. Both factories
  (Anthropic-wire and Responses-wire) now implement it; wire test 0 guards the
  contract offline.
- **DSH 0.1.1-rc.2 compatibility: drop `toolFilter` from subagent requests.**
  The new dsh-tools restricts `tools.restrict()` to GLOBAL tool names and
  rejects scope-local (vendor) names, so a request-level `toolFilter` failed
  child creation with `tools.restrict() names unknown global tools ...`.
  Restriction now lives entirely in the `agent/created` listener: the vendor
  plugin registers only the recipe's whitelisted tools (`config.tools`), then
  `restrict({ allow: [] })` masks every inherited global tool.
- **Grok Build sync (e5fd481..origin/main, 2026-08).** `x-grok-client-version`
  bumped 1.0.3 → 1.0.12 (adapter, `search-backends.js`, and the grok plugin's
  `web_search` wire); grok effort mapping now passes `xhigh` through verbatim
  (grok-4.6 advertises it upstream) and collapses only `max` → `xhigh`.
- **Codex sync (rust-v0.151.0).** Codex recipe personas follow the model
  upstream would actually serve: the mesh picks up `personaForModel` from
  dsh-kernel-codex's `lib/subagents.js` and re-derives each codex recipe's
  persona whenever it overrides recipe models (config.toml or fallback), so
  gpt-5.6 children get the models.json gpt-5.6 template instead of the legacy
  gpt-5.2-era prompt.

## Unreleased

- **Proxy is env-driven, not hardcoded.** Kernel HTTP now honors
  `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` and defaults to a direct
  connection; the hardcoded `http://127.0.0.1:7897` broke machines without a
  local proxy.
- **Vendor home overrides.** `GROK_HOME`, `KIMI_CODE_HOME`, and `CODEX_HOME`
  are honored when locating grok/kimi/codex credentials.
- **Agent presets ship with the bundle.** `presets/` carries the four kernel
  presets (`codex-kernel` / `grok-kernel` / `kimi-kernel` / `minimax-kernel`);
  copy them into `~/.dsh/.agent-presets/` to install. (A bundle cannot
  register extra preset roots because the official dsh CLI overwrites
  `agent-presets.roots` with its own shipped root.)

## 0.1.4

- **Subagent recipes are the single source of truth.** `kernel_run` and the L2
  providers set `persona`/`toolFilter`/`agentOptions` from the vendor recipes,
  including `toolFilter` on the continuable request for cold resume.
- **Fallback routes are opt-in.** `DSH_KERNEL_USE_FALLBACK=1` enables the
  ollama/opencode-go fallbacks; the default is each kernel's official API.
- **Model catalogs from published specs.** kimi `k3` (1M / 131072), `k3-256k`
  (256K / 131072), `kimi-for-coding` (256K / 32768); grok `grok-4.6`/`grok-4.5`
  (500K, default effort `high`); minimax `MiniMax-M2.5` (204800 / 131072).
- **codex model from local config.** The codex route uses `~/.codex/config.toml`
  (`model` + `base_url`); no fabricated default model, and the adapter only
  registers when a model is configured.
- **Scattered fixes.** kimi OAuth `X-Msh-Version` 1.49.0; `kimi_search` default
  limit 5; removed dead `recipeToolFilter`/`availableSearchTools`.

## 0.1.3

- **L2 subagent recipes now live in the vendor plugins.** Each kernel plugin ships
  `lib/subagents.js` with its own upstream subagent prompts; the mesh loads them
  dynamically, so the recipes stay with their vendor and the mesh stays optional.
- **Subagent tool surface is now the vendor's own.** The `agent/created` listener
  mounts the vendor plugin on the child with a `config.tools` whitelist and then
  `restrict({ allow: [] })`, so a kernel subagent sees ONLY its vendor's tools
  (plus `report`) — independent of the parent's preset.
- **Subagent set matches upstream exactly.** `kimi` coder/explore/plan, `grok`
  general/explore/plan, `codex` explore/worker; `minimax` contributes none (no
  subagent tool upstream).
- **Fallback model routes.** `DSH_KERNEL_USE_FALLBACK` (default on) routes the
  kernels through the user's existing subscriptions when the official APIs are
  out of quota: kimi → ollama `kimi-k2.7-code`, grok → ollama `gpt-oss:120b`,
  codex → opencode-go `gpt-5.6-luna`, minimax → ollama `minimax-m3`. Keys are
  read from `~/.dsh/.credentials.yaml`.
- **Responses-wire images.** `buildResponsesInput` now carries DSH `image` blocks
  as `input_image` content parts (grok/codex), matching the Anthropic-wire path.

## 0.1.2

- Official ESM form, vendor search tools, WSL recipe filter.
