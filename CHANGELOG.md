# Changelog

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
