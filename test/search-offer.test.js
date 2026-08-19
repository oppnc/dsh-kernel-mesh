// Offline offer-gate for vendor search tools.
// A search engine is offered only when the matching surface plugin is
// installed AND that vendor's credential exists. Never assume every user
// subscribed to every kernel.

import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'
import { extractGrokSearch, formatKimiSearchResults } from '../lib/search-backends.js'

const {
  pluginInstalled, kernelSearchOffered, searchCatalog,
} = plugin._test

let assertionCount = 0
function check(value, message) {
  assertionCount += 1
  assert.ok(value, message)
}
function eq(actual, expected, message) {
  assertionCount += 1
  assert.equal(actual, expected, message)
}

function testCatalogShape() {
  const cat = searchCatalog()
  check(cat.kimi && cat.grok, 'catalog lists kimi and grok')
  eq(cat.kimi.plugin, 'dsh-kernel-kimi', 'kimi plugin id')
  eq(cat.grok.plugin, 'dsh-kernel-grok', 'grok plugin id')
  for (const kind of ['kimi', 'grok']) {
    check(typeof cat[kind].installed === 'boolean', kind + '.installed is boolean')
    check(typeof cat[kind].subscribed === 'boolean', kind + '.subscribed is boolean')
    eq(cat[kind].offered, cat[kind].installed && cat[kind].subscribed, kind + '.offered = installed && subscribed')
  }
}

function testOfferMatchesCatalog() {
  const cat = searchCatalog()
  eq(kernelSearchOffered('kimi'), cat.kimi.offered, 'kimi offer matches catalog')
  eq(kernelSearchOffered('grok'), cat.grok.offered, 'grok offer matches catalog')
  eq(kernelSearchOffered('nope'), false, 'unknown engine is never offered')
}

function testWorkspaceSiblingCountsAsInstalled() {
  // This workspace contains dsh-kernel-kimi and dsh-kernel-grok next to mesh.
  check(pluginInstalled('dsh-kernel-kimi'), 'workspace sibling dsh-kernel-kimi is installed')
  check(pluginInstalled('dsh-kernel-grok'), 'workspace sibling dsh-kernel-grok is installed')
  check(!pluginInstalled('dsh-kernel-does-not-exist'), 'missing package is not installed')
}

function testFormatters() {
  const kimi = formatKimiSearchResults([
    { title: 'A', date: '2026-01-01', url: 'https://a.example', snippet: 'alpha' },
  ])
  check(kimi.includes('https://a.example'), 'kimi formatter keeps url')
  const grok = extractGrokSearch({
    output: [{ type: 'output_text', text: 'hello', annotations: [{ type: 'url_citation', url: 'https://x.com/a', title: 'A' }] }],
  })
  eq(grok.sources[0].url, 'https://x.com/a', 'grok extractor keeps citation url')
  check(grok.text.includes('hello'), 'grok extractor keeps summary')
}

const TESTS = [
  ['catalog shape', testCatalogShape],
  ['offer matches catalog', testOfferMatchesCatalog],
  ['workspace sibling counts as installed', testWorkspaceSiblingCountsAsInstalled],
  ['formatters', testFormatters],
]

let testCount = 0
for (const [name, fn] of TESTS) {
  fn()
  testCount += 1
  console.log('  ok  ' + name)
}
console.log('ok: ' + testCount + ' tests, ' + assertionCount + ' assertions')
