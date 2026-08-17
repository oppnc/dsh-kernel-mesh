// dsh-kernel-mesh — host-plane Cordis plugin for DeepSeek Harness.
//
// Registers foreign-harness kernels as DSH model routes (L1) plus distilled
// subagent providers (L2), so any session/preset can run agents on the
// kimi / grok / codex / minimax kernels natively.
//
// Wire protocols distilled from upstream sources (see harness-kernels/README.md):
//  - kimi:     https://api.kimi.com/coding/v1/messages        (Anthropic wire)
//  - grok:     https://cli-chat-proxy.grok.com/v1/responses   (Responses wire, proxy)
//  - codex:    user codex config.toml base_url + /responses   (Responses wire)
//  - minimax:  https://api.minimaxi.com/anthropic/v1/messages (Anthropic wire, CN direct)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { grokFetchNative, grokSearchNative, kimiFetchNative, kimiSearchNative, loadGrokKey, loadKimiBearer } from './search-backends.js'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()

// Credential roots. When DSH runs inside WSL but the CLIs live on the Windows
// side, their login state sits under /mnt/c/Users/<user> — probe those homes
// too so the Windows login is reused without manual symlinks. Non-WSL hosts
// just get [HOME]. Symlinks are followed (statSync), so a user who already
// symlinked ~/.grok etc. is unaffected.
function credentialRoots() {
  const roots = [HOME]
  if (process.platform !== 'linux') return roots
  let wsl = !!process.env.WSL_DISTRO_NAME
  if (!wsl) { try { wsl = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')) } catch {} }
  if (!wsl) return roots
  try {
    for (const ent of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (/^(Public|Default|Default User|All Users)$/i.test(ent.name)) continue
      const p = path.join('/mnt/c/Users', ent.name)
      if (p !== HOME) roots.push(p)
    }
  } catch {}
  return roots
}
const CRED_ROOTS = credentialRoots()

// Newest existing candidate wins: when one side re-logs (rotating tokens),
// its file is younger and the fresh credential is the one we want.
function newestExistingIn(roots, rel) {
  let best = null, bestM = -1
  for (const root of roots) {
    const p = path.join(root, rel)
    try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { bestM = m; best = p } } catch {}
  }
  return best
}
function credPath(rel) { return newestExistingIn(CRED_ROOTS, rel) }
const PROXY = 'http://127.0.0.1:7897'
const UA = 'deepseek-harness/kernel-mesh (+https://github.com/deepseek-ai/deepseek-harness)'
// The live shell tool name in the host composition: dsh-tool-pwsh only mounts on
// Windows; dsh-tool-bash (tool name "bash") mounts elsewhere. tools.restrict()
// rejects unknown global names, so recipe allow-lists must carry exactly this.
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

function readText(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim()
}

// Canonical DSH failure taxonomy for foreign adapters. dsh-llm's
// adapter-failure normalization reads an error's OWN data properties `code`
// and `failure` ({ message, code, status? }), so adapters outside the runtime
// module instance can carry a machine-routable code WITHOUT importing
// HarnessError. dsh-llm-retry's default normal policy retries EMPTY_RESPONSE,
// RATE_LIMIT, SERVER, TIMEOUT and TRANSPORT (2 attempts, bounded backoff);
// anything else (AUTH, INVALID_REQUEST, PROTOCOL, UNKNOWN) fails the turn
// once. A bare Error classifies as UNKNOWN and is never retried — that was
// the pre-fix behavior, which let a transient 429 kill a turn outright.
function llmFail(message, code, status) {
  const e = new Error(message)
  e.code = code
  e.failure = { message, code, ...(status ? { status } : {}) }
  return e
}

// Map Anthropic/Responses wire error types onto the canonical codes.
function wireErrorCode(type) {
  switch (type) {
    case 'rate_limit_error': case 'rate_limit_exceeded': return 'RATE_LIMIT'
    case 'overloaded_error': return 'RATE_LIMIT'   // transient throttle (529)
    case 'insufficient_quota': return 'QUOTA'      // canonical QUOTA_EXCEEDED code
    case 'api_error': case 'server_error': return 'SERVER'
    case 'authentication_error': case 'permission_error': return 'AUTH'
    case 'request_too_large': return 'CONTEXT_WINDOW_EXCEEDED'
    case 'invalid_request_error': case 'not_found_error': return 'INVALID_REQUEST'
    default: return undefined
  }
}
function providerError(tag, errObj) {
  const detail = (JSON.stringify(errObj === undefined ? {} : errObj) || '{}').slice(0, 500)
  // Prefer the wire `code` discriminant over `type`: OpenAI-compat errors are
  // often { type:'invalid_request_error', code:'rate_limit_exceeded' } and a
  // type-first lookup would misclassify a retryable 429 as INVALID_REQUEST.
  const code = (errObj && (wireErrorCode(errObj.code) || wireErrorCode(errObj.type))) || 'UNKNOWN'
  return llmFail(tag + ' error: ' + detail, code)
}

// Unwrap a Responses-wire terminal event to its inner error object:
// { error } on `error` events, { response: { error } } on `response.failed`.
function extractWireError(data) {
  if (!data || typeof data !== 'object') return data
  if (data.error) return data.error
  if (data.response && data.response.error) return data.response.error
  return data
}

// ---------- kimi OAuth (auth.kimi.com device-flow refresh; token file shared with kimi-cli) ----------
const KIMI_OAUTH_HOST = 'https://auth.kimi.com'
const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const KIMI_CRED_FILE = credPath('.kimi-code/credentials/kimi-code.json') || path.join(HOME, '.kimi-code', 'credentials', 'kimi-code.json')
const KIMI_CRED_DIR = path.dirname(KIMI_CRED_FILE)
const KIMI_DEVICE_ID_FILE = path.join(HOME, '.kimi-code', 'device_id')

function kimiDeviceId() {
  const raw = readText(KIMI_DEVICE_ID_FILE).trim()
  return raw || 'dsh-kernel-mesh'
}

function kimiOAuthHeaders() {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': '0.1.0',
    'X-Msh-Device-Name': 'dsh-kernel-mesh',
    'X-Msh-Device-Model': process.platform === 'win32' ? 'Windows' : 'Linux',
    'X-Msh-Os-Version': 'unknown',
    'X-Msh-Device-Id': kimiDeviceId(),
  }
}

function loadKimiOAuthToken() {
  try {
    const t = JSON.parse(readText(KIMI_CRED_FILE))
    if (t && typeof t.access_token === 'string' && typeof t.refresh_token === 'string' && t.access_token) return t
  } catch {}
  return null
}

function saveKimiOAuthToken(t) {
  try {
    fs.mkdirSync(KIMI_CRED_DIR, { recursive: true })
    fs.writeFileSync(KIMI_CRED_FILE, JSON.stringify(t), { mode: 0o600 })
  } catch {}
}

function refreshKimiOAuth(refreshToken) {
  const headers = kimiOAuthHeaders()
  const argv = [process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl', '-sS', '-m', '60', '-X', 'POST']
  for (const key of Object.keys(headers)) argv.push('-H', key + ': ' + headers[key])
  argv.push('--data-urlencode', 'client_id=' + KIMI_CODE_CLIENT_ID)
  argv.push('--data-urlencode', 'grant_type=refresh_token')
  argv.push('--data-urlencode', 'refresh_token=' + refreshToken)
  argv.push(KIMI_OAUTH_HOST + '/api/oauth/token')
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    const outChunks = []
    const errChunks = []
    child.stdout.on('data', (c) => { outChunks.push(c) })
    child.stderr.on('data', (c) => { errChunks.push(c) })
    child.on('error', (e) => reject(new Error('kimi oauth refresh spawn failed: ' + String(e))))
    child.on('close', (code) => {
      const out = Buffer.concat(outChunks).toString('utf8')
      const err = Buffer.concat(errChunks).toString('utf8')
      if (code !== 0) reject(new Error('kimi oauth refresh failed (exit ' + code + '): ' + err.slice(0, 300)))
      else {
        try {
          const data = JSON.parse(out)
          if (data && typeof data.access_token === 'string' && data.access_token) {
            resolve({
              access_token: data.access_token,
              refresh_token: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : refreshToken,
              expires_at: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 900),
              scope: data.scope || 'kimi-code',
              token_type: data.token_type || 'Bearer',
              expires_in: Number(data.expires_in) || 900,
            })
          } else reject(new Error('kimi oauth refresh: bad response ' + out.slice(0, 200)))
        } catch (e) { reject(new Error('kimi oauth refresh: bad JSON ' + out.slice(0, 200))) }
      }
    })
    child.stdin.end()
  })
}

// Fresh kimi OAuth access token, refreshing in-process when near expiry. Falls
// back to the possibly-stale token on refresh failure (never throws), so a
// transient auth.kimi.com outage degrades to one failed request rather than
// killing the adapter.
async function freshKimiKey() {
  const t = loadKimiOAuthToken()
  if (!t) return ''
  const now = Math.floor(Date.now() / 1000)
  if (!t.expires_at || t.expires_at - now > 60) return t.access_token
  try {
    const nt = await refreshKimiOAuth(t.refresh_token)
    saveKimiOAuthToken(nt)
    return nt.access_token
  } catch {}
  return t.access_token
}

// Per-kernel "last selected" model + reasoning effort, persisted so the model
// faces a stable default across restarts (mirrors how humans pick model+effort
// and get that same choice back next time).
const SELECTION_FILE = path.join(process.env.DSH_HOME || HOME, 'storages', 'kernel-mesh-selection.json')
function loadSelections() {
  try { return JSON.parse(readText(SELECTION_FILE)) || {} } catch { return {} }
}
function saveSelections(sel) {
  try {
    fs.mkdirSync(path.dirname(SELECTION_FILE), { recursive: true })
    fs.writeFileSync(SELECTION_FILE, JSON.stringify(sel))
  } catch {}
}

// ---------- HTTP (curl-based, incremental SSE with JSON auto-fallback) ----------
// Windows ships curl in System32; resolve it explicitly so we never pick up a
// userland namesake from PATH.
function curlBin() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
    : 'curl'
}

function createSseMachine() {
  return {
    pending: '',
    event: '',
    dataLines: [],
    sawDataRecord: false,
    done: false,
    dispatched: 0,
  }
}

function sseDispatchRecord(machine, onEvent) {
  const eventName = machine.event
  const dataRaw = machine.dataLines.join('\n')
  machine.event = ''
  machine.dataLines = []
  if (eventName === '' && dataRaw === '') return
  if (dataRaw === '[DONE]') {
    machine.done = true
    machine.sawDataRecord = true
    return
  }
  if (dataRaw === '') return
  machine.sawDataRecord = true
  let parsed
  try { parsed = JSON.parse(dataRaw) } catch {
    // Malformed SSE data: skip the record (stream continues).
    return
  }
  const name = eventName || (parsed && typeof parsed === 'object' && parsed.type) || 'message'
  machine.dispatched += 1
  if (typeof onEvent === 'function') onEvent(name, parsed)
}

function ssePush(machine, chunk, onEvent) {
  if (machine.done || !chunk) return
  machine.pending += chunk
  let nl
  while (!machine.done && (nl = machine.pending.indexOf('\n')) !== -1) {
    let line = machine.pending.slice(0, nl)
    machine.pending = machine.pending.slice(nl + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '') {
      sseDispatchRecord(machine, onEvent)
      continue
    }
    if (line.charCodeAt(0) === 58 /* : */) continue
    const colon = line.indexOf(':')
    let field, value
    if (colon === -1) {
      field = line
      value = ''
    } else {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
    }
    if (field === 'event') machine.event = value
    else if (field === 'data') machine.dataLines.push(value)
  }
}

function sseFlush(machine, onEvent) {
  if (machine.done) return
  if (machine.pending) {
    let line = machine.pending
    machine.pending = ''
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line && line.charCodeAt(0) !== 58) {
      const colon = line.indexOf(':')
      let field, value
      if (colon === -1) {
        field = line
        value = ''
      } else {
        field = line.slice(0, colon)
        value = line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
      }
      if (field === 'event') machine.event = value
      else if (field === 'data') machine.dataLines.push(value)
    }
  }
  sseDispatchRecord(machine, onEvent)
}

// ---------- HTTP (curl-based, incremental SSE with JSON fallback) ----------
async function httpStream(url, headers, body, proxy, signal, onEvent) {
  if (signal && signal.aborted) {
    const e = llmFail(signal.reason ? String(signal.reason) : 'kernel transport aborted', 'ABORTED')
    e.name = 'AbortError'
    throw e
  }
  // Same flags as httpPost, plus -N so stdout is not 16 KiB-buffered when
  // piped (otherwise incremental SSE never leaves curl until the response
  // completes).
  const argv = [curlBin(), '-sS', '-N']
  if (proxy) argv.push('-x', proxy)
  for (const key of Object.keys(headers || {})) argv.push('-H', key + ': ' + headers[key])
  argv.push('--data-binary', '@-', url)

  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    const outChunks = []
    const errChunks = []
    const decoder = new StringDecoder('utf8')
    const machine = createSseMachine()
    let aborted = false
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const ok = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const onAbort = () => { aborted = true; try { child.kill() } catch {} }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (c) => {
      outChunks.push(c)
      if (machine.done) return
      try { ssePush(machine, decoder.write(c), onEvent) } catch (e) { fail(e) }
    })
    child.stderr.on('data', (c) => { errChunks.push(c) })
    child.stdin.on('error', () => {})

    child.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      fail(llmFail('spawn failed: ' + String(e), 'TRANSPORT'))
    })

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (settled) return
      const tail = decoder.end()
      if (tail && !machine.done) {
        try { ssePush(machine, tail, onEvent) } catch (e) { fail(e); return }
      }
      if (!machine.done) {
        try { sseFlush(machine, onEvent) } catch (e) { fail(e); return }
      }
      const out = Buffer.concat(outChunks).toString('utf8')
      const err = Buffer.concat(errChunks).toString('utf8')
      if (aborted) {
        const reason = signal && signal.reason ? String(signal.reason) : 'kernel transport aborted'
        const e = llmFail(reason, 'ABORTED')
        e.name = 'AbortError'
        fail(e)
        return
      }
      if (code !== 0) {
        fail(llmFail('transport failed (exit ' + code + '): ' + err.slice(0, 600) + ' | ' + out.slice(0, 300), 'TRANSPORT'))
        return
      }
      if (machine.sawDataRecord) {
        ok({ streamed: true })
        return
      }
      const trimmed = out.replace(/^\uFEFF/, '').trim()
      if (!trimmed) {
        fail(llmFail('bad JSON from provider: ' + out.slice(0, 300), 'SERVER'))
        return
      }
      if (trimmed.charAt(0) !== '{') {
        fail(llmFail('bad JSON from provider: ' + out.slice(0, 300), 'SERVER'))
        return
      }
      try { ok({ streamed: false, json: JSON.parse(out) }) } catch {
        try { ok({ streamed: false, json: JSON.parse(trimmed) }) } catch {
          fail(llmFail('bad JSON from provider: ' + out.slice(0, 300), 'SERVER'))
        }
      }
    })

    child.stdin.write(body)
    child.stdin.end()
  })
}

function createEventQueue() {
  const items = []
  let wake = null
  let done = false
  let err = null
  let result = undefined
  const kick = () => {
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  }
  return {
    push(item) {
      items.push(item)
      kick()
    },
    finish(r) {
      result = r
      done = true
      kick()
    },
    fail(e) {
      err = e
      done = true
      kick()
    },
    async next() {
      while (items.length === 0 && !done) {
        await new Promise((r) => { wake = r })
      }
      if (items.length > 0) return { done: false, value: items.shift() }
      if (err) throw err
      return { done: true, value: result }
    },
  }
}

// ---------- anthropic-wire adapter factory (kimi / minimax) ----------
// Resolve one DSH image block into an Anthropic base64 image block.
// Missing attachments / unread bytes skip the block (no placeholder text).
async function anthropicImageBlock(b, opts) {
  const att = opts.attachments
  if (att && typeof att.readImage === 'function' && b.attachment !== undefined) {
    try {
      const stored = await att.readImage(b.attachment)
      if (stored && stored.data) {
        return { type: 'image', source: { type: 'base64', media_type: (stored.ref && stored.ref.mediaType) || 'image/png', data: Buffer.from(stored.data).toString('base64') } }
      }
    } catch {}
  }
  return null
}
function usageFromAnthropic(usage) {
  const uIn = usage || {}
  const cachedRead = uIn.cache_read_input_tokens || 0
  const u = { inputTokens: uIn.input_tokens || 0, outputTokens: uIn.output_tokens || 0 }
  if (cachedRead > 0) u.cacheReadTokens = cachedRead
  if (uIn.cache_creation_input_tokens) u.cacheWriteTokens = uIn.cache_creation_input_tokens
  return u
}

function finishFromState(stopReason, toolCalls, emittedBlocks) {
  if (stopReason === 'max_tokens') return { type: 'finish', reason: { kind: 'max-tokens' } }
  if (toolCalls) return { type: 'finish', reason: { kind: 'tool-calls' } }
  if (emittedBlocks === 0) {
    return { type: 'finish', reason: { kind: 'error', failure: { message: 'provider returned an empty response', code: 'EMPTY_RESPONSE' } } }
  }
  return { type: 'finish', reason: { kind: 'stop' } }
}

// kimi-cli 1.49.0: clamp the completion budget to remaining context so a
// long turn no longer sends a fixed max_tokens that overflows the window.
// Mirrors kimi_cli.llm.compute_max_completion_tokens + estimate_request_tokens
// (ascii/4 + 1-per-non-ascii, plus a 1024-token safety margin).
const KIMI_UNKNOWN_CONTEXT_COMPLETION_TOKENS = 32000
const KIMI_COMPLETION_TOKEN_SAFETY_MARGIN = 1024

function estimateTextTokens(text) {
  const s = String(text || '')
  let ascii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii += 1
  return Math.floor((ascii + 3) / 4) + (s.length - ascii)
}

function estimateRequestTokens(options) {
  let n = estimateTextTokens(options && options.system)
  for (const t of (options && options.tools) || []) {
    n += estimateTextTokens(t && t.name)
    n += estimateTextTokens(t && t.description)
    try { n += estimateTextTokens(JSON.stringify((t && t.parameters) || {})) } catch { n += 32 }
  }
  for (const m of (options && options.messages) || []) {
    n += 4
    const blocks = (m && m.content) || []
    if (typeof blocks === 'string') { n += estimateTextTokens(blocks); continue }
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'text' || b.type === 'reasoning') n += estimateTextTokens(b.text)
      else if (b.type === 'tool-call') n += estimateTextTokens(b.name) + estimateTextTokens(b.arguments)
      else if (b.type === 'tool-result') n += estimateTextTokens(textOf(b.content))
      else if (b.type === 'image') n += 1024
    }
  }
  return n
}

// Env contract from kimi-cli 1.49.0:
//   KIMI_MODEL_MAX_COMPLETION_TOKENS (alias KIMI_MODEL_MAX_TOKENS)
//   positive = hard cap; 0 / negative / "off" = disable clamping.
function kimiCompletionBudgetFromEnv(env) {
  const src = env || process.env
  const raw = src.KIMI_MODEL_MAX_COMPLETION_TOKENS != null && src.KIMI_MODEL_MAX_COMPLETION_TOKENS !== ''
    ? src.KIMI_MODEL_MAX_COMPLETION_TOKENS
    : src.KIMI_MODEL_MAX_TOKENS
  if (raw == null || raw === '') return { mode: 'auto' }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return { mode: 'off' }
  return { mode: 'cap', value: Math.floor(n) }
}

function clampKimiMaxTokens(options, contextWindow, requested, env) {
  const budget = kimiCompletionBudgetFromEnv(env)
  const fallback = requested || KIMI_UNKNOWN_CONTEXT_COMPLETION_TOKENS
  if (budget.mode === 'off') return Math.max(1, fallback)
  const hard = budget.mode === 'cap' ? budget.value : fallback
  if (!contextWindow || contextWindow <= 0) return Math.max(1, hard)
  const input = estimateRequestTokens(options) + KIMI_COMPLETION_TOKEN_SAFETY_MARGIN
  const remaining = Math.max(1, contextWindow - Math.max(0, input))
  return Math.max(1, Math.min(hard, remaining))
}

// Verbatim translation of a complete (non-streaming) Anthropic Messages
// JSON body — identical event sequence to makeAnthropicAdapter.
function* emitNonStreamingResponse(resp, tag) {
  if (resp && resp.type === 'error') throw providerError(tag, resp.error)
  if (resp && resp.error && typeof resp.error === 'object') throw providerError(tag, resp.error)
  const content = Array.isArray(resp.content) ? resp.content : []
  let index = 0
  let toolCalls = false
  let emittedBlocks = 0
  for (const b of content) {
    if (b.type === 'thinking') {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: b.thinking || '' }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: b.thinking || '' } }
      index += 1
      emittedBlocks += 1
    } else if (b.type === 'text') {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: b.text || '' }
      yield { type: 'block-end', index, block: { type: 'text', text: b.text || '' } }
      index += 1
      emittedBlocks += 1
    } else if (b.type === 'tool_use') {
      toolCalls = true
      const args = JSON.stringify(b.input || {})
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: b.id, name: b.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: b.id, name: b.name, arguments: args } }
      index += 1
      emittedBlocks += 1
    }
  }
  const usage = resp.usage || {}
  yield { type: 'usage', usage: usageFromAnthropic(usage) }
  if (resp.stop_reason === 'max_tokens') yield { type: 'finish', reason: { kind: 'max-tokens' } }
  else if (toolCalls) yield { type: 'finish', reason: { kind: 'tool-calls' } }
  else if (emittedBlocks === 0) yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider returned an empty response', code: 'EMPTY_RESPONSE' } } }
  else yield { type: 'finish', reason: { kind: 'stop' } }
}

function makeAnthropicAdapter(opts) {
  return {
    providerInfo(provider) { return { id: provider, name: opts.name } },
    providerRetryPolicy() { return undefined },
    listModels(provider) { return Promise.resolve(opts.models.map((m) => ({ provider, id: m.id, name: m.name }))) },
    resolveModel(provider, model) {
      const found = opts.models.find((m) => m.id === model)
      const resolved = found
        ? { provider, id: found.id, name: found.name, context: { contextWindow: found.contextWindow }, defaultMaxTokens: found.defaultMaxTokens }
        : { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 32768 }
      if (opts.efforts) resolved.reasoning = { efforts: opts.efforts, defaultEffort: opts.defaultEffort }
      return Promise.resolve(resolved)
    },
    async *stream(options) {
      const messages = []
      for (const m of options.messages || []) {
        if (m.role === 'system') continue
        const isAssistant = m.role === 'assistant'
        const blocks = []
        for (const b of m.content || []) {
          if (!b) continue
          if (b.type === 'text') blocks.push({ type: 'text', text: b.text })
          else if (b.type === 'reasoning') {
            // Assistant-only: Anthropic forbids thinking blocks in user
            // messages. A subagent settlement notice embeds the child's
            // final assistant message (reasoning + tool-call blocks) as a
            // USER message in the parent — the native adapters silently
            // drop non-text blocks there; doing the same keeps notice turns
            // sendable (fixes an observed kimi "tokenization failed").
            if (isAssistant && opts.replayThinking) blocks.push({ type: 'thinking', thinking: b.text })
          }
          else if (b.type === 'tool-call') {
            // Assistant-only: tool_use in a user message is invalid (its
            // tool_result pairing would break too). Dropped like native.
            if (!isAssistant) continue
            let input = {}
            try { input = JSON.parse(b.arguments || '{}') } catch {}
            blocks.push({ type: 'tool_use', id: b.id, name: b.name, input })
          } else if (b.type === 'tool-result') {
            const rb = { type: 'tool_result', tool_use_id: b.toolCallId, content: textOf(b.content) }
            if (b.isError) rb.is_error = true
            blocks.push(rb)
          } else if (b.type === 'image') {
            const img = await anthropicImageBlock(b, opts)
            if (img) blocks.push(img)
          }
        }
        if (blocks.length === 0) continue
        // Anthropic Messages requires strictly alternating roles and every
        // tool_result of one assistant step inside a SINGLE following user
        // message; DSH emits one message per tool result, so merge same-role
        // consecutive turns into the previous wire message.
        const last = messages[messages.length - 1]
        if (last && last.role === m.role) last.content.push(...blocks)
        else messages.push({ role: m.role, content: blocks })
      }
      const catalog = (opts.models || []).find((m) => m.id === options.model)
      const requested = options.maxTokens || (catalog && catalog.defaultMaxTokens) || 32768
      const maxTokens = opts.clampToRemainingContext
        ? clampKimiMaxTokens(options, catalog && catalog.contextWindow, requested)
        : requested
      const body = { model: options.model, max_tokens: maxTokens, stream: true, messages }
      let thinking = opts.thinkingFor ? opts.thinkingFor(options.model, options.reasoningEffort) : { type: 'enabled', budget_tokens: 16384 }
      if (thinking && (options.purpose === 'session-title')) thinking = null
      if (thinking && thinking.type === 'enabled' && thinking.budget_tokens) {
        // Anthropic requires budget_tokens < max_tokens. Very small budgets
        // (e.g. 64-token session-title calls) cannot host thinking at all.
        const cap = body.max_tokens - 1
        if (cap < 1024) thinking = null
        else thinking.budget_tokens = Math.min(thinking.budget_tokens, cap)
      }
      if (thinking) body.thinking = thinking
      if (options.system) body.system = options.system
      if (Array.isArray(options.tools) && options.tools.length > 0) {
        body.tools = options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters || { type: 'object' } }))
      }
      const headers = typeof opts.headers === 'function' ? await opts.headers() : opts.headers

      const q = createEventQueue()
      const pending = httpStream(opts.url, headers, JSON.stringify(body), opts.proxy || null, options.signal, (name, data) => {
        q.push({ name, data })
      })
      pending.then((r) => q.finish(r), (e) => q.fail(e))

      const blocks = Object.create(null)
      const usageAcc = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      let stopReason = null
      let toolCalls = false
      let emittedBlocks = 0
      let closed = false

      const closeBlock = (index) => {
        const st = blocks[index]
        if (!st || st.ended) return null
        st.ended = true
        if (st.kind === 'thinking') return { type: 'block-end', index, block: { type: 'reasoning', text: st.text || '' } }
        if (st.kind === 'tool_use') return { type: 'block-end', index, block: { type: 'tool-call', id: st.id, name: st.name, arguments: st.args || (st.startInput ? JSON.stringify(st.startInput) : '{}') } }
        return { type: 'block-end', index, block: { type: 'text', text: st.text || '' } }
      }

      const finalize = function* () {
        if (closed) return
        closed = true
        const open = Object.keys(blocks).map(Number).sort((a, b) => a - b)
        for (const index of open) {
          const ev = closeBlock(index)
          if (ev) yield ev
        }
        yield { type: 'usage', usage: usageFromAnthropic(usageAcc) }
        yield finishFromState(stopReason, toolCalls, emittedBlocks)
      }

      const mergeUsage = (src) => {
        if (!src || typeof src !== 'object') return
        if (src.input_tokens != null) usageAcc.input_tokens = src.input_tokens
        if (src.output_tokens != null) usageAcc.output_tokens = src.output_tokens
        if (src.cache_read_input_tokens != null) usageAcc.cache_read_input_tokens = src.cache_read_input_tokens
        if (src.cache_creation_input_tokens != null) usageAcc.cache_creation_input_tokens = src.cache_creation_input_tokens
      }

      const handleSse = function* (name, data) {
        const typ = name || (data && data.type) || ''
        if (typ === 'ping') return
        if (typ === 'error' || (data && data.type === 'error')) {
          throw providerError(opts.tag, (data && data.error) || data)
        }
        // message_stop already flushed usage+finish; ignore trailing pings/records.
        if (closed) return
        if (typ === 'message_start') {
          const msg = (data && data.message) || {}
          mergeUsage(msg.usage)
          if (msg.stop_reason) stopReason = msg.stop_reason
          return
        }
        if (typ === 'message_delta') {
          const delta = (data && data.delta) || {}
          if (delta.stop_reason != null) stopReason = delta.stop_reason
          mergeUsage(data && data.usage)
          mergeUsage(delta.usage)
          return
        }
        if (typ === 'message_stop') {
          yield* finalize()
          return
        }
        if (typ === 'content_block_start') {
          const index = data && data.index != null ? data.index : 0
          const cb = (data && data.content_block) || {}
          if (cb.type !== 'text' && cb.type !== 'thinking' && cb.type !== 'tool_use') return
          const st = {
            kind: cb.type,
            text: cb.type === 'thinking' ? (cb.thinking || '') : (cb.text || ''),
            id: cb.id,
            name: cb.name,
            args: '',
            // Some providers put complete args on start and stream no deltas;
            // used only when args stayed empty (never concatenated — official
            // streams send input:{} plus partial_json deltas).
            startInput: cb.input && typeof cb.input === 'object' && Object.keys(cb.input).length > 0 ? cb.input : null,
            ended: false,
          }
          blocks[index] = st
          emittedBlocks += 1
          if (cb.type === 'thinking') {
            yield { type: 'block-start', index, blockType: 'reasoning' }
            if (st.text) yield { type: 'reasoning-delta', index, text: st.text }
          } else if (cb.type === 'tool_use') {
            toolCalls = true
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id: cb.id, name: cb.name, argumentsDelta: '' }
          } else {
            yield { type: 'block-start', index, blockType: 'text' }
            if (st.text) yield { type: 'text-delta', index, text: st.text }
          }
          return
        }
        if (typ === 'content_block_delta') {
          const index = data && data.index != null ? data.index : 0
          const delta = (data && data.delta) || {}
          const st = blocks[index]
          if (!st || st.ended) return
          if (delta.type === 'text_delta') {
            const t = delta.text || ''
            st.text = (st.text || '') + t
            yield { type: 'text-delta', index, text: t }
          } else if (delta.type === 'thinking_delta') {
            const t = delta.thinking || delta.text || ''
            st.text = (st.text || '') + t
            yield { type: 'reasoning-delta', index, text: t }
          } else if (delta.type === 'input_json_delta') {
            const p = delta.partial_json || ''
            st.args = (st.args || '') + p
            yield { type: 'tool-call-delta', index, argumentsDelta: p }
          }
          return
        }
        if (typ === 'content_block_stop') {
          const index = data && data.index != null ? data.index : 0
          const ev = closeBlock(index)
          if (ev) yield ev
        }
      }

      while (true) {
        const step = await q.next()
        if (step.done) {
          const result = step.value
          if (result && result.streamed === false) {
            yield* emitNonStreamingResponse(result.json, opts.tag)
          } else {
            yield* finalize()
          }
          return
        }
        yield* handleSse(step.value.name, step.value.data)
      }
    },
  }
}

// ---------- responses-wire adapter factory (grok / codex) ----------
// ---------- request-side (verbatim from makeResponsesAdapter) --------------
function buildResponsesInput(system, messages) {
  const items = []
  if (system) items.push({ type: 'message', role: 'system', content: system })
  for (const m of messages || []) {
    if (m.role === 'system') continue
    const blocks = m.content || []
    if (m.role === 'assistant') {
      const text = textOf(blocks)
      if (text) items.push({ type: 'message', role: 'assistant', content: text })
      for (const b of blocks) {
        if (b && b.type === 'tool-call') items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: b.arguments || '{}' })
      }
    } else {
      const textParts = []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'tool-result') {
          items.push({ type: 'function_call_output', call_id: b.toolCallId, output: (b.isError ? '[tool error] ' : '') + textOf(b.content) })
        } else if (b.type === 'text' && b.text) {
          textParts.push(b.text)
        }
      }
      if (textParts.length > 0) {
        const joined = textParts.join('\n')
        items.push({ type: 'message', role: 'user', content: textParts.length === 1 && textParts[0] === joined ? textParts[0] : [{ type: 'input_text', text: joined }] })
      }
    }
  }
  return items
}

function usageFromResponse(resp) {
  const usage = (resp && resp.usage) || {}
  const cached = usage.input_tokens_details && usage.input_tokens_details.cached_tokens ? usage.input_tokens_details.cached_tokens : 0
  const u = { inputTokens: Math.max(0, (usage.input_tokens || 0) - cached), outputTokens: usage.output_tokens || 0 }
  if (cached > 0) u.cacheReadTokens = cached
  if (usage.cache_creation_input_tokens) u.cacheWriteTokens = usage.cache_creation_input_tokens
  return u
}

function finishFromResponse(resp, toolCalls, emittedBlocks) {
  if (resp && resp.status === 'incomplete' && resp.incomplete_details && resp.incomplete_details.reason === 'max_output_tokens') {
    return { type: 'finish', reason: { kind: 'max-tokens' } }
  }
  if (toolCalls) return { type: 'finish', reason: { kind: 'tool-calls' } }
  if (emittedBlocks === 0) {
    return { type: 'finish', reason: { kind: 'error', failure: { message: 'provider returned an empty response', code: 'EMPTY_RESPONSE' } } }
  }
  return { type: 'finish', reason: { kind: 'stop' } }
}

// Non-streaming translation — copied verbatim from makeResponsesAdapter.
function* translateFullResponse(resp) {
  const items = Array.isArray(resp && resp.output) ? resp.output : []
  let index = 0
  let toolCalls = false
  let emittedBlocks = 0
  for (const item of items) {
    if (item.type === 'reasoning') {
      const t = (item.summary || []).map((s) => s.text || '').join('\n').trim()
      if (!t) continue
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: t }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: t } }
      index += 1
      emittedBlocks += 1
    } else if (item.type === 'message') {
      for (const c of item.content || []) {
        const t = c.type === 'output_text' ? c.text : c.type === 'refusal' ? c.refusal : ''
        if (!t) continue
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: t }
        yield { type: 'block-end', index, block: { type: 'text', text: t } }
        index += 1
        emittedBlocks += 1
      }
    } else if (item.type === 'function_call') {
      toolCalls = true
      const args = item.arguments || '{}'
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: item.call_id, name: item.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: item.call_id, name: item.name, arguments: args } }
      index += 1
      emittedBlocks += 1
    }
  }
  yield { type: 'usage', usage: usageFromResponse(resp) }
  yield finishFromResponse(resp, toolCalls, emittedBlocks)
}

// ---------- incremental Responses SSE → DSH blocks ------------------------
function blockTypeOfItem(itemType) {
  if (itemType === 'reasoning') return 'reasoning'
  if (itemType === 'function_call') return 'tool-call'
  return 'text'
}

function itemKeys(data, item) {
  const keys = []
  if (item && item.id) keys.push(item.id)
  if (data && data.item_id && keys.indexOf(data.item_id) === -1) keys.push(data.item_id)
  if (data && typeof data.output_index === 'number') keys.push('idx:' + data.output_index)
  return keys
}

function itemKey(data, item) {
  const keys = itemKeys(data, item)
  return keys.length ? keys[0] : ''
}

function flattenMessageText(item) {
  let t = ''
  for (const c of (item && item.content) || []) {
    if (!c) continue
    if (c.type === 'output_text') t += c.text || ''
    else if (c.type === 'refusal') t += c.refusal || ''
  }
  return t
}

function flattenReasoningText(item) {
  return ((item && item.summary) || []).map((s) => (s && s.text) || '').join('\n').trim()
}

function createStreamState() {
  return {
    byId: new Map(),
    nextIndex: 0,
    toolCalls: false,
    emittedBlocks: 0,
    finished: false,
    lastResponse: null,
  }
}

function ensureSlot(state, itemId, itemType, extra, out, data, item) {
  const keys = itemKeys(data, item)
  if (itemId && keys.indexOf(itemId) === -1) keys.unshift(itemId)
  if (keys.length === 0) keys.push('')
  let slot = null
  for (const k of keys) {
    if (state.byId.has(k)) { slot = state.byId.get(k); break }
  }
  if (!slot) {
    slot = {
      id: keys[0],
      index: state.nextIndex++,
      itemType: itemType || 'message',
      blockType: blockTypeOfItem(itemType || 'message'),
      opened: false,
      closed: false,
      text: '',
      arguments: '',
      callId: extra && extra.callId || '',
      name: extra && extra.name || '',
      lastSummaryIndex: -1,
    }
  } else {
    if (itemType && slot.itemType !== itemType) {
      slot.itemType = itemType
      slot.blockType = blockTypeOfItem(itemType)
    }
    if (extra && extra.callId) slot.callId = extra.callId
    if (extra && extra.name) slot.name = extra.name
  }
  for (const k of keys) state.byId.set(k, slot)
  if (!slot.opened && !slot.closed) {
    slot.opened = true
    state.emittedBlocks += 1
    if (slot.itemType === 'function_call') state.toolCalls = true
    out.push({ type: 'block-start', index: slot.index, blockType: slot.blockType })
  }
  return slot
}

function closeSlot(state, slot, out) {
  if (!slot || slot.closed) return
  if (!slot.opened) {
    slot.opened = true
    state.emittedBlocks += 1
    if (slot.itemType === 'function_call') state.toolCalls = true
    out.push({ type: 'block-start', index: slot.index, blockType: slot.blockType })
  }
  slot.closed = true
  if (slot.itemType === 'function_call') {
    const args = slot.arguments || '{}'
    out.push({
      type: 'block-end',
      index: slot.index,
      block: { type: 'tool-call', id: slot.callId, name: slot.name, arguments: args },
    })
  } else if (slot.itemType === 'reasoning') {
    out.push({ type: 'block-end', index: slot.index, block: { type: 'reasoning', text: slot.text } })
  } else {
    out.push({ type: 'block-end', index: slot.index, block: { type: 'text', text: slot.text } })
  }
}

function closeRemaining(state, out) {
  const slots = Array.from(state.byId.values()).sort((a, b) => a.index - b.index)
  for (const slot of slots) {
    if (!slot.closed && slot.opened) closeSlot(state, slot, out)
  }
}

function emitTerminal(state, resp, out) {
  if (state.finished) return
  state.finished = true
  state.lastResponse = resp || state.lastResponse
  closeRemaining(state, out)
  out.push({ type: 'usage', usage: usageFromResponse(state.lastResponse) })
  out.push(finishFromResponse(state.lastResponse, state.toolCalls, state.emittedBlocks))
}

function processSseEvent(state, eventName, data, tag) {
  const out = []
  // Terminal events already emitted usage+finish: anything later is dropped,
  // mirroring the anthropic path's `closed` guard (§3.3: nothing after finish).
  if (state.finished) return out
  if (data == null || typeof data !== 'object') return out
  const type = data.type || eventName || ''

  if (type === 'error' || eventName === 'error' || type === 'response.failed' || eventName === 'response.failed') {
    throw providerError(tag, extractWireError(data))
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const resp = data.response || data
    state.lastResponse = resp
    emitTerminal(state, resp, out)
    return out
  }

  if (type === 'response.output_item.added') {
    const item = data.item || {}
    if (item.type !== 'message' && item.type !== 'reasoning' && item.type !== 'function_call') return out
    const extra = { callId: item.call_id || '', name: item.name || '' }
    const slot = ensureSlot(state, itemKey(data, item), item.type, extra, out, data, item)
    if (typeof item.arguments === 'string' && item.arguments) slot.arguments = item.arguments
    return out
  }

  if (type === 'response.output_item.done') {
    const item = data.item || {}
    if (item.type !== 'message' && item.type !== 'reasoning' && item.type !== 'function_call') return out
    const extra = { callId: item.call_id || '', name: item.name || '' }
    const slot = ensureSlot(state, itemKey(data, item), item.type, extra, out, data, item)
    if (item.type === 'function_call') {
      if (item.call_id) slot.callId = item.call_id
      if (item.name) slot.name = item.name
      // Prefer the done item's full arguments when present.
      if (typeof item.arguments === 'string' && item.arguments.length > 0) {
        if (!slot.arguments) {
          slot.arguments = item.arguments
          out.push({ type: 'tool-call-delta', index: slot.index, id: slot.callId, name: slot.name, argumentsDelta: item.arguments })
        } else if (item.arguments.startsWith(slot.arguments) && item.arguments.length > slot.arguments.length) {
          const extra = item.arguments.slice(slot.arguments.length)
          slot.arguments = item.arguments
          out.push({ type: 'tool-call-delta', index: slot.index, id: slot.callId, name: slot.name, argumentsDelta: extra })
        } else {
          slot.arguments = item.arguments
        }
      }
    } else if (item.type === 'reasoning') {
      const t = flattenReasoningText(item)
      if (t) {
        if (!slot.text) {
          slot.text = t
          out.push({ type: 'reasoning-delta', index: slot.index, text: t })
        } else if (t.startsWith(slot.text) && t.length > slot.text.length) {
          const extra = t.slice(slot.text.length)
          slot.text = t
          out.push({ type: 'reasoning-delta', index: slot.index, text: extra })
        } else {
          slot.text = t
        }
      }
    } else {
      const t = flattenMessageText(item)
      if (t) {
        if (!slot.text) {
          slot.text = t
          out.push({ type: 'text-delta', index: slot.index, text: t })
        } else if (t.startsWith(slot.text) && t.length > slot.text.length) {
          const extra = t.slice(slot.text.length)
          slot.text = t
          out.push({ type: 'text-delta', index: slot.index, text: extra })
        } else {
          slot.text = t
        }
      }
    }
    closeSlot(state, slot, out)
    return out
  }

  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    const slot = ensureSlot(state, itemKey(data, null), 'message', null, out, data, null)
    const delta = data.delta || ''
    if (delta) {
      slot.text += delta
      out.push({ type: 'text-delta', index: slot.index, text: delta })
    }
    return out
  }

  if (type === 'response.reasoning_summary_text.delta') {
    const slot = ensureSlot(state, itemKey(data, null), 'reasoning', null, out, data, null)
    const delta = data.delta || ''
    const summaryIndex = typeof data.summary_index === 'number' ? data.summary_index : 0
    if (slot.lastSummaryIndex >= 0 && summaryIndex !== slot.lastSummaryIndex && slot.text) {
      slot.text += '\n'
      out.push({ type: 'reasoning-delta', index: slot.index, text: '\n' })
    }
    slot.lastSummaryIndex = summaryIndex
    if (delta) {
      slot.text += delta
      out.push({ type: 'reasoning-delta', index: slot.index, text: delta })
    }
    return out
  }

  if (type === 'response.reasoning_text.delta') {
    const slot = ensureSlot(state, itemKey(data, null), 'reasoning', null, out, data, null)
    const delta = data.delta || ''
    if (delta) {
      slot.text += delta
      out.push({ type: 'reasoning-delta', index: slot.index, text: delta })
    }
    return out
  }

  if (type === 'response.function_call_arguments.delta') {
    const slot = ensureSlot(state, itemKey(data, null), 'function_call', { callId: data.call_id, name: data.name }, out, data, null)
    const delta = data.delta || ''
    if (delta) {
      slot.arguments += delta
      out.push({ type: 'tool-call-delta', index: slot.index, id: slot.callId, name: slot.name, argumentsDelta: delta })
    }
    return out
  }

  if (type === 'response.function_call_arguments.done') {
    const slot = ensureSlot(state, itemKey(data, null), 'function_call', { callId: data.call_id, name: data.name }, out, data, null)
    if (typeof data.arguments === 'string' && data.arguments.length > 0) slot.arguments = data.arguments
    if (data.name) slot.name = data.name
    return out
  }

  return out
}

function makeResponsesAdapter(opts) {
  return {
    providerInfo(provider) { return { id: provider, name: opts.name } },
    providerRetryPolicy() { return undefined },
    listModels(provider) { return Promise.resolve(opts.models.map((m) => ({ provider, id: m.id, name: m.name }))) },
    resolveModel(provider, model) {
      const found = opts.models.find((m) => m.id === model)
      if (found) {
        return Promise.resolve({
          provider, id: found.id, name: found.name,
          context: { contextWindow: found.contextWindow },
          defaultMaxTokens: found.defaultMaxTokens,
          reasoning: { efforts: opts.efforts, defaultEffort: opts.defaultEffort },
        })
      }
      return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 32768, reasoning: { efforts: opts.efforts, defaultEffort: opts.defaultEffort } })
    },
    async *stream(options) {
      const body = { model: options.model, input: buildResponsesInput(options.system, options.messages), max_output_tokens: options.maxTokens || 32768, stream: true }
      const reasoningAllowed = options.purpose !== 'session-title' && !(options.maxTokens && options.maxTokens < 1025)
      const effort = opts.mapEffort ? opts.mapEffort(options.reasoningEffort) : options.reasoningEffort
      if (reasoningAllowed && effort) body.reasoning = { effort, summary: 'concise' }
      if (Array.isArray(options.tools) && options.tools.length > 0) {
        body.tools = options.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters || { type: 'object' } }))
        body.tool_choice = 'auto'
      }
      const headers = typeof opts.headers === 'function' ? await opts.headers() : opts.headers
      if (!headers.authorization || headers.authorization === 'Bearer ') throw llmFail(opts.tag + ' error: missing credentials', 'AUTH')

      const queue = []
      let wake = null
      let settled = false
      let result = null
      let error = null
      const kick = () => {
        if (wake) {
          const w = wake
          wake = null
          w()
        }
      }
      const state = createStreamState()
      const run = httpStream(opts.url, headers, JSON.stringify(body), opts.proxy || null, options.signal, (name, data) => {
        queue.push({ name, data })
        kick()
      })
      run.then((r) => { result = r; settled = true; kick() }, (e) => { error = e; settled = true; kick() })

      while (!settled || queue.length) {
        if (!queue.length && !settled) {
          await new Promise((resolve) => { wake = resolve })
          continue
        }
        while (queue.length) {
          const ev = queue.shift()
          const produced = processSseEvent(state, ev.name, ev.data, opts.tag)
          for (const chunk of produced) yield chunk
        }
      }
      if (error) throw error
      if (result && result.streamed === false) {
        const resp = result.json
        if (resp && resp.error) throw providerError(opts.tag, resp.error)
        yield* translateFullResponse(resp)
        return
      }
      if (!state.finished) {
        const tail = []
        emitTerminal(state, state.lastResponse, tail)
        for (const chunk of tail) yield chunk
      }
    },
  }
}

// ---------- L2 recipes (distilled from upstream sources) ----------
const RECIPES = {
  'kimi-agent': {
    provider: 'kimi-kernel', model: 'k3-256k',
    persona: 'You are running as a subagent of a main agent. All user messages are sent by the main agent. The main agent cannot see your context, only your final message. Treat the parent agent as your caller; do not ask the end user questions directly. If something is unclear, explain the ambiguity in your final summary. You are the Kimi Code "coder" subagent: good at general software engineering tasks — reading files, editing code, running commands — and you must return a compact but technically complete summary to the parent agent.',
    toolFilter: { allow: [SHELL, 'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'web_search'] },
  },
  'kimi-explore': {
    provider: 'kimi-kernel', model: 'k3-256k',
    persona: 'You are the Kimi Code "explore" subagent: a fast, read-only codebase exploration specialist. You have NO file editing tools. Use glob for file patterns, grep for content search, read for known paths; run shell ONLY for read-only commands (ls, git status, git log, git diff, find). Adapt search depth to the thoroughness requested by the caller (quick | medium | thorough). Prefer parallel tool calls. Report findings in a structured format with absolute paths.',
    toolFilter: { allow: [SHELL, 'read', 'read_image', 'glob', 'grep', 'web_search'] },
  },
  'kimi-plan': {
    provider: 'kimi-kernel', model: 'k3-256k',
    persona: 'You are the Kimi Code "plan" subagent: read-only implementation planning and architecture design. You cannot run shell or edit files. In your response clearly state: 1) what you already know from the information provided, 2) what questions remain that would benefit from codebase exploration, 3) your implementation plan (preliminary if questions remain, final if context suffices) with key files and architectural trade-offs.',
    toolFilter: { allow: ['read', 'read_image', 'glob', 'grep', 'web_search'] },
  },
  'grok-agent': {
    provider: 'grok-kernel', model: 'grok-4.6',
    persona: 'You are the Grok Build "general-purpose" subagent. Complete the assigned task directly: do what was asked, nothing more, nothing less. Respond with a detailed writeup when done. You have full capability: read, write, edit, and execute. Prefer editing existing files; never create documentation files unless explicitly requested. When spawning child agents, choose the narrowest capability that fits the task.',
    toolFilter: { allow: [SHELL, 'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'web_search', 'subagent', 'subagent_fork'] },
  },
  'grok-explore': {
    provider: 'grok-kernel', model: 'grok-4.6',
    persona: 'You are the Grok Build "explore" subagent: fast, read-only codebase exploration. You have NO file editing tools. Use list/search/read tool kinds; execute only read-only shell commands (ls, git status, git log, git diff, find, cat, head, tail). Thoroughness: quick | medium | very thorough. Start broad and narrow down; maximize parallel tool calls; return absolute file paths and relevant code snippets.',
    toolFilter: { allow: [SHELL, 'read', 'read_image', 'glob', 'grep', 'web_search'] },
  },
  'codex-agent': {
    provider: 'codex-kernel', model: 'deepseek-v4-flash:0731',
    persona: 'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals. You are running as a subagent: all user messages come from the parent agent, which only sees your final message; treat the parent as your caller and do not ask the end user questions directly. Complete the assigned task with tools, then return a compact, technically complete summary.',
    toolFilter: { allow: [SHELL, 'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'web_search'] },
  },
  'codex-explore': {
    provider: 'codex-kernel', model: 'deepseek-v4-flash:0731',
    persona: 'You are a Codex exploration subagent: fast, read-only codebase exploration. You have NO file editing tools. Use glob/grep/read; run shell only for read-only commands (ls, git status, git log, git diff, find). Report findings in a structured format with absolute paths.',
    toolFilter: { allow: [SHELL, 'read', 'read_image', 'glob', 'grep', 'web_search'] },
  },
  'minimax-agent': {
    provider: 'minimax-kernel', model: 'MiniMax-M2.7',
    persona: 'You are Mini-Agent, MiniMax\'s coding agent, running as a subagent of a main agent. All user messages are sent by the main agent, which only sees your final message; treat the parent as your caller and do not ask the end user questions. Complete the assigned task with tools and return a compact, complete summary. Do not guess — use tools to discover missing information. Be proactive, stay focused, stop when the task is fulfilled.',
    toolFilter: { allow: [SHELL, 'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'web_search'] },
  },
}

// Cross-model search engines. Official ctx.web can pin only ONE searchProvider,
// so these stay as separate tools. A tool is offered only when BOTH are true:
// the matching surface package is installed, and that vendor's credential exists.
// Never assume the user subscribed to every kernel.
const SEARCH_ENGINES = {
  kimi: {
    plugin: 'dsh-kernel-kimi',
    tools: ['kimi_search', 'kimi_fetch'],
    strengths: 'professional / finance / filings / CN web',
    subscribed: () => !!loadKimiBearer(),
  },
  grok: {
    plugin: 'dsh-kernel-grok',
    tools: ['grok_search', 'grok_fetch'],
    strengths: 'broad web + X/Twitter',
    subscribed: () => !!loadGrokKey(),
  },
}

function pluginInstalled(pkg) {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const dshHome = process.env.DSH_HOME || path.join(HOME, '.dsh')
  const candidates = [
    path.resolve(here, '..', '..', pkg, 'package.json'),
    path.join(dshHome, 'profiles', 'node_modules', pkg, 'package.json'),
  ]
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return true } catch {}
  }
  try {
    createRequire(import.meta.url).resolve(pkg + '/package.json')
    return true
  } catch {}
  return false
}

function kernelSearchOffered(kind) {
  const spec = SEARCH_ENGINES[kind]
  return !!(spec && pluginInstalled(spec.plugin) && spec.subscribed())
}

function availableSearchTools() {
  const names = []
  for (const kind of Object.keys(SEARCH_ENGINES)) {
    if (kernelSearchOffered(kind)) names.push(...SEARCH_ENGINES[kind].tools)
  }
  return names
}

function knownGlobalToolNames(tools) {
  const known = new Set()
  if (!tools) return known
  const push = (item) => {
    const name = typeof item === 'string' ? item : item && item.name
    if (name) known.add(name)
  }
  if (typeof tools.schemas === 'function') {
    try {
      const listed = tools.schemas()
      if (Array.isArray(listed)) for (const item of listed) push(item)
    } catch {}
  }
  if (!known.size && typeof tools.list === 'function') {
    try {
      const listed = tools.list()
      if (Array.isArray(listed)) for (const item of listed) push(item)
    } catch {}
  }
  if (typeof tools.get === 'function') {
    for (const name of ['read', 'read_image', 'write', 'edit', 'grep', 'glob', 'web_search', 'web_fetch', 'bash', 'pwsh', 'subagent', 'subagent_fork']) {
      try { if (tools.get(name)) known.add(name) } catch {}
    }
    for (const name of availableSearchTools()) {
      try { if (tools.get(name)) known.add(name) } catch {}
    }
  }
  return known
}

function recipeToolFilter(recipe, tools) {
  const extra = availableSearchTools()
  const wanted = recipe.toolFilter.allow.concat(extra)
  // tools.restrict() rejects unknown global names. A recipe may mention
  // stock DSH tools (glob, pwsh, …) that this host composition never
  // registered — drop those so kernel_run can still start. On WSL the
  // official glob row is often absent even though grep/read exist.
  const known = knownGlobalToolNames(tools)
  const allow = known.size ? wanted.filter((name) => known.has(name)) : wanted
  return { allow: allow.length ? allow : wanted }
}

function searchCatalog() {
  const out = {}
  for (const kind of Object.keys(SEARCH_ENGINES)) {
    const spec = SEARCH_ENGINES[kind]
    const installed = pluginInstalled(spec.plugin)
    const subscribed = spec.subscribed()
    out[kind] = {
      plugin: spec.plugin,
      installed,
      subscribed,
      offered: installed && subscribed,
      strengths: spec.strengths,
    }
  }
  return out
}

// ---------- credential loading ----------
// grok rotates its JWT (the grok CLI rewrites auth.json), so the key must be
// re-read per request instead of being captured once at apply() time.
function freshGrokKey() {
  try {
    const grokAuth = credPath('.grok/auth.json')
    if (!grokAuth) throw new Error('no grok auth.json in any credential root')
    const auth = JSON.parse(readText(grokAuth))
    const k = Object.keys(auth)[0]
    if (k && auth[k] && typeof auth[k].key === 'string') return auth[k].key
  } catch {}
  return ''
}

function loadCredentials() {
  const creds = { kimi: '', kimiOAuth: false, grok: '', codex: '', codexBase: 'https://ollama.com/v1', codexModel: 'deepseek-v4-flash:0731', minimax: '' }
  try {
    const kimiCfg = credPath('.kimi-code/config.toml')
    const cfg = kimiCfg ? readText(kimiCfg) : ''
    const m = /\[providers\.kimi-for-coding\]([\s\S]*?)(?=\r?\n\[|$)/.exec(cfg)
    if (m) {
      const km = /api_key\s*=\s*"([^"]+)"/.exec(m[1])
      if (km) creds.kimi = km[1]
    }
  } catch {}
  // Prefer the kimi-code OAuth token (kimi-cli login) over the static api_key;
  // the static key stays as a fallback when no OAuth credential file exists.
  creds.kimiOAuth = loadKimiOAuthToken() !== null
  try {
    const grokAuth = credPath('.grok/auth.json')
    if (!grokAuth) throw new Error('no grok auth.json in any credential root')
    const auth = JSON.parse(readText(grokAuth))
    const k = Object.keys(auth)[0]
    if (k && auth[k] && typeof auth[k].key === 'string') creds.grok = auth[k].key
  } catch {}
  try {
    const codexCfg = credPath('.codex/config.toml')
    const cfg = codexCfg ? readText(codexCfg) : ''
    const bm = /\[model_providers\.custom\]([\s\S]*?)(?=\r?\n\[|$)/.exec(cfg)
    if (bm) {
      const um = /base_url\s*=\s*"([^"]+)"/.exec(bm[1])
      if (um) creds.codexBase = um[1]
    }
    // `model` lives in the TOP-LEVEL scope (verified against the user's real
    // config.toml), not inside the [model_providers.custom] block.
    const topLevel = cfg.split(/\r?\n\[/)[0]
    const mm = /^model\s*=\s*"([^"]+)"/m.exec(topLevel)
    if (mm) creds.codexModel = mm[1]
    const codexAuth = credPath('.codex/auth.json')
    if (!codexAuth) throw new Error('no codex auth.json in any credential root')
    const auth = JSON.parse(readText(codexAuth))
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0) creds.codex = auth.OPENAI_API_KEY
  } catch {}
  for (const rel of ['.mini-agent/config.yaml', '.mini-agent/config/config.yaml', '.config/mini-agent/config.yaml']) {
    const p = credPath(rel)
    if (!p) continue
    try {
      const km = /api_key\s*[:=]\s*["']?(sk-[^\s"']+)/.exec(readText(p))
      if (km) { creds.minimax = km[1]; break }
    } catch {}
  }
  return creds
}

// ---------- plugin ----------
const name = 'dsh-kernel-mesh'
const inject = ['llm', 'tools', 'subagents']

function apply(ctx) {
    const llm = ctx.get('llm')
    const subagents = ctx.get('subagents')
    const attachments = ctx.get('attachments')
    const tools = ctx.get('tools')
    if (!llm) return
    const creds = loadCredentials()

    // Forward a per-child reasoning effort into the child's request waterfall.
    // kernel_run puts `reasoningEffort` into the child AgentOptions (DSH treats
    // AgentOptions as merge-extensible, so the extra field survives). Subagent
    // children have no model-selection install, so this is the only channel that
    // lets a per-call effort override the adapter default. Scoped to the child's
    // ctx, so it disposes with the agent.
    ctx.on('agent/created', ({ agent }) => {
      const effort = agent.options && agent.options.reasoningEffort
      if (!effort) return
      agent.ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        return { ...resolved, reasoningEffort: effort }
      })
    })

    // Keep L2 recipe models in sync with the user's codex config (model line wins over the built-in default).
    if (RECIPES['codex-agent']) RECIPES['codex-agent'].model = creds.codexModel
    if (RECIPES['codex-explore']) RECIPES['codex-explore'].model = creds.codexModel

    const KIMI_MODELS = [
      { id: 'k3-256k', name: 'Kimi K3-256K', contextWindow: 262144, defaultMaxTokens: 131072 },
      { id: 'k3', name: 'Kimi K3', contextWindow: 1048576, defaultMaxTokens: 131072 },
      { id: 'kimi-for-coding', name: 'Kimi For Coding (K2.7)', contextWindow: 262144, defaultMaxTokens: 32768 },
    ]
    const GROK_MODELS = [
      { id: 'grok-4.6', name: 'Grok 4.6 (Grok Build kernel)', contextWindow: 500000, defaultMaxTokens: 32768 },
      { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500000, defaultMaxTokens: 32768 },
    ]
    const CODEX_MODELS = [{ id: creds.codexModel, name: 'Codex custom (' + creds.codexModel + ')', contextWindow: 500000, defaultMaxTokens: 32768 }]
    if (creds.codexModel !== 'glm-5.2') CODEX_MODELS.push({ id: 'glm-5.2', name: 'Codex custom (glm-5.2)', contextWindow: 500000, defaultMaxTokens: 32768 })
    const MINIMAX_MODELS = [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7 (Mini-Agent kernel)', contextWindow: 204800, defaultMaxTokens: 32768 },
      { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1000000, defaultMaxTokens: 32768 },
    ]

    if (creds.kimiOAuth || creds.kimi) {
      llm.registerAdapter(['kimi-kernel'], makeAnthropicAdapter({
        tag: 'kimi', name: 'Kimi Code kernel (api.kimi.com/coding' + (creds.kimiOAuth ? ', OAuth)' : ')'),
        url: 'https://api.kimi.com/coding/v1/messages',
        headers: creds.kimiOAuth
          ? async () => ({ 'content-type': 'application/json', authorization: 'Bearer ' + await freshKimiKey(), 'anthropic-version': '2023-06-01', 'user-agent': UA })
          : { 'content-type': 'application/json', authorization: 'Bearer ' + creds.kimi, 'anthropic-version': '2023-06-01', 'user-agent': UA },
        models: KIMI_MODELS, replayThinking: true, attachments, clampToRemainingContext: true,
        efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
        defaultEffort: 'max',
        thinkingFor: (model, effort) => {
          // Kimi's coding endpoint is a budget-based Anthropic wire: reasoning
          // depth is a token budget, not an effort label. Upstream kimi-cli's
          // budget tiers are low=1024 / medium=4096 / high=32000, and the
          // "max"/"xhigh" labels have no distinct budget tier (they clamp to
          // high on the non-adaptive path). We map those labels to the ceiling.
          const KIMI_EFFORT_BUDGET = { low: 1024, medium: 4096, high: 32000, xhigh: 32000, max: 32000 }
          const budget = KIMI_EFFORT_BUDGET[effort] || 32000
          return { type: 'enabled', budget_tokens: budget }
        },
      }))
    }
    if (creds.grok) {
      llm.registerAdapter(['grok-kernel'], makeResponsesAdapter({
        tag: 'grok', name: 'Grok Build kernel (cli-chat-proxy.grok.com)',
        url: 'https://cli-chat-proxy.grok.com/v1/responses',
        headers: () => {
          const key = freshGrokKey()
          return {
            'content-type': 'application/json', authorization: 'Bearer ' + key,
            'X-XAI-Token-Auth': 'xai-grok-cli', 'x-authenticateresponse': 'authenticate-response',
            'x-grok-client-mode': 'headless', 'x-grok-client-version': '1.0.3', 'user-agent': UA,
          }
        },
        models: GROK_MODELS, proxy: PROXY, defaultEffort: 'xhigh',
        efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'xhigh', name: 'X-High (Max)' }],
        mapEffort: (e) => {
          let effort = e || 'xhigh'
          if (effort === 'max') effort = 'xhigh'
          if (effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'xhigh') effort = 'xhigh'
          return effort
        },
      }))
    }
    if (creds.codex) {
      llm.registerAdapter(['codex-kernel'], makeResponsesAdapter({
        tag: 'codex', name: 'Codex kernel (custom: ' + creds.codexBase + ')',
        url: creds.codexBase.replace(/\/+$/, '') + '/responses',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + creds.codex, 'user-agent': UA },
        models: CODEX_MODELS, proxy: null, defaultEffort: 'high',
        efforts: [{ id: 'none', name: 'Disabled' }, { id: 'high', name: 'High' }],
        mapEffort: (e) => (e === 'none' ? null : 'high'),
      }))
    }
    if (creds.minimax) {
      llm.registerAdapter(['minimax-kernel'], makeAnthropicAdapter({
        tag: 'minimax', name: 'Mini-Agent kernel (api.minimaxi.com)',
        url: 'https://api.minimaxi.com/anthropic/v1/messages',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + creds.minimax, 'anthropic-version': '2023-06-01', 'user-agent': UA },
        models: MINIMAX_MODELS, attachments, replayThinking: false,
        thinkingFor: (model) => (String(model).indexOf('MiniMax-M2') === 0 ? null : { type: 'adaptive' }),
      }))
    }

    // L2 providers — registered lazily: `spawn` may not be registered yet when
    // this row applies at boot, so (re)try at apply AND at every kernel_run call.
    const ensureL2 = () => {
      if (!subagents) return
      const existing = subagents.list()
      const spawn = subagents.getProvider('spawn')
      if (!spawn) return
      for (const name of Object.keys(RECIPES)) {
        if (existing.indexOf(name) >= 0) continue
        const recipe = RECIPES[name]
        if (!llm.listProviders().some((p) => p.id === recipe.provider)) continue
        subagents.registerProvider({
          name,
          capabilities: spawn.capabilities,
          inheritsParentContext: spawn.inheritsParentContext,
          start(request) {
            return spawn.start({
              ...request,
              agentOptions: { provider: recipe.provider, model: recipe.model, ...(request.agentOptions || {}) },
              persona: request.persona === undefined ? recipe.persona : request.persona,
              toolFilter: request.toolFilter === undefined ? recipeToolFilter(recipe, tools) : request.toolFilter,
            })
          },
          // Continuable capability: the native background route
          // (subagents.startContinuable) checks only for the method's presence
          // and the continuation manager owns child creation, so forward
          // verbatim. NOTE: on the continuable path provider.start() is never
          // invoked — callers must set agentOptions/persona/toolFilter on the
          // request themselves (kernel_run does), because those fields are
          // recorded in the durable descriptor for cold resume.
          prepareContinuable(request) {
            return spawn.prepareContinuable(request)
          },
        })
        existing.push(name)
      }
    }
    ensureL2()

    const toolDef = (definition) => {
      definition.output.render = definition.output.render || ((a, v) => [{ type: 'text', text: JSON.stringify(v) }])
      return definition
    }
    if (tools) {
      tools.register(toolDef({
        name: 'kernel_status',
        description: 'Report the harness-kernel mesh: registered foreign kernels, L2 subagent types, transports, and which vendor search engines are offered (plugin installed + subscription present).',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object', properties: { kernels: { type: 'array', items: { type: 'object', additionalProperties: true } }, subagentProviders: { type: 'array', items: { type: 'string' } }, searchEngines: { type: 'object', additionalProperties: true } }, additionalProperties: true } },
        execute: async () => {
          ensureL2()
          return {
            kernels: llm.listProviders().filter((p) => ['kimi-kernel', 'grok-kernel', 'codex-kernel', 'minimax-kernel'].includes(p.id)).map((p) => ({ id: p.id, name: p.name })),
            subagentProviders: subagents ? subagents.list() : [],
            searchEngines: searchCatalog(),
          }
        },
      }))
      tools.register(toolDef({
        name: 'kernel_run',
        // Wording mirrors the native delegation tool (dsh-tool-subagent,
        // backgroundMode: 'continuable'): background-first, durable child id,
        // settlement notice, send_message continuation.
        description: 'Run one DSH subagent on a foreign harness kernel with a distilled recipe. kernel: kimi|grok|codex|minimax; type: kimi coder|explore|plan, grok general|explore, codex general|explore, minimax general. This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; send_message starts a later turn in the same child conversation, list_agents shows its status, and interrupt_agent stops its current turn. Set run_in_background: false only when your next action depends on receiving the result.',
        parameters: {
          type: 'object',
          properties: {
            kernel: { type: 'string', description: 'kimi | grok | codex | minimax.' },
            type: { type: 'string', description: 'Subagent type from the source harness.' },
            task: { type: 'string', description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
            description: { type: 'string', description: 'A short (3-5 word) description of the delegated task, for display.' },
            model: { type: 'string', description: 'Optional model override.' },
            effort: { type: 'string', description: 'Optional reasoning-effort override. grok: low|medium|high|xhigh (default xhigh); kimi: low|medium|high|max (default max); codex: none|high; minimax: ignored.' },
            run_in_background: { type: 'boolean', description: 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.' },
          },
          required: ['kernel', 'task'],
        },
        output: {
          schema: { type: 'object', properties: { kind: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' }, output: { type: 'string' }, stopReason: { type: 'string' }, subagentId: { type: 'string' }, runId: { type: 'string' }, subagentProvider: { type: 'string' } }, additionalProperties: true },
          render: (a, v) => [{ type: 'text', text: v && v.kind === 'continuable' ? 'started subagent ' + v.subagentId : v && v.ok ? (v.output || '(no output)') : 'Error: ' + (v && v.error ? v.error : 'unknown kernel_run failure') }],
        },
        // Background starts and sibling foreground runs overlap safely under the
        // loop's rolling pool, exactly like the native delegation tool.
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          if (!exec.agent) return { ok: false, error: 'no caller agent in execution context' }
          if (!subagents) return { ok: false, error: 'subagents service unavailable' }
          ensureL2()
          const TYPE_MAP = {
            kimi: { coder: 'kimi-agent', explore: 'kimi-explore', plan: 'kimi-plan' },
            grok: { general: 'grok-agent', explore: 'grok-explore' },
            codex: { general: 'codex-agent', explore: 'codex-explore' },
            minimax: { general: 'minimax-agent' },
          }
          const map = TYPE_MAP[args.kernel]
          if (!map) return { ok: false, error: 'unknown kernel "' + args.kernel + '"' }
          const type = args.type || (args.kernel === 'kimi' ? 'coder' : 'general')
          const providerName = map[type]
          const recipe = RECIPES[providerName]
          if (!recipe) return { ok: false, error: 'unknown kernel/type "' + args.kernel + '/' + type + '"' }
          // Last-selection persistence: the model picks model/effort like a human;
          // an omitted field falls back to the last choice for this kernel, then
          // to the kernel's max/default.
          const KERNEL_DEFAULTS = {
            grok: { model: 'grok-4.6', effort: 'xhigh' },
            kimi: { model: 'k3-256k', effort: 'max' },
            codex: { model: creds.codexModel, effort: 'high' },
            minimax: { model: 'MiniMax-M2.7', effort: undefined },
          }
          const kd = KERNEL_DEFAULTS[args.kernel] || {}
          const selections = loadSelections()
          const last = selections[args.kernel] || {}
          const model = args.model || last.model || kd.model || recipe.model
          const effort = args.effort || last.effort || kd.effort
          selections[args.kernel] = { model, ...(effort ? { effort } : {}) }
          saveSelections(selections)
          // Build the FULL child request here, mirroring the native tool:
          // persona/toolFilter/agentOptions must be set by the caller because
          // the continuable route never invokes provider.start() — the durable
          // descriptor records exactly these fields for cold resume. maxDepth
          // matches the native default delegation-depth cap.
          const label = args.description || (providerName + ': ' + String(args.task).replace(/\s+/g, ' ').slice(0, 40))
          const request = {
            label,
            prompt: [{ type: 'text', text: String(args.task) }],
            parent: exec.agent,
            agentOptions: { provider: recipe.provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
            persona: recipe.persona,
            toolFilter: recipeToolFilter(recipe, tools),
            maxDepth: 3,
          }
          // Background-first (native default): establish a durable continuable
          // child and return at inbox acceptance. The child owns its turns from
          // here — no in-tool await, no 10-minute exposure, and the runtime
          // delivers the settlement notice itself.
          if (args.run_in_background !== false) {
            try {
              const started = await subagents.startContinuable({ provider: providerName, label, request, signal: exec.signal })
              return { kind: 'continuable', ok: true, subagentId: started.childId, kernel: args.kernel, provider: recipe.provider, model, effort, subagentProvider: providerName }
            } catch (e) {
              return { ok: false, error: 'kernel subagent background start failed: ' + String(e) + ' — retry with run_in_background: false', kernel: args.kernel, subagentProvider: providerName }
            }
          }
          // Foreground override: collect the result and dispose, preserving the
          // child's partial output on a non-completed stop (native semantics).
          let run
          try {
            run = await subagents.start(providerName, { ...request, signal: exec.signal })
            const result = await run.result
            const outText = textOf(result.output)
            if (result.stopReason !== 'completed') {
              const headline = 'kernel subagent stopped: ' + result.stopReason
              return { kind: 'foreground', ok: false, error: outText ? headline + '\nPartial output before the run ended:\n' + outText : headline, kernel: args.kernel, provider: recipe.provider, model, effort, subagentProvider: providerName, stopReason: result.stopReason, output: outText }
            }
            return { kind: 'foreground', ok: true, runId: run.id, kernel: args.kernel, provider: recipe.provider, model, effort, subagentProvider: providerName, stopReason: result.stopReason, output: outText }
          } catch (e) {
            return { ok: false, error: 'kernel subagent failed: ' + String(e), kernel: args.kernel }
          } finally {
            if (run) { try { await run.dispose() } catch {} }
          }
        },
      }))
      // Native parity: a prompt section teaches the background-first calling
      // convention while the tool is visible (dsh-tool-subagent does the same
      // for `subagent` at order 116.5).
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt) {
        systemPrompt.section({
          name: 'tool:kernel_run',
          order: 116.6,
          text: (context) => (tools.get('kernel_run', context && context.scope) === undefined ? '' : 'Use kernel_run in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent\'s result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message; use send_message with its subagent id to give it more work.'),
        })
      }
      const defaultModel = ctx.get('agentDefaultModel')
      if (defaultModel) {
        tools.register(toolDef({
          name: 'kernel_switch',
          description: 'Switch the DEFAULT model route for future sessions to a registered kernel: kimi (kimi-kernel/k3-256k), grok (grok-kernel/grok-4.6), codex, minimax, or deepseek (back to deepseek-official/deepseek-v4-pro).',
          parameters: {
            type: 'object',
            properties: { kernel: { type: 'string', description: 'kimi | grok | codex | minimax | deepseek' } },
            required: ['kernel'],
          },
          output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' } }, additionalProperties: true } },
          execute: async (args, exec) => {
            const map = {
              kimi: { provider: 'kimi-kernel', model: 'k3-256k' },
              grok: { provider: 'grok-kernel', model: 'grok-4.6' },
              codex: { provider: 'codex-kernel', model: creds.codexModel },
              minimax: { provider: 'minimax-kernel', model: 'MiniMax-M2.7' },
              deepseek: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
            }
            const sel = map[args.kernel]
            if (!sel) return { ok: false, error: 'unknown kernel "' + args.kernel + '"' }
            if (sel.provider !== 'deepseek-official' && !llm.listProviders().some((p) => p.id === sel.provider)) {
              return { ok: false, error: 'kernel "' + args.kernel + '" has no live route (adapter not registered; check credentials)' }
            }
            try {
              await defaultModel.saveSelection(sel)
              return { ok: true, provider: sel.provider, model: sel.model }
            } catch (e) {
              return { ok: false, error: String(e), provider: sel.provider, model: sel.model }
            }
          },
        }))
      }

      const registerSearch = (t) => {
        try { tools.register(t) } catch (e) {
          if (String(e).indexOf('already registered') >= 0) return
          throw e
        }
      }
      const strSearch = (t) => {
        t.output = {
          schema: { type: 'string' },
          render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
        }
        return t
      }
      // Offer a vendor search only when that vendor's DSH plugin is installed
      // AND the matching subscription credential is present. Missing either
      // condition means the user never opted into that engine.
      if (kernelSearchOffered('kimi')) {
        registerSearch(strSearch({
          name: 'kimi_search',
          description: 'Search the web through Kimi / Moonshot\'s professional index (api.kimi.com/coding/v1/search). Stronger for finance, filings, Chinese web, and structured professional sources. Use this when the query is about markets, companies, regulations, or CN-language sources. Offered only because dsh-kernel-kimi is installed and a Moonshot credential exists. Does not replace grok_search.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The search query to perform.' },
              limit: { type: 'integer', description: 'Number of results (default 8).' },
              include_content: { type: 'boolean', description: 'Also crawl page content (costs many tokens).' },
            },
            required: ['query'],
          },
          execute: async (args, exec) => {
            if (!loadKimiBearer()) return 'kimi_search unavailable: Moonshot credential disappeared'
            try {
              const res = await kimiSearchNative(args, exec && exec.signal)
              return res && res.text ? res.text : '(no results)'
            } catch (e) {
              return 'kimi_search failed: ' + String(e)
            }
          },
        }))
        registerSearch(strSearch({
          name: 'kimi_fetch',
          description: 'Fetch a URL through Kimi / Moonshot (api.kimi.com/coding/v1/fetch). Prefer this after kimi_search when you need the page body as markdown. Offered only because dsh-kernel-kimi is installed and a Moonshot credential exists.',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'The URL to fetch.' } },
            required: ['url'],
          },
          execute: async (args, exec) => {
            try {
              return await kimiFetchNative(args.url, exec && exec.signal)
            } catch (e) {
              return 'kimi_fetch failed: ' + String(e)
            }
          },
        }))
      }
      if (kernelSearchOffered('grok')) {
        registerSearch(strSearch({
          name: 'grok_search',
          description: 'Search the web through Grok / xAI (cli-chat-proxy.grok.com web_search). Stronger for broad current web coverage and X/Twitter. Use this for general tech news, social posts, and live web. Offered only because dsh-kernel-grok is installed and a Grok OAuth credential exists. Does not replace kimi_search.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The search query to perform.' },
              allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Optional domain allow-list (Grok only).' },
            },
            required: ['query'],
          },
          execute: async (args, exec) => {
            if (!loadGrokKey()) return 'grok_search unavailable: Grok OAuth credential disappeared'
            try {
              const res = await grokSearchNative(args, exec && exec.signal)
              return res && res.text ? res.text : '(no results)'
            } catch (e) {
              return 'grok_search failed: ' + String(e)
            }
          },
        }))
        registerSearch(strSearch({
          name: 'grok_fetch',
          description: 'Fetch a URL through the local HTTPS path used by Grok (via $HTTPS_PROXY). Prefer this after grok_search when you need the page body. Offered only because dsh-kernel-grok is installed and a Grok OAuth credential exists.',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'The URL to fetch.' } },
            required: ['url'],
          },
          execute: async (args, exec) => {
            try {
              return await grokFetchNative(args.url, exec && exec.signal)
            } catch (e) {
              return 'grok_fetch failed: ' + String(e)
            }
          },
        }))
      }
      const searchPrompt = ctx.get('systemPrompt')
      if (searchPrompt) {
        searchPrompt.section({
          name: 'tool:kernel-search',
          order: 116.7,
          text: (context) => {
            const bits = []
            if (tools.get('kimi_search', context && context.scope)) bits.push('kimi_search (Moonshot professional index: finance, filings, CN web)')
            if (tools.get('grok_search', context && context.scope)) bits.push('grok_search (xAI web + X/Twitter)')
            if (!bits.length) return ''
            return 'Vendor web search engines are separate tools, not one backend. A tool appears only when that vendor\'s DSH plugin is installed and the matching subscription is present. Pick the engine that matches the query: ' + bits.join('; ') + '. Official web_search (if present) is DeepSeek\'s own search and is a third option, not a wrapper. You may call more than one offered engine in parallel when the query benefits from both corpora.'
          },
        })
      }
    }
}

// Test hook: lets offline regression tests drive the adapter factories against
// a local HTTP stub. Not used by Cordis (which reads name/inject/apply only).
const _test = {
  makeAnthropicAdapter, makeResponsesAdapter, httpStream, anthropicImageBlock,
  estimateTextTokens, estimateRequestTokens, clampKimiMaxTokens, kimiCompletionBudgetFromEnv,
  pluginInstalled, kernelSearchOffered, availableSearchTools, recipeToolFilter, searchCatalog,
}
export { name, inject, apply, _test }
