# Changelog

## 1.0.3

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
