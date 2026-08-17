# Offline tests for dsh-kernel-mesh

No test framework. Each file is a plain Node script that uses `node:assert`
and exits `0` on success or non-zero with a `FAIL:` message on failure.

## How to run

From the package root:

```bash
node test/wire.test.js && node test/cred-paths.test.js
```

## What is covered

`wire.test.js` drives `_test` named export (`makeAnthropicAdapter`,
`makeResponsesAdapter`, `anthropicImageBlock`) against a **local** `node:http`
stub. It never talks to a real upstream.

1. Anthropic SSE — thinking + text + tool_use, tiny flushed chunks, incremental parse, usage `cacheReadTokens`, finish `tool-calls`.
2. Anthropic JSON fallback — provider ignores SSE; events match the non-streaming translation; request still has `stream: true`.
3. Anthropic role filtering — user `reasoning`/`tool-call` flattened away; assistant keeps `thinking`/`tool_use`; consecutive same-role users merge.
4. Anthropic `tool_use` — complete `input` on `content_block_start` with no deltas vs. deltas winning (start input not concatenated).
5. Anthropic JSON error shapes — `rate_limit_error` → `RATE_LIMIT`, `authentication_error` → `AUTH`, unparseable body → `SERVER` (own `code` + `failure.code`).
6. Responses SSE — message + function_call, CRLF + `data: [DONE]`, `inputTokens = input - cached`, nothing after `response.completed`.
7. Responses JSON fallback — `output_text` + `refusal`, reasoning summaries joined by `\n`, function_call; `rate_limit_exceeded` (code wins over type) → `RATE_LIMIT`; `insufficient_quota` → `QUOTA`.
8. Responses SSE `event: error` / `response.failed` — classified throw, not `ReferenceError`.
9. Images — `anthropicImageBlock` base64 vs. placeholder; end-to-end user image on the Anthropic wire.
10. Kimi 1.49 completion clamp — `estimateTextTokens` / env contract / adapter sends a clamped `max_tokens`.

`cred-paths.test.js` copies `newestExistingIn` inline (documented as a
mirror of `index.js`) and checks newest-wins / missing-null / symlink-follow.
It also requires the real plugin and, when `~/.grok/auth.json` exists, asserts
the live resolution agrees.

## What is NOT covered

Live upstream calls, L2 recipe registration, `kernel_run` / `kernel_switch`,
and the 17-colors differential vs. the real Kimi CLI. Those stay in
[AGENTS.md §8](../AGENTS.md).
