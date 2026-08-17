// Shared Kimi / Grok search+fetch backends for dsh-kernel-mesh.
// These are model-facing search engines with different strengths:
//   kimi — Moonshot professional index (finance, filings, CN/web)
//   grok — xAI web + X/Twitter coverage
// The official ctx.web seam can pin only ONE searchProvider; these stay
// as separate tools so the model can pick the right corpus per query.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const KIMI_SEARCH_URL = 'https://api.kimi.com/coding/v1/search'
const KIMI_FETCH_URL = 'https://api.kimi.com/coding/v1/fetch'
const GROK_SEARCH_URL = 'https://cli-chat-proxy.grok.com/v1/responses'
const GROK_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7897'

function curlBin() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
    : 'curl'
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

function curlRequest(opts) {
  const argv = [curlBin(), '-sS', '-m', String(opts.timeoutSec || 90)]
  if (opts.proxy) argv.push('-x', opts.proxy)
  if (opts.method && opts.method !== 'GET') argv.push('-X', opts.method)
  for (const key of Object.keys(opts.headers || {})) argv.push('-H', key + ': ' + opts.headers[key])
  if (opts.body != null) argv.push('--data-binary', '@-')
  argv.push(opts.url)
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let aborted = false
    const onAbort = () => { aborted = true; try { child.kill() } catch {} }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.stdin.on('error', () => {})
    child.on('error', (e) => reject(new Error('curl spawn failed: ' + String(e))))
    child.on('close', (code) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      const body = Buffer.concat(out).toString('utf8')
      if (aborted) { reject(new Error('aborted')); return }
      if (code !== 0) { reject(new Error('curl exit ' + code + ': ' + Buffer.concat(err).toString('utf8').slice(0, 300))); return }
      resolve(body)
    })
    if (opts.body != null) child.stdin.write(opts.body)
    child.stdin.end()
  })
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function kimiDeviceId() {
  const raw = readText(path.join(HOME, '.kimi-code', 'device_id')).trim()
  return raw || 'dsh-kernel-mesh'
}

function kimiServiceHeaders(extra) {
  return Object.assign({
    'user-agent': 'kimi-cli/1.49.0 (dsh-kernel-mesh)',
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': '1.49.0',
    'X-Msh-Device-Name': 'dsh-kernel-mesh',
    'X-Msh-Device-Model': process.platform === 'win32' ? 'Windows' : 'Linux',
    'X-Msh-Os-Version': 'unknown',
    'X-Msh-Device-Id': kimiDeviceId(),
  }, extra || {})
}

function loadKimiBearer() {
  try {
    const t = JSON.parse(readText(path.join(HOME, '.kimi-code', 'credentials', 'kimi-code.json')))
    if (t && typeof t.access_token === 'string' && t.access_token) return t.access_token
  } catch {}
  try {
    const cfg = readText(path.join(HOME, '.kimi-code', 'config.toml'))
    const m = /\[providers\.kimi-for-coding\]([\s\S]*?)(?=\r?\n\[|$)/.exec(cfg)
    const km = m && /api_key\s*=\s*"([^"]+)"/.exec(m[1])
    if (km && km[1]) return km[1]
  } catch {}
  return ''
}

function formatKimiSearchResults(results) {
  const rows = Array.isArray(results) ? results : []
  if (rows.length === 0) return '(no results)'
  let out = ''
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    if (i > 0) out += '---\n\n'
    out += 'Title: ' + (r.title || '') + '\nDate: ' + (r.date || '') + '\nURL: ' + (r.url || '') + '\nSummary: ' + (r.snippet || '') + '\n\n'
    if (r.content) out += r.content + '\n\n'
  }
  return out.trim() || '(no results)'
}

function kimiSearchRows(results) {
  const rows = Array.isArray(results) ? results : []
  return rows.filter((r) => r && r.url).map((r) => ({
    url: r.url,
    title: r.title || undefined,
    snippet: r.snippet || undefined,
    publishedAt: r.date || undefined,
  }))
}

async function kimiSearchNative(args, signal) {
  const key = loadKimiBearer()
  if (!key) return null
  const raw = await curlRequest({
    url: KIMI_SEARCH_URL,
    method: 'POST',
    timeoutSec: 180,
    signal,
    headers: kimiServiceHeaders({
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      'X-Msh-Tool-Call-Id': 'dsh-search',
    }),
    body: JSON.stringify({
      text_query: args.query,
      limit: args.limit || 8,
      enable_page_crawling: args.include_content === true,
      timeout_seconds: 30,
    }),
  })
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('kimi search: bad JSON') }
  return {
    text: formatKimiSearchResults(parsed && parsed.search_results),
    sources: kimiSearchRows(parsed && parsed.search_results),
  }
}

async function kimiFetchNative(url, signal) {
  const key = loadKimiBearer()
  if (key) {
    try {
      const raw = await curlRequest({
        url: KIMI_FETCH_URL,
        method: 'POST',
        timeoutSec: 180,
        signal,
        headers: kimiServiceHeaders({
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          accept: 'text/markdown',
          'X-Msh-Tool-Call-Id': 'dsh-fetch',
        }),
        body: JSON.stringify({ url }),
      })
      if (raw && raw.trim()) return raw
    } catch {}
  }
  const raw = await curlRequest({
    url,
    method: 'GET',
    timeoutSec: 180,
    signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    },
  })
  const trimmed = String(raw || '').trim()
  if (!trimmed) return '(empty body)'
  if (/^\s*</.test(trimmed)) {
    const text = htmlToText(trimmed)
    return text ? text.slice(0, 20000) : '(empty body)'
  }
  return trimmed.slice(0, 20000)
}

function loadGrokKey() {
  try {
    const auth = JSON.parse(readText(path.join(HOME, '.grok', 'auth.json')))
    const k = Object.keys(auth)[0]
    if (k && auth[k] && typeof auth[k].key === 'string') return auth[k].key
  } catch {}
  return ''
}

function grokSearchHeaders(key) {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer ' + key,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-client-mode': 'headless',
    'x-grok-client-version': '1.0.3',
    'user-agent': 'dsh-kernel-mesh/0.2.1',
  }
}

function extractGrokSearch(data) {
  const texts = []
  const links = []
  const seen = new Set()
  const pushLink = (title, url) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    links.push({ title: title || url, url })
  }
  const walk = (node) => {
    if (!node) return
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (typeof node !== 'object') return
    if ((node.type === 'output_text' || node.type === 'text') && typeof node.text === 'string') texts.push(node.text)
    if (Array.isArray(node.annotations)) {
      for (const a of node.annotations) {
        if (!a) continue
        const url = a.url || (a.type === 'url_citation' && a.url)
        if (url) pushLink(a.title, url)
      }
    }
    if (node.action && Array.isArray(node.action.sources)) {
      for (const s of node.action.sources) {
        const url = s && (s.url || (s.type === 'url' && s.url))
        if (url) pushLink(s.title, url)
      }
    }
    if (Array.isArray(node.output)) walk(node.output)
    if (Array.isArray(node.content)) walk(node.content)
  }
  walk(data)
  let out = texts.join('\n').trim()
  if (links.length) {
    out += (out ? '\n\n' : '') + 'Links:\n' + links.map((l, i) => (i + 1) + '. [' + l.title + '](' + l.url + ')').join('\n')
  }
  return { text: out || '(no results)', sources: links.map((l) => ({ url: l.url, title: l.title })) }
}

async function grokSearchNative(args, signal) {
  const key = loadGrokKey()
  if (!key) return null
  const body = {
    model: 'grok-4.6',
    input: String(args.query),
    tools: [{
      type: 'web_search',
      filters: Array.isArray(args.allowed_domains) && args.allowed_domains.length
        ? { allowed_domains: args.allowed_domains }
        : undefined,
    }],
    store: false,
    temperature: 0.1,
    top_p: 0.95,
    max_output_tokens: 2048,
  }
  if (!body.tools[0].filters) delete body.tools[0].filters
  const raw = await curlRequest({
    url: GROK_SEARCH_URL,
    method: 'POST',
    timeoutSec: 90,
    proxy: GROK_PROXY,
    signal,
    headers: grokSearchHeaders(key),
    body: JSON.stringify(body),
  })
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('grok search: bad JSON ' + String(raw).slice(0, 200)) }
  if (parsed && parsed.error) throw new Error('grok search: ' + JSON.stringify(parsed.error).slice(0, 300))
  return extractGrokSearch(parsed)
}

async function grokFetchNative(url, signal) {
  let target = String(url || '')
  if (/^http:\/\//i.test(target)) target = 'https://' + target.slice(7)
  const raw = await curlRequest({
    url: target,
    method: 'GET',
    timeoutSec: 60,
    proxy: GROK_PROXY,
    signal,
    headers: {
      'user-agent': 'dsh-kernel-mesh/0.2.1',
      accept: 'text/markdown, text/plain, text/html;q=0.8, */*;q=0.5',
    },
  })
  const trimmed = String(raw || '').trim()
  if (!trimmed) return '(empty body)'
  const text = /^\s*</.test(trimmed) ? htmlToText(trimmed) : trimmed
  if (text.length > 20000) return text.slice(0, 20000) + '\n[truncated at 20000 chars]'
  return text || '(empty body)'
}

export {
  curlRequest,
  extractGrokSearch,
  formatKimiSearchResults,
  grokFetchNative,
  grokSearchNative,
  htmlToText,
  kimiFetchNative,
  kimiSearchNative,
  loadGrokKey,
  loadKimiBearer,
}
