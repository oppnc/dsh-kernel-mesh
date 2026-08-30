// Offline wire regression suite for dsh-kernel-mesh adapters.
// Run: node test/wire.test.js
// Uses a local node:http stub only — never a real upstream.

import assert from 'node:assert/strict'
import http from 'node:http'
import * as plugin from '../lib/index.js'

const { makeAnthropicAdapter, makeResponsesAdapter, anthropicImageBlock, responsesImageBlock, buildResponsesInput, estimateTextTokens, clampKimiMaxTokens, kimiCompletionBudgetFromEnv } = plugin._test

let assertionCount = 0
let testCount = 0

function check(value, message) {
  assertionCount += 1
  assert.ok(value, message)
}

function eq(actual, expected, message) {
  assertionCount += 1
  assert.equal(actual, expected, message)
}

function deep(actual, expected, message) {
  assertionCount += 1
  try {
    assert.deepEqual(actual, expected)
  } catch (err) {
    const extra = '\n  actual:   ' + JSON.stringify(actual) + '\n  expected: ' + JSON.stringify(expected)
    throw new Error((message || 'deepEqual failed') + extra + '\n' + (err && err.message ? err.message : ''))
  }
}

function ownCode(err, code, message) {
  assertionCount += 1
  check(err instanceof Error, (message || 'error') + ': expected Error, got ' + Object.prototype.toString.call(err))
  eq(err.name, 'Error', (message || 'error') + ': should be a classified Error, not ' + err.name)
  check(Object.prototype.hasOwnProperty.call(err, 'code'), (message || 'error') + ': code must be an own property')
  eq(err.code, code, (message || 'error') + ': err.code')
  check(err.failure && typeof err.failure === 'object', (message || 'error') + ': err.failure missing')
  eq(err.failure.code, code, (message || 'error') + ': err.failure.code')
}

function fail(message) {
  throw new Error(message)
}

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) fail('timed out waiting for ' + label)
    await new Promise((r) => setTimeout(r, 8))
  }
}

function sseRecord(eventName, data, eol) {
  const nl = eol || '\n'
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  return 'event: ' + eventName + nl + 'data: ' + payload + nl + nl
}

async function writeTinyChunks(res, body, size) {
  const n = size || 11
  if (res.socket) res.socket.setNoDelay(true)
  for (let i = 0; i < body.length; i += n) {
    const ok = res.write(body.slice(i, i + n))
    if (!ok) await new Promise((r) => res.once('drain', r))
    await new Promise((r) => setTimeout(r, 3))
  }
}

function startStub(respond) {
  const requests = []
  const server = http.createServer((req, res) => {
    const acc = []
    req.on('data', (c) => acc.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(acc).toString('utf8')
      let json = null
      try { json = JSON.parse(raw) } catch {}
      const rec = { method: req.method, url: req.url, headers: req.headers, raw, json }
      requests.push(rec)
      Promise.resolve(respond(rec, res)).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
        try { res.end(String(e && e.stack ? e.stack : e)) } catch {}
      })
    })
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        url: 'http://127.0.0.1:' + addr.port + '/v1',
        requests,
        close() {
          return new Promise((r) => server.close(() => r()))
        },
      })
    })
    server.on('error', reject)
  })
}

async function collect(gen) {
  const events = []
  for await (const ev of gen) events.push(ev)
  return events
}

async function collectThrow(gen) {
  const events = []
  try {
    for await (const ev of gen) events.push(ev)
    fail('expected adapter to throw, but it completed with ' + events.length + ' events')
  } catch (error) {
    if (error && error.message && error.message.startsWith('expected adapter to throw')) throw error
    return { events, error }
  }
}

function anthropicAdapter(url, extra) {
  return makeAnthropicAdapter(Object.assign({
    tag: 'anthropic-test',
    name: 'Anthropic stub',
    url,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    models: [{ id: 'stub-model', name: 'Stub', contextWindow: 8000, defaultMaxTokens: 4096 }],
    replayThinking: true,
    thinkingFor: () => null,
    proxy: null,
  }, extra || {}))
}

function responsesAdapter(url, extra) {
  return makeResponsesAdapter(Object.assign({
    tag: 'responses-test',
    name: 'Responses stub',
    url,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    models: [{ id: 'stub-model', name: 'Stub', contextWindow: 8000, defaultMaxTokens: 4096 }],
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    defaultEffort: 'high',
    proxy: null,
  }, extra || {}))
}

const USER_HI = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

function jsonHeaders(res, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json',
    Connection: 'close',
  })
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    'X-Accel-Buffering': 'no',
  })
  if (res.socket) res.socket.setNoDelay(true)
}

// ---------- 1. Anthropic SSE (tiny flushed chunks + incremental parse) ----------

const ANTHROPIC_JSON = {
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Thinking' },
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' } },
  ],
  stop_reason: 'tool_use',
  usage: {
    input_tokens: 100,
    output_tokens: 25,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
  },
}

const ANTHROPIC_SSE_EVENTS = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'Think' },
  { type: 'reasoning-delta', index: 0, text: 'ing' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Thinking' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: 'Hello' },
  { type: 'text-delta', index: 1, text: ' world' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' } },
  { type: 'block-start', index: 2, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'bash', argumentsDelta: '' },
  { type: 'tool-call-delta', index: 2, argumentsDelta: '{"cmd"' },
  { type: 'tool-call-delta', index: 2, argumentsDelta: ':"ls"}' },
  { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' } },
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

async function testAnthropicSse() {
  let releaseRest = () => {}
  const restGate = new Promise((r) => { releaseRest = r })
  let firstSent = () => {}
  const firstPartDone = new Promise((r) => { firstSent = r })

  const first = [
    sseRecord('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 0,
        },
      },
    }),
    sseRecord('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Think' },
    }),
    sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'ing' },
    }),
    sseRecord('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ].join('')

  const rest = [
    sseRecord('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Hello' },
    }),
    sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: ' world' },
    }),
    sseRecord('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseRecord('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
    }),
    sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"cmd"' },
    }),
    sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: ':"ls"}' },
    }),
    sseRecord('content_block_stop', { type: 'content_block_stop', index: 2 }),
    sseRecord('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 25 },
    }),
    sseRecord('message_stop', { type: 'message_stop' }),
  ].join('')

  const stub = await startStub(async (_rec, res) => {
    sseHeaders(res)
    await writeTinyChunks(res, first, 7)
    firstSent()
    await restGate
    await writeTinyChunks(res, rest, 7)
    res.end()
  })

  const events = []
  try {
    const adapter = anthropicAdapter(stub.url)
    const consume = (async () => {
      for await (const ev of adapter.stream({ model: 'stub-model', messages: USER_HI, maxTokens: 4096 })) {
        events.push(ev)
      }
    })()
    await firstPartDone
    await waitFor(
      () => events.some((e) => e.type === 'block-end' && e.block && e.block.type === 'reasoning'),
      4000,
      'incremental reasoning block-end before the stub finished the body',
    )
    check(events.length >= 4, 'incremental parse yielded reasoning events mid-stream')
    eq(events[events.length - 1].type, 'block-end', 'last mid-stream event is thinking block-end')
    releaseRest()
    await consume
    deep(events, ANTHROPIC_SSE_EVENTS, 'anthropic SSE event sequence')
    check(stub.requests.length === 1, 'anthropic SSE: one request')
    eq(stub.requests[0].json.stream, true, 'anthropic SSE request sets stream:true')
  } finally {
    releaseRest()
    await stub.close()
  }
}

// ---------- 2. Anthropic JSON fallback ----------

function anthropicNonStreamingEvents(resp) {
  // Mirrors emitNonStreamingResponse in index.js — used as the equality oracle.
  const content = Array.isArray(resp.content) ? resp.content : []
  const out = []
  let index = 0
  let toolCalls = false
  let emittedBlocks = 0
  for (const b of content) {
    if (b.type === 'thinking') {
      out.push({ type: 'block-start', index, blockType: 'reasoning' })
      out.push({ type: 'reasoning-delta', index, text: b.thinking || '' })
      out.push({ type: 'block-end', index, block: { type: 'reasoning', text: b.thinking || '' } })
      index += 1
      emittedBlocks += 1
    } else if (b.type === 'text') {
      out.push({ type: 'block-start', index, blockType: 'text' })
      out.push({ type: 'text-delta', index, text: b.text || '' })
      out.push({ type: 'block-end', index, block: { type: 'text', text: b.text || '' } })
      index += 1
      emittedBlocks += 1
    } else if (b.type === 'tool_use') {
      toolCalls = true
      const args = JSON.stringify(b.input || {})
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index, id: b.id, name: b.name, argumentsDelta: args })
      out.push({ type: 'block-end', index, block: { type: 'tool-call', id: b.id, name: b.name, arguments: args } })
      index += 1
      emittedBlocks += 1
    }
  }
  const uIn = resp.usage || {}
  const cachedRead = uIn.cache_read_input_tokens || 0
  const usage = { inputTokens: uIn.input_tokens || 0, outputTokens: uIn.output_tokens || 0 }
  if (cachedRead > 0) usage.cacheReadTokens = cachedRead
  if (uIn.cache_creation_input_tokens) usage.cacheWriteTokens = uIn.cache_creation_input_tokens
  out.push({ type: 'usage', usage })
  if (resp.stop_reason === 'max_tokens') out.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  else if (toolCalls) out.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  else if (emittedBlocks === 0) {
    out.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'provider returned an empty response', code: 'EMPTY_RESPONSE' } } })
  } else out.push({ type: 'finish', reason: { kind: 'stop' } })
  return out
}

async function testAnthropicJsonFallback() {
  const stub = await startStub((_rec, res) => {
    jsonHeaders(res)
    res.end(JSON.stringify(ANTHROPIC_JSON))
  })
  try {
    const adapter = anthropicAdapter(stub.url)
    const events = await collect(adapter.stream({ model: 'stub-model', messages: USER_HI, maxTokens: 4096 }))
    deep(events, anthropicNonStreamingEvents(ANTHROPIC_JSON), 'anthropic JSON fallback == non-streaming translation')
    check(stub.requests.length === 1, 'anthropic JSON: one request')
    eq(stub.requests[0].json.stream, true, 'anthropic JSON fallback still sends stream:true')
  } finally {
    await stub.close()
  }
}

// ---------- 3. Anthropic role filtering + same-role merge ----------

async function testAnthropicRoleFilter() {
  const stub = await startStub((_rec, res) => {
    jsonHeaders(res)
    res.end(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
  })
  try {
    const adapter = anthropicAdapter(stub.url, { replayThinking: true })
    await collect(adapter.stream({
      model: 'stub-model',
      maxTokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'reasoning', text: 'user should not think on the wire' },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"a":1}' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'more' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I think' },
            { type: 'text', text: 'ok' },
            { type: 'tool-call', id: 'c2', name: 'read', arguments: '{"p":"f"}' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'file' }] }],
        },
      ],
    }))
    const body = stub.requests[0].json
    check(Array.isArray(body.messages), 'wire messages present')
    eq(body.messages.length, 3, 'consecutive same-role user turns merge; 3 wire messages')
    deep(body.messages[0], {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'more' },
      ],
    }, 'user reasoning/tool-call dropped; consecutive users merged')
    deep(body.messages[1], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I think' },
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'c2', name: 'read', input: { p: 'f' } },
      ],
    }, 'assistant keeps thinking + tool_use')
    deep(body.messages[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'file' }],
    }, 'tool_result stays on the following user turn')
    const dumped = JSON.stringify(body.messages)
    check(!/user should not think/.test(dumped), 'user reasoning text must not appear on the wire')
    check(!/"id":"c1"/.test(dumped), 'user tool-call must not appear on the wire')
  } finally {
    await stub.close()
  }
}

// ---------- 4. tool_use start-input vs deltas ----------

function toolUseSse(startInput, deltas) {
  const parts = [
    sseRecord('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    sseRecord('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'fn', input: startInput },
    }),
  ]
  for (const piece of deltas) {
    parts.push(sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: piece },
    }))
  }
  parts.push(sseRecord('content_block_stop', { type: 'content_block_stop', index: 0 }))
  parts.push(sseRecord('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 2 },
  }))
  parts.push(sseRecord('message_stop', { type: 'message_stop' }))
  return parts.join('')
}

async function testToolUseStartVsDeltas() {
  const stub = await startStub((rec, res) => {
    sseHeaders(res)
    const mode = rec.json && rec.json.system
    if (mode === 'start-only') res.end(toolUseSse({ foo: 'bar' }, []))
    else res.end(toolUseSse({ foo: 'bar' }, ['{"x":', '1}']))
  })
  try {
    const adapter = anthropicAdapter(stub.url)

    const startOnly = await collect(adapter.stream({
      model: 'stub-model',
      system: 'start-only',
      messages: USER_HI,
      maxTokens: 4096,
    }))
    const startEnd = startOnly.find((e) => e.type === 'block-end')
    check(startEnd, 'start-only produced block-end')
    eq(startEnd.block.arguments, JSON.stringify({ foo: 'bar' }), 'complete start input is stringified when no deltas')

    const withDeltas = await collect(adapter.stream({
      model: 'stub-model',
      system: 'with-deltas',
      messages: USER_HI,
      maxTokens: 4096,
    }))
    const deltaEnd = withDeltas.find((e) => e.type === 'block-end')
    check(deltaEnd, 'delta path produced block-end')
    eq(deltaEnd.block.arguments, '{"x":1}', 'deltas win; start input is not concatenated')
    check(deltaEnd.block.arguments.indexOf('foo') === -1, 'start input must not leak into arguments when deltas exist')
  } finally {
    await stub.close()
  }
}

// ---------- 5. Anthropic JSON error shapes ----------

async function testAnthropicJsonErrors() {
  const stub = await startStub((rec, res) => {
    const kind = rec.json && rec.json.system
    if (kind === 'rate') {
      jsonHeaders(res)
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
    } else if (kind === 'auth') {
      jsonHeaders(res, 401)
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }))
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain', Connection: 'close' })
      res.end('upstream blew up <html>not-json')
    }
  })
  try {
    const adapter = anthropicAdapter(stub.url)

    const rate = await collectThrow(adapter.stream({
      model: 'stub-model', system: 'rate', messages: USER_HI, maxTokens: 1024,
    }))
    ownCode(rate.error, 'RATE_LIMIT', 'top-level type:error / rate_limit_error')

    const auth = await collectThrow(adapter.stream({
      model: 'stub-model', system: 'auth', messages: USER_HI, maxTokens: 1024,
    }))
    ownCode(auth.error, 'AUTH', '401 authentication_error without top-level type')

    const bad = await collectThrow(adapter.stream({
      model: 'stub-model', system: 'junk', messages: USER_HI, maxTokens: 1024,
    }))
    ownCode(bad.error, 'SERVER', 'unparseable body')
  } finally {
    await stub.close()
  }
}

// ---------- 6. Responses SSE + [DONE] + CRLF + nothing after finish ----------

function responsesNonStreamingEvents(resp) {
  // Mirrors translateFullResponse in index.js.
  const items = Array.isArray(resp && resp.output) ? resp.output : []
  const out = []
  let index = 0
  let toolCalls = false
  let emittedBlocks = 0
  for (const item of items) {
    if (item.type === 'reasoning') {
      const t = (item.summary || []).map((s) => s.text || '').join('\n').trim()
      if (!t) continue
      out.push({ type: 'block-start', index, blockType: 'reasoning' })
      out.push({ type: 'reasoning-delta', index, text: t })
      out.push({ type: 'block-end', index, block: { type: 'reasoning', text: t } })
      index += 1
      emittedBlocks += 1
    } else if (item.type === 'message') {
      for (const c of item.content || []) {
        const t = c.type === 'output_text' ? c.text : c.type === 'refusal' ? c.refusal : ''
        if (!t) continue
        out.push({ type: 'block-start', index, blockType: 'text' })
        out.push({ type: 'text-delta', index, text: t })
        out.push({ type: 'block-end', index, block: { type: 'text', text: t } })
        index += 1
        emittedBlocks += 1
      }
    } else if (item.type === 'function_call') {
      toolCalls = true
      const args = item.arguments || '{}'
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index, id: item.call_id, name: item.name, argumentsDelta: args })
      out.push({ type: 'block-end', index, block: { type: 'tool-call', id: item.call_id, name: item.name, arguments: args } })
      index += 1
      emittedBlocks += 1
    }
  }
  const usage = (resp && resp.usage) || {}
  const cached = usage.input_tokens_details && usage.input_tokens_details.cached_tokens
    ? usage.input_tokens_details.cached_tokens
    : 0
  const u = { inputTokens: Math.max(0, (usage.input_tokens || 0) - cached), outputTokens: usage.output_tokens || 0 }
  if (cached > 0) u.cacheReadTokens = cached
  if (usage.cache_creation_input_tokens) u.cacheWriteTokens = usage.cache_creation_input_tokens
  out.push({ type: 'usage', usage: u })
  if (resp && resp.status === 'incomplete' && resp.incomplete_details && resp.incomplete_details.reason === 'max_output_tokens') {
    out.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  } else if (toolCalls) out.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  else if (emittedBlocks === 0) {
    out.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'provider returned an empty response', code: 'EMPTY_RESPONSE' } } })
  } else out.push({ type: 'finish', reason: { kind: 'stop' } })
  return out
}

const RESPONSES_SSE_EXPECTED = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Hel' },
  { type: 'text-delta', index: 0, text: 'lo' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: 'call_9', name: 'bash', argumentsDelta: '{"c"' },
  { type: 'tool-call-delta', index: 1, id: 'call_9', name: 'bash', argumentsDelta: ':1}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_9', name: 'bash', arguments: '{"c":1}' } },
  {
    type: 'usage',
    usage: { inputTokens: 30, outputTokens: 12, cacheReadTokens: 20 },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

async function testResponsesSse() {
  const crlf = '\r\n'
  const body = [
    sseRecord('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', status: 'in_progress', content: [] },
    }, crlf),
    sseRecord('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      delta: 'Hel',
    }, crlf),
    sseRecord('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      delta: 'lo',
    }, crlf),
    sseRecord('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
    }, crlf),
    sseRecord('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '' },
    }, crlf),
    sseRecord('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 1,
      call_id: 'call_9',
      name: 'bash',
      delta: '{"c"',
    }, crlf),
    sseRecord('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 1,
      call_id: 'call_9',
      name: 'bash',
      delta: ':1}',
    }, crlf),
    sseRecord('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"c":1}' },
    }, crlf),
    sseRecord('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: {
          input_tokens: 50,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 20 },
        },
        output: [],
      },
    }, crlf),
    // After finish: must be dropped (state.finished). Placed BEFORE [DONE]
    // so the SSE machine still dispatches the record.
    sseRecord('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_late',
      delta: 'SHOULD_NOT_EMIT',
    }, crlf),
    'data: [DONE]' + crlf + crlf,
  ].join('')

  const stub = await startStub(async (_rec, res) => {
    sseHeaders(res)
    await writeTinyChunks(res, body, 13)
    res.end()
  })
  try {
    const adapter = responsesAdapter(stub.url)
    const events = await collect(adapter.stream({ model: 'stub-model', messages: USER_HI, maxTokens: 4096 }))
    deep(events, RESPONSES_SSE_EXPECTED, 'responses SSE event sequence')
    check(!events.some((e) => e.text === 'SHOULD_NOT_EMIT'), 'nothing after finish / response.completed')
    const finishAt = events.findIndex((e) => e.type === 'finish')
    eq(finishAt, events.length - 1, 'finish is the last event')
    eq(events[finishAt - 1].type, 'usage', 'usage immediately precedes finish')
    eq(events.find((e) => e.type === 'usage').usage.inputTokens, 30, 'inputTokens = input - cached')
    eq(events.find((e) => e.type === 'usage').usage.cacheReadTokens, 20, 'cacheReadTokens = cached')
  } finally {
    await stub.close()
  }
}

// ---------- 7. Responses JSON fallback + error taxonomy ----------

const RESPONSES_JSON = {
  id: 'resp_json',
  status: 'completed',
  output: [
    {
      type: 'message',
      content: [
        { type: 'output_text', text: 'visible' },
        { type: 'refusal', refusal: 'nope' },
      ],
    },
    {
      type: 'reasoning',
      summary: [{ text: 'part A' }, { text: 'part B' }],
    },
    {
      type: 'function_call',
      call_id: 'c1',
      name: 'grep',
      arguments: '{"q":"x"}',
    },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    input_tokens_details: { cached_tokens: 2 },
  },
}

async function testResponsesFallback() {
  const stub = await startStub((rec, res) => {
    const kind = rec.json && rec.json.input && rec.json.input[0] && rec.json.input[0].content
    jsonHeaders(res)
    if (kind === 'rate') {
      res.end(JSON.stringify({
        error: { type: 'invalid_request_error', code: 'rate_limit_exceeded', message: '429' },
      }))
    } else if (kind === 'quota') {
      res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'paid plan' } }))
    } else {
      res.end(JSON.stringify(RESPONSES_JSON))
    }
  })
  try {
    const adapter = responsesAdapter(stub.url)

    const events = await collect(adapter.stream({
      model: 'stub-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
      maxTokens: 4096,
    }))
    deep(events, responsesNonStreamingEvents(RESPONSES_JSON), 'responses JSON fallback == non-streaming translation')
    const reasoning = events.find((e) => e.type === 'block-end' && e.block && e.block.type === 'reasoning')
    eq(reasoning.block.text, 'part A\npart B', 'reasoning summary parts joined by \\n')
    eq(stub.requests[0].json.stream, true, 'responses fallback still sends stream:true')

    const rate = await collectThrow(adapter.stream({
      model: 'stub-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'rate' }] }],
      maxTokens: 1024,
    }))
    ownCode(rate.error, 'RATE_LIMIT', 'code rate_limit_exceeded wins over type invalid_request_error')

    const quota = await collectThrow(adapter.stream({
      model: 'stub-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'quota' }] }],
      maxTokens: 1024,
    }))
    ownCode(quota.error, 'QUOTA', 'insufficient_quota')
  } finally {
    await stub.close()
  }
}

// ---------- 8. Responses SSE error / response.failed (not ReferenceError) ----------

async function testResponsesSseErrors() {
  const stub = await startStub((rec, res) => {
    sseHeaders(res)
    const kind = rec.json && rec.json.input && rec.json.input[0] && rec.json.input[0].content
    if (kind === 'event-error') {
      res.end(sseRecord('error', {
        type: 'error',
        error: { type: 'api_error', message: 'boom' },
      }))
    } else {
      res.end(sseRecord('response.failed', {
        type: 'response.failed',
        response: { error: { type: 'rate_limit_error', message: 'later' } },
      }))
    }
  })
  try {
    const adapter = responsesAdapter(stub.url)

    const evErr = await collectThrow(adapter.stream({
      model: 'stub-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'event-error' }] }],
      maxTokens: 1024,
    }))
    check(evErr.error.name !== 'ReferenceError', 'event: error must not throw ReferenceError (got ' + evErr.error.name + ': ' + evErr.error.message + ')')
    ownCode(evErr.error, 'SERVER', 'event: error / api_error')

    const failed = await collectThrow(adapter.stream({
      model: 'stub-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'failed' }] }],
      maxTokens: 1024,
    }))
    check(failed.error.name !== 'ReferenceError', 'response.failed must not throw ReferenceError (got ' + failed.error.name + ': ' + failed.error.message + ')')
    ownCode(failed.error, 'RATE_LIMIT', 'response.failed unwraps response.error')
  } finally {
    await stub.close()
  }
}

// ---------- 9. Images ----------

async function testImages() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
  const b64 = png.toString('base64')

  const carried = await anthropicImageBlock(
    { type: 'image', attachment: 'att_1' },
    {
      attachments: {
        async readImage(id) {
          eq(id, 'att_1', 'readImage receives the attachment id')
          return { data: png, ref: { mediaType: 'image/png' } }
        },
      },
    },
  )
  deep(carried, {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: b64 },
  }, 'anthropicImageBlock with attachments.readImage')

  const missing = await anthropicImageBlock({ type: 'image', attachment: 'att_x' }, {})
  eq(missing, null, 'no attachments service → skip the image block')

  const stub = await startStub((_rec, res) => {
    jsonHeaders(res)
    res.end(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'saw it' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
  })
  try {
    const adapter = anthropicAdapter(stub.url, {
      attachments: {
        async readImage() {
          return { data: png, ref: { mediaType: 'image/png' } }
        },
      },
    })
    await collect(adapter.stream({
      model: 'stub-model',
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment: 'att_1' },
        ],
      }],
    }))
    const msgs = stub.requests[0].json.messages
    check(msgs && msgs[0] && Array.isArray(msgs[0].content), 'e2e image: user content on the wire')
    const img = msgs[0].content.find((b) => b && b.type === 'image')
    deep(img, {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: b64 },
    }, 'e2e: base64 image block on the Anthropic wire')
  } finally {
    await stub.close()
  }

  // Responses wire: input_image content part.
  const carriedResp = await responsesImageBlock(
    { type: 'image', attachment: 'att_1' },
    {
      attachments: {
        async readImage(id) {
          eq(id, 'att_1', 'responses readImage receives the attachment id')
          return { data: png, ref: { mediaType: 'image/png' } }
        },
      },
    },
  )
  deep(carriedResp, {
    type: 'input_image',
    image_url: 'data:image/png;base64,' + b64,
  }, 'responsesImageBlock with attachments.readImage')

  const missingResp = await responsesImageBlock({ type: 'image', attachment: 'att_x' }, {})
  eq(missingResp, null, 'responses: no attachments service → skip the image block')

  const inputNoImage = await buildResponsesInput('sys', [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ], {})
  deep(inputNoImage[1], { type: 'message', role: 'user', content: 'hi' }, 'responses: text-only user keeps single-string content shape')

  const stubResp = await startStub((_rec, res) => {
    jsonHeaders(res)
    res.end(JSON.stringify({
      id: 'resp_img',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'saw it' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
  })
  try {
    const adapter = responsesAdapter(stubResp.url, {
      attachments: {
        async readImage() {
          return { data: png, ref: { mediaType: 'image/png' } }
        },
      },
    })
    await collect(adapter.stream({
      model: 'stub-model',
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment: 'att_1' },
        ],
      }],
    }))
    const input = stubResp.requests[0].json.input
    check(Array.isArray(input), 'e2e responses image: input list on the wire')
    const userMsg = input.find((it) => it && it.type === 'message' && it.role === 'user')
    check(userMsg && Array.isArray(userMsg.content), 'e2e responses image: user content is a parts array')
    const imgPart = userMsg.content.find((p) => p && p.type === 'input_image')
    deep(imgPart, {
      type: 'input_image',
      image_url: 'data:image/png;base64,' + b64,
    }, 'e2e: input_image content part on the Responses wire')
    const textPart = userMsg.content.find((p) => p && p.type === 'input_text')
    deep(textPart, { type: 'input_text', text: 'look' }, 'e2e: text part rides alongside the image')
  } finally {
    await stubResp.close()
  }
}

// ---------- 10. kimi-cli 1.49 completion-token clamp ----------

async function testKimiClamp() {
  eq(estimateTextTokens('abcd'), 1, '4 ascii chars → 1 token')
  eq(estimateTextTokens('你好'), 2, 'non-ascii is 1 token per char')
  eq(kimiCompletionBudgetFromEnv({}).mode, 'auto', 'missing env → auto')
  eq(kimiCompletionBudgetFromEnv({ KIMI_MODEL_MAX_COMPLETION_TOKENS: '0' }).mode, 'off', '0 disables clamp')
  eq(kimiCompletionBudgetFromEnv({ KIMI_MODEL_MAX_TOKENS: '8000' }).value, 8000, 'alias env is a hard cap')

  const long = {
    system: 'x'.repeat(8000),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(8000) }] }],
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
  }
  const clamped = clampKimiMaxTokens(long, 5000, 8000, {})
  check(clamped >= 1 && clamped < 8000, 'long request clamps below the requested budget, got ' + clamped)
  eq(clampKimiMaxTokens(long, 5000, 8000, { KIMI_MODEL_MAX_TOKENS: '0' }), 8000, 'env 0 keeps the requested budget')
  eq(clampKimiMaxTokens({ messages: [] }, 0, 4096, {}), 4096, 'unknown context window uses requested/fallback')

  const stub = await startStub((_rec, res) => {
    jsonHeaders(res)
    res.end(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
  })
  try {
    const adapter = anthropicAdapter(stub.url, {
      clampToRemainingContext: true,
      models: [{ id: 'stub-model', name: 'Stub', contextWindow: 3000, defaultMaxTokens: 8000 }],
    })
    await collect(adapter.stream({
      model: 'stub-model',
      maxTokens: 8000,
      system: 'z'.repeat(4000),
      messages: USER_HI,
    }))
    const sent = stub.requests[0].json.max_tokens
    check(typeof sent === 'number' && sent >= 1 && sent < 8000, 'adapter sends clamped max_tokens, got ' + sent)
  } finally {
    await stub.close()
  }
}

// ---------- runner ----------

// dsh-llm >= 0.1.1-rc.2 calls adapter.prepareCall(provider, model, signal) on
// the exact-model path; a missing method fails every turn with
// "registration.adapter.prepareCall is not a function". Assert the contract on
// both factories offline (no network: the stream entry point is never invoked).
async function testPrepareCallContract() {
  for (const [label, adapter] of [['anthropic', anthropicAdapter('http://127.0.0.1:1/unused')], ['responses', responsesAdapter('http://127.0.0.1:1/unused')]]) {
    check(typeof adapter.prepareCall === 'function', label + ' adapter exposes prepareCall (dsh-llm 0.1.1-rc.2 contract)')
    const prepared = await adapter.prepareCall('stub-provider', 'stub-model')
    check(prepared && typeof prepared === 'object', label + ' prepareCall resolves to an object')
    check(prepared.model && prepared.model.provider === 'stub-provider' && prepared.model.id === 'stub-model', label + ' prepareCall returns resolved model info')
    check(typeof prepared.stream === 'function', label + ' prepareCall returns a stream entry point')
  }
}

// ---------- 11. kimi-code 0.39.1 wire body shape ----------

async function testKimi039Body() {
  const stub = await startStub((_rec, res) => {
    jsonHeaders(res)
    res.end(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
  })
  try {
    const adapter = anthropicAdapter(stub.url + '?beta=true', {
      clampToRemainingContext: true,
      clampHardCap: 128000,
      systemCacheControl: true,
      models: [{ id: 'k3-256k', name: 'Kimi K3-256K', contextWindow: 262144, defaultMaxTokens: 131072 }],
      thinkingFor: () => ({ type: 'enabled' }),
      extraBodyFor: (model, effort) => ({
        output_config: { effort: ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(effort) >= 0 ? effort : 'high' },
        context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
        metadata: { user_id: 'session_test-uuid' },
      }),
    })
    await collect(adapter.stream({
      model: 'k3-256k',
      reasoningEffort: 'xhigh',
      system: 'sys',
      messages: USER_HI,
    }))
    const j = stub.requests[0].json
    deep(j.thinking, { type: 'enabled' }, '0.39.1 thinking is a bare enabled block (no budget_tokens)')
    deep(j.output_config, { effort: 'xhigh' }, '0.39.1 output_config carries the reasoning effort')
    deep(j.context_management, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }, '0.39.1 context_management edits')
    deep(j.metadata, { user_id: 'session_test-uuid' }, '0.39.1 metadata.user_id')
    deep(j.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], '0.39.1 system is one cached text block')
    eq(j.max_tokens, 128000, 'small request sends the 128000 hard cap (FALLBACK_MAX_TOKENS)')

    // default/unknown effort collapses to high
    await collect(adapter.stream({ model: 'k3-256k', system: 's', messages: USER_HI }))
    eq(stub.requests[1].json.output_config.effort, 'high', 'unknown effort maps to high')

    // session-title: no thinking and NO extras
    await collect(adapter.stream({ model: 'k3-256k', purpose: 'session-title', system: 's', messages: USER_HI }))
    const t = stub.requests[2].json
    check(!('thinking' in t), 'session-title sends no thinking block')
    check(!('output_config' in t), 'session-title sends no output_config')
    check(!('context_management' in t), 'session-title sends no context_management')
    check(!('metadata' in t), 'session-title sends no metadata')
  } finally {
    await stub.close()
  }
}

const TESTS = [
  ['0 adapter prepareCall contract (dsh-llm 0.1.1-rc.2)', testPrepareCallContract],
  ['1 anthropic SSE (tiny chunks, incremental)', testAnthropicSse],
  ['2 anthropic JSON fallback', testAnthropicJsonFallback],
  ['3 anthropic role filter + merge', testAnthropicRoleFilter],
  ['4 anthropic tool_use start vs deltas', testToolUseStartVsDeltas],
  ['5 anthropic JSON error shapes', testAnthropicJsonErrors],
  ['6 responses SSE + [DONE] + CRLF', testResponsesSse],
  ['7 responses JSON fallback + errors', testResponsesFallback],
  ['8 responses SSE error / response.failed', testResponsesSseErrors],
  ['9 images (anthropic + responses)', testImages],
  ['10 kimi 1.49 completion clamp', testKimiClamp],
  ['11 kimi-code 0.39.1 wire body shape', testKimi039Body],
]

async function main() {
  check(plugin && plugin._test, '_test named export is present')
  check(typeof makeAnthropicAdapter === 'function', 'makeAnthropicAdapter exported')
  check(typeof makeResponsesAdapter === 'function', 'makeResponsesAdapter exported')
  check(typeof anthropicImageBlock === 'function', 'anthropicImageBlock exported')
  check(typeof responsesImageBlock === 'function', 'responsesImageBlock exported')
  check(typeof buildResponsesInput === 'function', 'buildResponsesInput exported')

  for (const [name, fn] of TESTS) {
    await fn()
    testCount += 1
    console.log('  ok  ' + name)
  }
  console.log('ok: ' + testCount + ' tests, ' + assertionCount + ' assertions')
}

const watchdog = setTimeout(() => {
  console.error('FAIL: wire.test.js timed out')
  process.exit(1)
}, 45000)

main().then(() => {
  clearTimeout(watchdog)
}).catch((err) => {
  clearTimeout(watchdog)
  console.error('FAIL: ' + (err && err.message ? err.message : err))
  if (err && err.stack) console.error(err.stack)
  process.exit(1)
})
