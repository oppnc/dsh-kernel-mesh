// Offline offer-gate for vendor search tools.
// A search engine is offered only when the matching surface plugin is
// installed AND that vendor's credential exists. Never assume every user
// subscribed to every kernel.

import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'
import { extractGrokSearch, formatKimiSearchResults } from '../lib/search-backends.js'

const {
  pluginInstalled, kernelSearchOffered, availableSearchTools, recipeToolFilter, searchCatalog,
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
function deep(actual, expected, message) {
  assertionCount += 1
  assert.deepEqual(actual, expected, message)
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

function testAvailableToolsOnlyOffered() {
  const names = availableSearchTools()
  const cat = searchCatalog()
  if (cat.kimi.offered) {
    check(names.includes('kimi_search') && names.includes('kimi_fetch'), 'kimi tools present when offered')
  } else {
    check(!names.includes('kimi_search') && !names.includes('kimi_fetch'), 'kimi tools absent when not offered')
  }
  if (cat.grok.offered) {
    check(names.includes('grok_search') && names.includes('grok_fetch'), 'grok tools present when offered')
  } else {
    check(!names.includes('grok_search') && !names.includes('grok_fetch'), 'grok tools absent when not offered')
  }
}

function testRecipeFilterDoesNotNameMissingTools() {
  const extra = availableSearchTools()
  const recipe = { toolFilter: { allow: ['read', 'web_search'] } }
  const filter = recipeToolFilter(recipe)
  deep(filter.allow, recipe.toolFilter.allow.concat(extra), 'recipe filter appends only offered search tools when no tools registry is given')
  check(!filter.allow.includes('kimi_search') || extra.includes('kimi_search'), 'never names unoffered kimi_search')
  check(!filter.allow.includes('grok_search') || extra.includes('grok_search'), 'never names unoffered grok_search')
}

function testRecipeFilterDropsUnknownGlobals() {
  const extra = availableSearchTools()
  const recipe = { toolFilter: { allow: ['read', 'glob', 'web_search'] } }
  const known = ['read', 'web_search', 'kimi_search', 'grok_search', 'kimi_fetch', 'grok_fetch']
  const viaSchemas = recipeToolFilter(recipe, { schemas: () => known.map((name) => ({ name })) })
  check(!viaSchemas.allow.includes('glob'), 'drops glob when schemas() does not list it')
  check(viaSchemas.allow.includes('read'), 'keeps registered read via schemas()')
  const viaGet = recipeToolFilter(recipe, { get: (name) => known.includes(name) ? { name } : undefined })
  check(!viaGet.allow.includes('glob'), 'drops glob when get() says it is absent')
  check(viaGet.allow.includes('web_search'), 'keeps registered web_search via get()')
  for (const name of extra) check(viaSchemas.allow.includes(name), 'keeps offered ' + name)
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
  ['available tools only offered', testAvailableToolsOnlyOffered],
  ['recipe filter omits missing tools', testRecipeFilterDoesNotNameMissingTools],
  ['recipe filter drops unknown globals', testRecipeFilterDropsUnknownGlobals],
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
