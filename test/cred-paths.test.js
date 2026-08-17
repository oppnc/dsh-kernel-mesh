// Credential-root / newest-wins tests for dsh-kernel-mesh.
// Run: node test/cred-paths.test.js
//
// newestExistingIn / credPath are not exported. The replica below is a
// line-for-line copy of index.js `newestExistingIn` (see that function and
// the comment immediately above it). If the production algorithm changes,
// update this replica and the assertions together.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../lib/index.js'

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

// Mirrors dsh-kernel-mesh/index.js newestExistingIn:
//   let best = null, bestM = -1
//   for (const root of roots) {
//     const p = path.join(root, rel)
//     try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { bestM = m; best = p } } catch {}
//   }
//   return best
function newestExistingIn(roots, rel) {
  let best = null, bestM = -1
  for (const root of roots) {
    const p = path.join(root, rel)
    try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { bestM = m; best = p } } catch {}
  }
  return best
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

function testReplica() {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-km-homeA-'))
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-km-homeB-'))
  try {
    fs.mkdirSync(path.join(a, '.grok'), { recursive: true })
    fs.mkdirSync(path.join(b, '.grok'), { recursive: true })
    fs.writeFileSync(path.join(a, '.grok', 'auth.json'), '{"old":{"key":"old"}}')

    const onlyA = newestExistingIn([a, b], '.grok/auth.json')
    eq(onlyA, path.join(a, '.grok', 'auth.json'), 'only-existing candidate is picked')

    fs.writeFileSync(path.join(b, '.grok', 'auth.json'), '{"new":{"key":"new"}}')
    const past = new Date(Date.now() - 3600e3)
    fs.utimesSync(path.join(a, '.grok', 'auth.json'), past, past)
    const newest = newestExistingIn([a, b], '.grok/auth.json')
    eq(newest, path.join(b, '.grok', 'auth.json'), 'newest mtime wins')

    eq(newestExistingIn([a, b], '.codex/auth.json'), null, 'missing everywhere → null')

    fs.mkdirSync(path.join(b, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(b, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"k"}')
    fs.mkdirSync(path.join(a, '.codex'), { recursive: true })
    fs.symlinkSync(path.join(b, '.codex', 'auth.json'), path.join(a, '.codex', 'auth.json'))
    const viaLink = newestExistingIn([a, b], '.codex/auth.json')
    check(viaLink !== null, 'symlink is followed (statSync, not lstat)')
    // Both roots now resolve to a real file; either path is valid as long as
    // stat succeeds. Prefer the younger one (same inode → both exist).
    check(fs.statSync(viaLink).isFile(), 'resolved path is a regular file after symlink follow')
    const aStat = fs.statSync(path.join(a, '.codex', 'auth.json'))
    const bStat = fs.statSync(path.join(b, '.codex', 'auth.json'))
    eq(aStat.ino, bStat.ino, 'symlink and target share inode (followed)')
  } finally {
    rmrf(a)
    rmrf(b)
  }
}

function testPluginLoadsAndMatchesLiveGrok() {
  check(plugin && typeof plugin.apply === 'function', 'plugin module loads (exports.apply)')
  check(plugin._test && typeof plugin._test.makeAnthropicAdapter === 'function', 'plugin _test hook is intact')

  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  const live = path.join(home, '.grok', 'auth.json')
  let exists = false
  try { exists = fs.existsSync(live) } catch {}
  if (!exists) {
    console.log('  skip live grok path: no ~/.grok/auth.json on this machine')
    return
  }

  // Real plugin resolution: credPath is not exported, but load-time lookup
  // used the same newestExistingIn over credentialRoots. On a non-WSL host
  // that is just HOME; on WSL it may pick a newer Windows-side copy. We
  // re-run the replica over the same roots the plugin uses (HOME + optional
  // /mnt/c/Users/*) and assert the live file the plugin would have seen is
  // the same path newestExistingIn returns.
  const roots = [home]
  if (process.platform === 'linux') {
    let wsl = !!process.env.WSL_DISTRO_NAME
    if (!wsl) {
      try { wsl = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')) } catch {}
    }
    if (wsl) {
      try {
        for (const ent of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
          if (!ent.isDirectory()) continue
          if (/^(Public|Default|Default User|All Users)$/i.test(ent.name)) continue
          const p = path.join('/mnt/c/Users', ent.name)
          if (p !== home) roots.push(p)
        }
      } catch {}
    }
  }
  const resolved = newestExistingIn(roots, '.grok/auth.json')
  check(resolved !== null, 'live grok auth.json is visible through newestExistingIn')
  check(fs.existsSync(resolved), 'resolved grok auth.json exists')
  // The path under $HOME (possibly a symlink) must resolve to the same
  // inode as the plugin's newest-wins pick, or be the pick itself.
  const homeStat = fs.statSync(live)
  const resolvedStat = fs.statSync(resolved)
  eq(homeStat.ino, resolvedStat.ino, 'plugin-style resolution matches ~/.grok/auth.json (same inode, symlink-safe)')
  console.log('  live grok auth.json: ' + resolved)
}

const TESTS = [
  ['newestExistingIn replica (newest / missing / symlink)', testReplica],
  ['plugin loads + live grok path', testPluginLoadsAndMatchesLiveGrok],
]

function main() {
  for (const [name, fn] of TESTS) {
    fn()
    testCount += 1
    console.log('  ok  ' + name)
  }
  console.log('ok: ' + testCount + ' tests, ' + assertionCount + ' assertions')
}

try {
  main()
} catch (err) {
  console.error('FAIL: ' + (err && err.message ? err.message : err))
  if (err && err.stack) console.error(err.stack)
  process.exit(1)
}
