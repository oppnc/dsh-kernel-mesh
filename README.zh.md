[English](README.md) | 中文

# dsh-kernel-mesh

DSH 有个很朴素的想法：**一切都是插件**。模型是插件，工具是插件，子代理也是插件，想怎么拼就怎么拼。

顺着这个思路，我们把四家 coding harness 的内核——**Kimi Code**、**Grok Build**、**OpenAI Codex**、**MiniMax Mini-Agent**——统统写成了 DSH 插件，打包在这一个包里。

好处很简单：在 DSH 里直接切到 Kimi / Grok / Codex / MiniMax 的模型，和直接打开它们各自的 CLI **没有任何区别**。每个模型都待在自己最熟悉的环境里，不管是主 agent 还是 subagent，感觉就像回家一样。

## 里面有什么

- **L1 内核路由**：`kimi-kernel` / `grok-kernel` / `codex-kernel` / `minimax-kernel`，注册成 DSH 的模型路由，主 agent 可以直接切过去跑。
- **L2 子代理配方**：`kimi-agent` / `kimi-explore` / `kimi-plan`、`grok-agent` / `grok-explore` / `grok-plan`、`codex-agent` / `codex-explore` / `codex-worker`（各家自己的子代理类型；minimax 上游没有子代理工具，故不提供）。每个配方都带该厂商自己的子代理 prompt 和工具白名单，所以内核子代理看到和使用的，与那家 harness 的子代理完全一致——与父 preset 无关。
- **三个内核工具**：`kernel_status`、`kernel_run`、`kernel_switch`。
- **四个 agent 预设**：`codex-kernel`、`grok-kernel`、`kimi-kernel`、`minimax-kernel` 随本包的 `presets/` 目录分发。把它们复制到官方用户预设根目录（`~/.dsh/.agent-presets/`）后即出现在预设选择器里（官方 DSH CLI 拥有自带预设根目录，bundle 无法注册额外根目录）。
- **厂商搜索工具，只在用户选择接入时出现**：`kimi_search` / `kimi_fetch` 仅在已安装 `dsh-kernel-kimi` **并且**存在 Moonshot 凭证时注册；`grok_search` / `grok_fetch` 仅在已安装 `dsh-kernel-grok` **并且**存在 Grok OAuth 凭证时注册。它们是并列工具（语料不同），不是一个后端。官方 `web_search` 仍是 DeepSeek 自己的搜索，不是包装器。

## 内核矩阵

| Kernel | Wire | Endpoint |
| --- | --- | --- |
| `kimi-kernel` | Anthropic Messages | `https://api.kimi.com/coding/v1/messages`（对齐 kimi-cli **1.49.0**：`max_tokens` 按剩余上下文夹紧；目录含 `k3`） |
| `grok-kernel` | Responses（经代理） | `https://cli-chat-proxy.grok.com/v1/responses` |
| `codex-kernel` | Responses（自定义） | 你的 codex `base_url` + `/responses` |
| `minimax-kernel` | Anthropic Messages（国内直连） | `https://api.minimaxi.com/anthropic/v1/messages` |

### 系统提示词

每个内核插件都会把该厂商的上游 system prompt（工具名与运行时占位符已适配 DSH 工具面）注册为 agent 唯一的
system-prompt 段（`complete: true` + `suppressRuntimeContext()`），所以跑在某个
内核上的会话只会看到那家 harness 的提示词，而不是 DSH 的。

### 回退路由（可选）

各家厂商本身没有回退机制，因此默认每个内核都走自己的官方 API。当某个内核
自己的 API 额度耗尽时，设置 `DSH_KERNEL_USE_FALLBACK=1` 即可把内核路由到你
已有的订阅：

| Kernel | 回退路由 | 模型 |
| --- | --- | --- |
| `kimi-kernel` | ollama | `kimi-k2.7-code` |
| `grok-kernel` | ollama | `gpt-oss:120b` |
| `codex-kernel` | opencode-go | `gpt-5.6-luna` |
| `minimax-kernel` | ollama | `minimax-m3` |

密钥从 `~/.dsh/.credentials.yaml` 读取（`OLLAMA_API_KEY`、
`MY_OPENCODE_GO_API_KEY`）。不设置（或设为 `0`）`DSH_KERNEL_USE_FALLBACK` 即走
官方内核 API。

## 安装

用官方插件命令把 bundle 装进你的 profile：

```sh
dsh plugin --profile web add github:oppnc/dsh-kernel-mesh
```

`dsh plugin` 会转发给 pnpm，并自动 reconcile `dsh.profile.bundles`——本包声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，因此会加入 profile 的配置层栈。装完后重启 profile：

```sh
dsh web
```

再安装预设所引用的内核 surface 插件（每个都是普通插件，作为不激活依赖安装，由预设行按名字解析）：

```sh
dsh plugin --profile web add github:oppnc/dsh-kernel-kimi github:oppnc/dsh-kernel-grok github:oppnc/dsh-kernel-codex github:oppnc/dsh-kernel-minimax
```

安装四个内核 agent 预设：从已安装的 mesh 包里复制到官方用户预设根目录：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
cp -r "$dsh_home/profiles/web/node_modules/dsh-kernel-mesh/presets/." "$dsh_home/.agent-presets/"
```

然后新建会话，在 Web UI 里选择 `codex-kernel`、`grok-kernel`、`kimi-kernel` 或 `minimax-kernel` 预设。

## 使用

```sh
kernel_status                          # 看看注册了哪些内核、L2 类型、传输方式
kernel_run(kernel, type, task)         # 把一个任务分发到外来内核
kernel_switch('kimi')                  # 为后续会话设置默认模型路由
```

| Kernel | `type` 取值 |
| --- | --- |
| `kimi` | `coder`、`explore`、`plan` |
| `grok` | `general`、`explore`、`plan` |
| `codex` | `explore`、`worker` |
| `minimax` | （无——上游没有子代理工具） |

## 截图

整个家族在 GitHub 上的样子——每个 README 都带一键语言切换：

<table>
  <tr>
    <td><img src="docs/screenshots/01-mesh-readme-en.png" alt="dsh-kernel-mesh README（英文）" width="410"></td>
    <td><img src="docs/screenshots/02-mesh-readme-zh.png" alt="dsh-kernel-mesh README（中文）" width="410"></td>
    <td><img src="docs/screenshots/03-kimi-readme.png" alt="dsh-kernel-kimi README" width="410"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/04-grok-readme.png" alt="dsh-kernel-grok README" width="410"></td>
    <td><img src="docs/screenshots/05-codex-readme.png" alt="dsh-kernel-codex README" width="410"></td>
    <td><img src="docs/screenshots/06-minimax-readme.png" alt="dsh-kernel-minimax README" width="410"></td>
  </tr>
</table>

原图在 [`docs/screenshots/`](docs/screenshots/)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
