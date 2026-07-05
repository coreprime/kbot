// Headless proof that the packaged @coreprime/kbot-game3d works outside the repo:
// bundle browser-entry.mjs (resolving @coreprime/kbot-game3d from THIS directory's
// node_modules — i.e. the installed package, not the repo sources), load
// it into headless Chromium, and assert the renderer painted a non-blank
// frame and that addUnit() increased the rendered draw count.
//
// Expects to run from a scratch directory containing:
//   node_modules/@coreprime/kbot-game3d   (installed tarball or npmjs package)
//   node_modules/esbuild, node_modules/playwright (+ chromium installed)
//   browser-entry.mjs, test.mjs (copied from examples/consume-game3d)

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, 'package.json'))
const esbuild = require('esbuild')
const { chromium } = require('playwright')

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
  await page.addScriptTag({ content: script })
  const result = await page.evaluate(() => window.__proof)

  console.log('empty frame :', JSON.stringify(result.emptyFrame), 'stats:', JSON.stringify(result.emptyStats))
  console.log('unit frame  :', JSON.stringify(result.unitFrame), 'stats:', JSON.stringify(result.unitStats))
  console.log('moved stats :', JSON.stringify(result.movedStats))

  // 1. Non-blank canvas.  The empty scene draws the (dark, untextured —
  //    the fixture provider serves no groundTile) sky/ground pass: some
  //    pixels must be lit and show variation, i.e. not an unpainted
  //    zeroed buffer.  With the cube in frame the image must show real
  //    structure — a wide luminance spread from the lit flat-shaded
  //    faces against the background.
  assert.ok(
    result.emptyFrame.mean > 0 && result.emptyFrame.spread > 0,
    `empty-scene frame is an unpainted buffer (${JSON.stringify(result.emptyFrame)})`,
  )
  assert.ok(result.unitFrame.spread > 30, `unit frame is blank (spread ${result.unitFrame.spread})`)
  assert.ok(
    result.unitFrame.spread > result.emptyFrame.spread + 10,
    `adding the unit did not change the frame (${result.emptyFrame.spread} -> ${result.unitFrame.spread})`,
  )

  // 2. addUnit increases the rendered draw count.
  assert.equal(result.emptyStats.total, 0, 'expected zero entities before addUnit')
  assert.equal(result.unitStats.total, 1, 'expected one entity after addUnit')
  assert.ok(
    result.unitStats.drew > result.emptyStats.drew,
    `draw count did not increase (before ${result.emptyStats.drew}, after ${result.unitStats.drew})`,
  )
  assert.ok(result.movedStats.drew >= 1, 'unit stopped drawing after moveUnit')

  console.log(`OK: non-blank frame (spread ${result.unitFrame.spread}) and draw count ` +
    `${result.emptyStats.drew} -> ${result.unitStats.drew} after addUnit('proofcube') (id ${result.unitId})`)
} finally {
  await browser.close()
}
