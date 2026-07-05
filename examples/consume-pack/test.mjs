// Headless proof that a static `kbot pack` extraction drives the packaged
// @coreprime/kbot-game3d renderer end-to-end with NO studio server:
//
//   kbot pack <install> <dir>   →   static HTTP   →   HttpPackProvider
//                                                        ↓
//                                        createWorld(canvas, { assets })
//
// Serves the pack directory from a throwaway node HTTP server, bundles
// browser-entry.mjs (resolving @coreprime/kbot-game3d from THIS directory's
// node_modules — i.e. the packaged artifact), loads it into headless
// Chromium and asserts:
//   1. unitDB() returns the ARM commander's movement class + build fields.
//   2. The commander renders NON-BLANK and TEXTURED (a real texture's
//      colour variety, far beyond a flat-shaded fixture).
//   3. Team colours apply: side-1 (blue) vs side-2 (red) frames differ,
//      and the red frame is redder relative to blue.
//
// Expects to run from a scratch directory containing:
//   node_modules/@coreprime/kbot-game3d   (installed tarball or npmjs package)
//   node_modules/esbuild, node_modules/playwright (+ chromium installed)
//   browser-entry.mjs, test.mjs (copied from examples/consume-pack)
// with the pack directory path in the PACK_DIR env var (or argv[2]).

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, 'package.json'))
const esbuild = require('esbuild')
const { chromium } = require('playwright')

const packDir = path.resolve(process.env.PACK_DIR || process.argv[2] || '')
assert.ok(packDir, 'pass the pack directory via PACK_DIR or argv')
await stat(path.join(packDir, 'manifest.json'))

// ── Static pack server ──
// Content types cover everything a pack ships; CORS headers because the
// proof page runs on about:blank (a null origin).
const MIME = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.md': 'text/markdown',
}
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost/').pathname).replace(/^\/+/, '')
    const full = path.join(packDir, rel)
    if (!full.startsWith(packDir + path.sep)) throw new Error('outside pack')
    const body = await readFile(full)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const packUrl = `http://127.0.0.1:${server.address().port}/`
console.log(`serving pack ${packDir} at ${packUrl}`)

const bundle = await esbuild.build({
  entryPoints: [path.join(here, 'browser-entry.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  absWorkingDir: here,
})
const script = bundle.outputFiles[0].text

// SwiftShader keeps WebGL available with no GPU on the runner.
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage()
  page.on('console', (msg) => console.log(`[page:${msg.type()}]`, msg.text()))
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ content: `window.__PACK_URL = ${JSON.stringify(packUrl)}` })
  await page.addScriptTag({ content: script })
  const result = await page.evaluate(() => window.__proof)

  console.log('empty frame:', JSON.stringify(result.emptyFrame))
  console.log('blue frame :', JSON.stringify(result.blueFrame))
  console.log('red frame  :', JSON.stringify(result.redFrame))

  // 1. unitDB(): the commander's decode-critical fields are present.
  const db = result.unitDB
  assert.ok(Array.isArray(db.units) && db.units.length > 0, 'unitDB has no units')
  assert.ok(db.gameUnitCount >= db.unitCount, 'gameUnitCount must cover the full install')
  const com = db.units.find((u) => u.name === 'armcom')
  assert.ok(com, 'unitDB is missing armcom')
  assert.ok(com.movementClass && com.movementClass.length > 0, 'armcom.movementClass missing')
  assert.equal(com.motionDomain, 'ground', 'armcom motionDomain')
  assert.ok(com.meta.buildTime > 0, 'armcom buildTime missing')
  assert.ok(com.meta.maxDamage > 0, 'armcom maxDamage missing')
  assert.ok(com.id > 0, 'armcom pack ordinal missing')
  console.log(`unitDB OK: armcom id=${com.id} movementClass=${com.movementClass} ` +
    `buildTime=${com.meta.buildTime} maxDamage=${com.meta.maxDamage} ` +
    `(${db.unitCount}/${db.gameUnitCount} units)`)

  // 2. The commander renders non-blank and TEXTURED. A real GAF texture
  //    set produces hundreds of distinct frame colours; the flat
  //    sky/ground pass alone stays far below that.
  assert.ok(result.emptyFrame.mean > 0 && result.emptyFrame.spread > 0, 'empty scene is an unpainted buffer')
  assert.equal(result.emptyStats.total, 0, 'expected zero entities before addUnit')
  assert.equal(result.unitStats.total, 1, 'expected one entity after addUnit')
  assert.ok(result.blueFrame.spread > 30, `unit frame is blank (spread ${result.blueFrame.spread})`)
  assert.ok(
    result.blueFrame.distinctColors > result.emptyFrame.distinctColors + 150,
    `unit frame not textured: ${result.emptyFrame.distinctColors} -> ${result.blueFrame.distinctColors} colours`,
  )

  // 3. Team colours: the two sides' frames differ, and the red side's
  //    red-vs-blue balance shifts red relative to the blue side's.
  const balance = (f) => f.meanR - f.meanB
  console.log(`team balance: blue=${balance(result.blueFrame).toFixed(3)} red=${balance(result.redFrame).toFixed(3)}`)
  assert.ok(
    balance(result.redFrame) > balance(result.blueFrame) + 0.5,
    `team colours did not apply (blue ${balance(result.blueFrame)}, red ${balance(result.redFrame)})`,
  )

  console.log(`OK: textured armcom from a static pack (${result.blueFrame.distinctColors} colours, ` +
    `spread ${result.blueFrame.spread}) with working team colours — no studio server involved`)
} finally {
  await browser.close()
  server.close()
}
