# AGENTS.md — dsh-kernel-mesh 维护者文档

这是 `dsh-kernel-mesh` 的完整工程参考。面向维护者（人类或 agent），用于理解、调试或扩展这个网络核心。如果你只想*使用*本插件，请改读 [`README.md`](README.md)。

---

## 1. 本包是什么

`dsh-kernel-mesh` 是 DeepSeek Harness（DSH）的一个**宿主侧（host-plane）Cordis bundle**。它把外来的编码 harness——Kimi Code、Grok Build、OpenAI Codex、MiniMax Mini-Agent——以一等公民的身份接入 DSH，分三层：

- **L1**（`llm.registerAdapter`）：把 `kimi-kernel`、`grok-kernel`、`codex-kernel`、`minimax-kernel` 注册为 DSH 模型*路由*。任何会话或 agent 预设随后都能在模型选择器中选中这些 provider，从而让主 agent 本身就运行在外来内核上。
- **L2**（`subagents.registerProvider`）：注册蒸馏出来的*子代理配方*（`kimi-agent`、`kimi-explore`、`kimi-plan`、`grok-agent`、`grok-explore`、`codex-agent`、`codex-explore`、`minimax-agent`）。它们包装 DSH 内置的 `spawn` provider，把子代理强制绑定到特定内核 + 模型，并使用固定的 persona 与工具过滤，逐一对应各 harness 自身的子代理类型。
- **工具**（`tools.register`）：`kernel_status`、`kernel_run`、`kernel_switch`，以及按订阅选择接入的厂商搜索工具：仅当已安装 `dsh-kernel-kimi` 且存在 Moonshot 凭证时才注册 `kimi_search`/`kimi_fetch`；仅当已安装 `dsh-kernel-grok` 且存在 Grok OAuth 凭证时才注册 `grok_search`/`grok_fetch`。官方 `ctx.web` 一次只能钉一个 `searchProvider`，所以这些保持为并列的模型可见工具。不要假设每个用户都订阅了每一家。

插件以两个文件加元数据的形式交付：

- `lib/index.js` —— 完整的宿主插件（`export { name, inject, apply }`）。
- `cordis.patch.yml` —— 把 `kernel-mesh` 行插入宿主组合的 bundle patch。
- `package.json` —— 通过 `dsh.bundle.patch` 让 DSH 打包器指向该 patch。

源包位于 `harness-kernels/packages/dsh-kernel-mesh/`；本 release 目录是它的扁平化、可发布副本。

---

## 2. 架构：宿主侧 bundle、注入顺序与生命周期

DSH 由 Cordis 插件组合而成。`cordis.patch.yml` 插入一行：

```yaml
- insert:
    - id: kernel-mesh
      name: dsh-kernel-mesh
```

该行把 `lib/index.js` 挂载到**宿主侧**（DSH 的 Node.js 进程）。位于宿主侧很关键：`llm`、`subagents`、`tools` 都是宿主服务，宿主代码才能访问文件系统（读取凭据文件）与网络（访问上游 API）。浏览器/client 插件无法做到这些。

### `inject` 列表及其重要性

```js
export const name = 'dsh-kernel-mesh'
export const inject = ['llm', 'tools', 'subagents']
export function apply(ctx) { /* ... */ }
```

`inject` 是一道**硬依赖屏障**。Cordis 会等到每个声明的服务就绪后**才调用** `apply()`。这修复了本插件历史上最危险的一类 bug：

> **Bug #1 —— bundle 静默失效。** 早期版本遗漏了 `inject`，并在 `apply()` 开头读取 `ctx.get('llm')`。启动期间 `llm` 尚为 `undefined`，于是插件命中 `if (!llm) return` 后静默地什么都没注册——没有报错、没有适配器、没有工具。补上 `inject` 之后，`apply()` 运行前这些服务必然存在，于是那个静默 return 从一个静默失败变成了真正兜底的安全网。

在 `apply()` 内部，代码通过 `ctx.get(...)` 重新读取这些服务，并把它们视为可能缺失（`if (!llm) return`），因为服务仍可能在运行中被拆除。切勿在未在 `inject` 中声明的情况下，把注入的服务当作裸的 `ctx.llm` 属性直接读取。

在 `apply()` 内注册的一切——适配器、子代理 provider、工具——都绑定到插件的 Cordis **fiber**。当该行被移除、更新或会话结束时，Cordis 会自动全部释放。不要制造存活期超过 `apply()` 的模块级副作用。

---

## 3. 代码所依赖的 DSH 服务契约

这些是 `index.js` 所依赖的确切契约。它们都是鸭子类型：DSH 不要求子类，只要求方法返回正确的形状。

### 3.1 `llm.registerAdapter(providers, adapter)`

为一个或多个 provider id 注册 LLM 适配器。适配器对象必须实现：

- **`providerInfo(provider) -> { id, name }`** —— 该路由的人类可读身份。此处每个适配器返回 `{ id: provider, name: opts.name }`。
- **`providerRetryPolicy() -> undefined | policy`** —— 重试/退避策略。四个适配器都返回 `undefined`（交由 DSH 默认值）。不要伪造返回一个策略对象。
- **`listModels(provider) -> Promise<Model[]>`** —— 供选择器使用的模型目录。每个 `Model` 为 `{ provider, id, name }`（上下文窗口与默认最大 token 也可以附带，但以 `resolveModel` 为准）。
- **`resolveModel(provider, model) -> Promise<ResolvedModel>`** —— 把模型 id 解析为 `{ provider, id, name, context: { contextWindow }, defaultMaxTokens }`。未知 id 回退到宽泛默认值（20 万上下文 / 32768 token）。Responses-wire 适配器还会额外附带 `reasoning: { efforts, defaultEffort }`。
- **`stream(options) -> AsyncGenerator<Block>`** —— 核心。`options` 携带 `model`、`messages`、`system`、`tools`、`maxTokens`，以及（responses-wire 下）`reasoningEffort`，外加一个 AbortSignal。生成器必须**按顺序产出 DSH block 事件**（见 3.3），并以 `usage` 事件和 `finish` 事件结束。 两个工厂现在从 SSE **增量产出**（真正的 TTFT）；传输细节与 JSON 自动回退见 §7.6。

下面两个工厂都遵守这个 async-generator 契约。畸形的适配器（例如返回 Promise 而非 async generator，或忘记最后的 `finish` 事件）会让调用方静默挂起或崩溃。

**失败分类也是契约的一部分。** 抛出的错误必须把规范分类码作为自有数据属性携带——`e.code` 以及与之匹配的 `e.failure = { message, code, status? }` 快照——因为 dsh-llm 的 adapter-failure 归一化正是从外部错误的这些自有属性读取分类的（不需要、也不可能跨模块实例 import `HarnessError`）。请用 `llmFail(message, code, status?)` / `providerError(tag, wireError)`；绝不要从适配器边界抛裸 `Error`。映射：wire 的 `rate_limit_error`/`overloaded_error` → `RATE_LIMIT`，`api_error` → `SERVER`，`authentication_error`/`permission_error` → `AUTH`，`request_too_large` → `CONTEXT_WINDOW_EXCEEDED`，curl 退出/spawn 失败 → `TRANSPORT`，响应体不可解析 → `SERVER`，中止 → `ABORTED`。dsh-llm-retry 的默认 normal 策略会对 `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT` 做 2 次有界退避重试；`AUTH`/`INVALID_REQUEST`/`UNKNOWN` 只失败一次。裸 Error 即 `UNKNOWN`——修复前就是这样，一次瞬时 429 就会直接杀死整个回合。

### 3.2 `subagents.registerProvider(provider)`、`subagents.start(name, request)` 与 `subagents.startContinuable(spec)`

子代理 *provider* 支撑一个或多个对 `subagents.list()` 可见的 L2 子代理*类型*。这个 provider 对象必须实现：

- **`capabilities`** —— 能力描述符对象。配方从被包装的 `spawn` provider 逐字复制它，让蒸馏出的子代理表现得像原生 spawn 子代理。
- **`inheritsParentContext`** —— 布尔值；同样从 `spawn` 复制。
- **`start(request) -> Promise<Run>`** —— 启动一个子代理运行，返回一个句柄，句柄至少具备 `result`（resolve 为 `{ output, stopReason, ... }`）和 `dispose()`。配方把 `request` 转发给 `spawn.start`，仅在调用方未显式设置时覆盖三个字段：
  - `agentOptions.provider` / `agentOptions.model` —— 强制内核 + 模型，
  - `persona` —— 配方的蒸馏 persona，
  - `toolFilter` —— 配方的允许列表。
- **`prepareContinuable(request) -> Promise<{ seed? }>`** —— *可续接能力*：该方法的存在本身即授权原生后台路由 `subagents.startContinuable({ provider, label, request, signal })`；它在收件箱受理时以 `{ childId, messageId }` resolve，从不等待回合执行。配方逐字转发给 `spawn.prepareContinuable`。**关键是，可续接路径从不调用 `provider.start()`** —— continuation manager 依据持久 descriptor 自行创建子代理，descriptor 恰好记录请求中的 `agentOptions.provider`/`model`、`persona` 与 `toolFilter` 供冷恢复。因此调用方（即 `kernel_run`）必须把这些配方字段显式设置在请求上；上面的 `start()` 覆盖只覆盖一次性路径。

`subagents.list()` 返回当前已注册的类型名；`subagents.getProvider(name)` 返回 provider 句柄（用于从 `spawn` 读取 `capabilities` / `inheritsParentContext`）。

可续接子代理免费带来 DSH 标准的后台子代理体验：出现在 `list_agents` 中、经 `send_message` 接受后续任务、可被 `interrupt_agent` 中断、重启后可从持久 Session 冷恢复，并在每个 Activation 纪元结束时向父代理投递结算通知（结果 + 最终 assistant 消息）。

### 3.3 流 block 事件契约

两个适配器都发出同一套 block 事件词汇。顺序很关键：

| 事件 | `type` | 用途 |
| --- | --- | --- |
| block 开始 | `block-start` | `{ index, blockType }` —— 打开 text / reasoning / tool-call |
| 文本增量 | `text-delta` | `{ index, text }` |
| 推理增量 | `reasoning-delta` | `{ index, text }` |
| 工具调用增量 | `tool-call-delta` | `{ index, id, name, argumentsDelta }` |
| block 结束 | `block-end` | `{ index, block: {...} }` —— 关闭的、完整的 block |
| 用量 | `usage` | `{ usage: { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? } }` |
| 结束 | `finish` | `{ reason: { kind } }` —— `stop` / `max-tokens` / `tool-calls` |

`tool-call` block 以**JSON 字符串**（已 stringify）而非对象的形式关闭 `arguments`。`reasoning` block 以 `text` 关闭。每个由 `block-start` 打开的 block **必须**由 `block-end` 关闭；每条流**必须**以 `usage` 后接 `finish` 结束。

### 3.4 `tools.register(def)` —— ToolDefinition 形状

每个工具按如下方式注册：

```js
{
  name,                // 'kernel_status' | 'kernel_run' | 'kernel_switch'
  description,         // 单段描述，包含参数语法
  parameters,          // 工具输入的 JSON-Schema 对象
  output: {
    schema,            // 工具结果的 JSON-Schema
    render,            // (args, value) => ContentBlock[] —— 必需，见下
  },
  execute,             // async (args, exec) => value
}
```

有两条规则是承重的：

- **`output.schema` 是强制的子集。** 只有 schema 里声明的字段才会呈现给模型/UI；返回值上多余的字段会被丢弃。这里的 schema 都设了 `additionalProperties: true`，好让动态字段（`error`、`kernel` 等）得以保留，但声明的 `properties` 定义了*契约性*表面。要让它们与 `execute` 实际返回的内容保持同步。
- **`render` 实际上必需。** DSH 需要一种把返回值变成 content block 的方式。代码通过一个 helper 规范每一个定义——当 `render` 缺失时提供一个 JSON-stringify 兜底——但真正的工具应当提供真实的渲染器。把兜底当作安全网，而不是 API。

`execute` 接收 `(args, exec)`，其中 `exec` 暴露 `agent`（调用方 agent）、`signal`（用于取消的 AbortSignal），以及其他执行上下文。`kernel_run` 在没有 `exec.agent` 时会拒绝执行。

---

## 4. 各内核的 wire 协议真相

这些是从各个 harness 自身源码蒸馏出的、来之不易的事实。不要随随便便“简化”它们——下面的每个 header、header 值和 block 形状都经过了真实流量的验证。

### 4.1 `kimi-kernel` —— Anthropic Messages wire

- URL：`https://api.kimi.com/coding/v1/messages`。
- Headers：`content-type: application/json`、`authorization: Bearer <key>`、**`anthropic-version: 2023-06-01`**，以及一个 `user-agent`。
- 请求体是标准 Anthropic Messages 请求：`model`、`max_tokens`、`messages`、可选的 `system`、可选的 `tools`（形如 `{ name, description, input_schema }`），以及一个 `thinking` block。
- **补全预算按剩余上下文夹紧（kimi-cli 1.49.0）。** 适配器估算请求 token（`ascii/4` + 每个非 ASCII 1 token，再加 1024 的安全余量），发送 `max_tokens = min(requested, remaining)`。`KIMI_MODEL_MAX_COMPLETION_TOKENS`（别名 `KIMI_MODEL_MAX_TOKENS`）是可选硬上限；`0` / 负值关闭夹紧。目录现在在 `k3-256k` 旁边还列出 `k3`（1M 上下文）。
- **thinking 重放已验证——无需 signature 重放。** Kimi 在响应中返回 `thinking` block，并且不需要原生 Anthropic 在 thinking 透传时要求的 `signature` 字段就能原样接受它们回头。适配器把 DSH 的 `reasoning` block 映射为 Anthropic 的 `thinking` block（`replayThinking: true`），并把响应中的 `thinking` 发行为 DSH 的 `reasoning`，全程不涉及任何 `signature` 簿记。
 - **按角色过滤 block（已有回归测试）。** `thinking` 与 `tool_use` 只为 assistant 角色的消息发出；在 user 角色的消息里，对应的 DSH `reasoning`/`tool-call` block 会被丢弃，与原生适配器完全一致（`flattenText` 只保留文本）。这对可续接子代理是承重的：结算通知会把子代理的最终 assistant 消息——含 reasoning 与 tool-call block——作为父会话里的 USER 消息嵌入，若把它们发成 `thinking`/`tool_use`，kimi 会拒绝该回合（`Invalid request: tokenization failed`）。`_test` named export 导出适配器工厂，离线回归测试可用本地 HTTP 桩断言 wire 形状。（§4.2 的 Responses-wire 工厂本来就角色安全：它的 user 分支只会发出文本 / `function_call_output` 条目。）
- 这里的 `thinkingFor` 始终返回 `{ type: 'enabled', budget_tokens: 16384 }`，因此 Kimi 总是思考。结束原因来自 `resp.stop_reason`（`max_tokens` → `max-tokens`，出现 `tool_use` → `tool-calls`）。

### 4.2 `grok-kernel` —— Responses wire（经代理）

- URL：`https://cli-chat-proxy.grok.com/v1/responses`，实际需经由 `http://127.0.0.1:7897` 代理转发（本地代理在实践上必需）。
- **CLI 代理接受调用所必需的五个 header**：
  1. `content-type: application/json`
  2. `authorization: Bearer <key>`
  3. `X-XAI-Token-Auth: xai-grok-cli`
  4. `x-authenticateresponse: authenticate-response`
  5. `x-grok-client-mode: headless` 与 `x-grok-client-version: 1.0.3` 之一
  （另加 `user-agent`）
- 请求体是 Responses 请求：`model`、`input`（一个 item 列表）、可选的 `reasoning: { effort, summary }`、可选的 `tools`（形如 `{ type: 'function', name, description, parameters }`）以及 `tool_choice`。
- **顶层 `function_call` 输入 item。** 助手的工具调用以顶层 `{ type: 'function_call', call_id, name, arguments }` item 推入；工具结果以顶层 `{ type: 'function_call_output', call_id, output }` item 推入。它们*并非*嵌套在某个 message 里。
- **代理会拒绝 reasoning 重放。** Grok 可以*发出* `reasoning` item（适配器把其 `summary` 数组里的 `{ text }` 拍平为 DSH 的 `reasoning` block），但代理不会在后续请求中接受 `reasoning` item 回头。因此适配器从不把 reasoning 重放进 `input` 列表——过往的 reasoning 被直接丢弃。
- Effort 会被映射：DSH 的 `max` / `xhigh` 被折叠为 `high`；只有 `low` / `medium` / `high` 会原样通过。

### 4.3 `codex-kernel` —— Responses wire（自定义 base URL）

- 它没有专属的 wire：复用 Responses-wire 工厂，但端点来自**用户配置**，而非硬编码主机。
- `~/.codex/config.toml` 提供 `[model_providers.custom].base_url` 与顶层 `model` 键；`~/.codex/auth.json` 提供 `OPENAI_API_KEY`。
- URL = `base_url`（去除末尾斜杠）+ `/responses`。
- Headers：`content-type`、`authorization: Bearer <key>`、`user-agent`。
- Effort 模型是二元的：`high` → `{ effort: 'high', summary: 'concise' }`，其余（例如 `none`）→ 完全不发送 `reasoning` 字段。

### 4.4 `minimax-kernel` —— Anthropic Messages wire（国内、直连）

- URL：`https://api.minimaxi.com/anthropic/v1/messages`，国内直连（无代理）。
- Headers：`content-type`、`authorization: Bearer <key>`、`anthropic-version: 2023-06-01`、`user-agent`。
- 复用 Anthropic 适配器，思考模式按模型区分：
  - **M2 模型**（`MiniMax-M2*`）：`thinkingFor` 返回 `null` → **始终思考关闭**（默认行为，不发送 `thinking` block）。
  - **M3 模型**（`MiniMax-M3` 等）：`thinkingFor` 返回 `{ type: 'adaptive' }` → **自适应思考**。

---

## 5. 凭据位置

凭据在 `apply()` 时从当前用户主目录（`process.env.USERPROFILE || process.env.HOME || os.homedir()`）惰性加载，并**绝不**写入本仓库。若缺少某凭据，则对应内核的适配器直接不注册。

**跨系统桥接（WSL）。** 凭据查找不止于 `$HOME`：在 WSL 下运行时（linux 平台 + `WSL_DISTRO_NAME` 或 `/proc/version` 含 microsoft），`credentialRoots()` 还会探测 `/mnt/c/Users/<user>`，因此 WSL 侧的 DSH 无需手工软链即可复用 Windows 侧 CLI 的登录态。当多个根目录含有同一文件时，**mtime 最新者胜出**——最近重新登录的一侧持有新鲜 token。kimi OAuth 刷新写回*同一个*解析出的文件，因此 WSL 侧的刷新对 Windows 侧的 kimi CLI 可见（反之亦然）。符号链接会被跟随，已用 `ln -s` 桥接的用户不受任何影响。非 WSL 主机（原生 Windows、纯 Linux、macOS）行为与之前完全一致，只有一个根目录。

| 内核 | 位置 | 提取字段 |
| --- | --- | --- |
| kimi | `~/.kimi-code/config.toml` | `[providers.kimi-for-coding].api_key` |
| grok | `~/.grok/auth.json` | 第一个键的 `.key` |
| codex | `~/.codex/config.toml` + `~/.codex/auth.json` | `base_url`、`model`、`OPENAI_API_KEY` |
| minimax | `~/.mini-agent/config.yaml`（回退 `~/.config/mini-agent/config.yaml`） | `api_key`（`sk-...`） |

`codex` 块还会从 `config.toml` 顶层 `model` 键推导默认 codex 模型 id，这同时喂给 `codex-kernel` 模型目录与 `kernel_switch('codex')`。

---

## 6. L2 配方表

`RECIPES` 中每个配方都把「内核 + 模型」与一个 persona（蒸馏自源 harness 自身的子代理提示词）和一个 `toolFilter` 允许列表配对。`kernel_run` 把 `kernel` + `type` 映射到这些配方名。

| 配方名 | provider | model | toolFilter（允许） |
| --- | --- | --- | --- |
| `kimi-agent` | `kimi-kernel` | `k3-256k` | `pwsh` `read` `read_image` `glob` `grep` `write` `edit` `web_search` |
| `kimi-explore` | `kimi-kernel` | `k3-256k` | `pwsh` `read` `read_image` `glob` `grep` `web_search` |
| `kimi-plan` | `kimi-kernel` | `k3-256k` | `read` `read_image` `glob` `grep` `web_search`（无 shell、无 write） |
| `grok-agent` | `grok-kernel` | `grok-4.6` | `pwsh` `read` `read_image` `glob` `grep` `write` `edit` `web_search` `subagent` `subagent_fork` |
| `grok-explore` | `grok-kernel` | `grok-4.6` | `pwsh` `read` `read_image` `glob` `grep` `web_search` |
| `codex-agent` | `codex-kernel` |（来自配置） | `pwsh` `read` `read_image` `glob` `grep` `write` `edit` `web_search` |
| `codex-explore` | `codex-kernel` |（来自配置） | `pwsh` `read` `read_image` `glob` `grep` `web_search` |
| `minimax-agent` | `minimax-kernel` | `MiniMax-M2.7` | `pwsh` `read` `read_image` `glob` `grep` `write` `edit` `web_search` |

`kernel_run` 按内核接受 `type`：

| 内核 | `type` 取值 | 默认 |
| --- | --- | --- |
| `kimi` | `coder` `explore` `plan` | `coder` |
| `grok` | `general` `explore` | `general` |
| `codex` | `general` `explore` | `general` |
| `minimax` | `general` | `general` |

`explore` / `plan` 变体是严格的只读特化；agent 变体则带 `write`/`edit`（Grok 还有派生子代理）特权。

### 惰性 L2 注册（`ensureL2`）

本行在启动时 apply 时，`subagents` 可能尚未注册它的 `spawn` provider（注册顺序不保证）。因此 L2 配方 provider 采用**惰性**注册：`ensureL2()` 在 `apply()` 时运行，*且*在每次 `kernel_run` / `kernel_status` 调用时运行，反复重试直到 `spawn` 可见。它只在（a）该配方尚未注册且（b）其背后的内核适配器确实已在 `llm.listProviders()` 中注册时才注册——所以缺失凭据绝不会留下一个指向不存在路由的悬空子代理类型。

---

## 7. 已知空白

这些是有记录的局限，而非能盲目“修复”的 bug——其中若干需要上游或 harness 层面的改动，超出本包范围。

1. **Kimi thinking signature 侧表。** Kimi 的 thinking 重放不需要 Anthropic 的 `signature` 字段即可工作，但并没有一个跨多轮对话对账 thinking block 的侧表。重度使用工具的长 Kimi 对话仍可能在某些序列中丢失 reasoning。
2. **Grok reasoning 重放形状。** Grok 以 `reasoning.summary` item 发出 reasoning；代理拒绝重放的 reasoning，因此过往的 Grok reasoning 被丢弃。在当前 Responses 形状下，除非代理侧改动，否则无法无损地把它回声回去。
3. **MiniMax 需要 API key。** 只有 mini-agent 配置里存在 `api_key`（`sk-...`）时，`minimax-kernel` 才会注册。无 key → 无路由，`kernel_switch('minimax')` 要到解析时才会报告 unknown/unavailable provider。
4. **`loop_control` 没有 DSH 旋钮。** Kimi 的 `loop_control`（`max_attempts_per_step` 等）在 DSH 的 agent loop 中没有对应物，后者只暴露 `maxParallelToolCalls`。这是文档层面的对齐；在 harness 暴露该旋钮之前，行级对齐不可能实现。
5. ~~**Kimi `Agent` 的 resume-by-`agent_id` / `run_in_background`。**~~ **已解决。** `kernel_run` 现在是以后台优先、走原生可续接路由（`subagents.startContinuable`）：返回持久子代理 id，`list_agents` / `send_message` / `interrupt_agent` 均可操作，与原生的 `subagent` 工具完全一致。见 §3.2。
6. ~~**非流式传输。**~~ **已解决。** 两个适配器工厂现在都是真正的流式：`httpStream` 以 `stream: true` 发请求并给 curl 加 `-N`（关闭缓冲——否则管道中的 curl 按 16 KiB 块缓冲，TTFT 就没了），增量解析 SSE 记录（跨块行缓冲，忽略 `ping`/注释行，为 OpenAI 兼容 wire 处理 `[DONE]` 哨兵），并随到随映射为 §3.3 的块事件。若 provider 无视 `stream: true` 返回单个 JSON 体，传输层会侦测到（无 SSE 记录且响应体以 `{` 开头），适配器随即回退到逐字保留的非流式翻译路径——wire 回归套件断言了该路径与旧实现逐事件相等。仍然**刻意不设 curl `-m` 墙钟上限**：取消由 AbortSignal 端到端驱动。
7. **Responses 线跳过图片。** Anthropic 线工厂（kimi、minimax）通过持久化 attachments 服务（`attachments.readImage`，与原生 pi-ai 适配器的 `config.resolveAttachments` 同一通道）解析 DSH `image` 块，并发出标准的 Anthropic base64 `image` 块；读不到的附件直接省略。Responses 线工厂（grok、codex）省略 image 块——grok CLI 代理对 `input_image` 的支持尚未验证。

---

## 8. 曾使用的测试流程

网络核心通过三种互补方式验证。每当 wire 代码改动时都应重跑。

1. **无头 CLI 冒烟测试。** 在宿主侧的 DSH 会话里调用 `kernel_status`，确认所有预期内核（凡有凭据者）以及全部 9 个 L2 配方 provider 都被列出。
2. **工具循环测试。** 用琐碎任务（例如“列出工作区里的文件”）驱动 `kernel_run` 遍历每个内核/类型组合。默认的后台路由必须返回 `{ kind: 'continuable', ok: true, subagentId }`，且子代理必须出现在 `list_agents` 中、以运行时通知结算、并接受 `send_message` 续聊；`run_in_background: false` 必须返回 `{ kind: 'foreground', ok: true }` 且 `output` 非空，从而在每条 wire 上锻炼「工具调用 → 工具结果」的往返。
3. **与真实 Kimi CLI 的差分测试——17 颜色任务。** 在真实 `kimi` CLI 与 `kimi-kernel` + 纯 kimi 工具面上运行*同一个*任务（“统计 CSS 颜色值”），再逐项比较结果。验收标准：两者都报出 17 种颜色（11 个 `#hex` + 6 个 `rgba`），首卡标题为 `KIMI`，工具面名称与 schema 完全一致。另用独立 subagent 以正则复核颜色计数（`#[0-9a-fA-F]{3,8}` ×11、`rgba?\(` ×6）。这是真正的“同化”门——在相同输入上，DSH kimi-kernel 路径必须与原生 CLI 无法区分。

---

## 9. 逐步添加一个新内核

1. **蒸馏 wire。** 阅读目标 harness 的源码，确定它的 wire（Anthropic Messages 还是 Responses 还是其他）、端点，以及每一个必需 header。把它们记录成一个注释块，仿照 `lib/index.js` 顶部的头注释。
2. **选择或扩展工厂。** Anthropic-wire 目标复用 `makeAnthropicAdapter(opts)`；Responses-wire 目标复用 `makeResponsesAdapter(opts)`。若都不是这两种 wire，则新增一个工厂，使其严格发出 §3.3 中描述的 block 事件契约。
3. **在 `loadCredentials()` 里添加凭据加载**，针对新配置位置，并在 `apply()` 里添加模型目录条目。
4. **在 `apply()` 里注册适配器**，以凭据存在与否为守卫，带上 `tag`、`name`、`url`、`headers`、`models`，以及（responses-wire 下）`efforts` / `defaultEffort` / `mapEffort`。
5. **向 `RECIPES` 添加 L2 配方**（persona 蒸馏自该 harness 自身的子代理提示词，附带合适的 `toolFilter`），并扩展 `kernel_run` 里的 `TYPE_MAP`。
6. **扩展 `kernel_switch` 的映射**，加入新路由，并保留 `deepseek` 回退到 `deepseek-official/deepseek-v4-pro`。
7. **更新 `kernel_status` 的过滤列表**，纳入新的 provider id。
8. **按 §8 测试**，并把所有新的 wire 怪癖记录到 §4、新的空白记录到 §7。

除非行 id/name 必须变更，否则不要动 `cordis.patch.yml`——它只负责挂载 `lib/index.js`；所有逻辑都在 JS 里。
