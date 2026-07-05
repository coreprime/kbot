// In-page half of the pack consume proof.  Bundled (with @coreprime/kbot-game3d
// resolved from node_modules — the packaged artifact, not repo sources) by
// test.mjs and injected into a headless page.  Drives the renderer through
// an HttpPackProvider pointed at a real `kbot pack` extraction served over
// plain static HTTP — the replayer's asset path, with no studio server.
//
// Proves:
//   1. unitDB() resolves the pack's unit database (the commander's
//      movement class + build fields are asserted node-side).
//   2. A REAL unit (the ARM commander) renders non-blank and TEXTURED —
//      the frame carries far more distinct colours than a flat-shaded
//      fixture could produce.
//   3. Team colours apply: the same unit rendered on two different sides
//      produces measurably different frames, with the red side's frame
//      redder than the blue side's.

import { createWorld, HttpPackProvider } from '@coreprime/kbot-game3d'

// A minimal two-team table (side 0 = "no recolour" sentinel).
const TEAM_SIDES = [
  { side: 0, key: 'none', label: 'None', rgb: null, swatchCss: '#888' },
  { side: 1, key: 'blue', label: 'Blue', rgb: [0.227, 0.424, 0.839], swatchCss: '#3a6cd6' },
  { side: 2, key: 'red', label: 'Red', rgb: [0.839, 0.227, 0.227], swatchCss: '#d63a3a' },
]

function frameStats(gl, w, h) {
  const px = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
  let min = 255
  let max = 0
  let sumLum = 0
  let sumR = 0
  let sumB = 0
  const colors = new Set()
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]
    const g = px[i + 1]
    const b = px[i + 2]
    const lum = (r + g + b) / 3
    if (lum < min) min = lum
    if (lum > max) max = lum
    sumLum += lum
    sumR += r
    sumB += b
    colors.add((r << 16) | (g << 8) | b)
  }
  const n = px.length / 4
  return {
    min,
    max,
    spread: max - min,
    mean: sumLum / n,
    meanR: sumR / n,
    meanB: sumB / n,
    distinctColors: colors.size,
  }
}

window.__proof = (async () => {
  const packUrl = window.__PACK_URL
  if (!packUrl) throw new Error('window.__PACK_URL was not injected')
  const provider = new HttpPackProvider(packUrl)

  const manifest = await provider.manifest()
  const unitDB = await provider.unitDB()

  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 320
  document.body.appendChild(canvas)

  const world = await createWorld(canvas, {
    assets: provider,
    game: { teamSides: TEAM_SIDES },
    controls: false,
    contextAttributes: { preserveDrawingBuffer: true },
  })
  world.renderer.setCullEnabled(false)

  // Let async texture uploads settle before sampling frames: step a few
  // frames, then keep stepping until two consecutive frames are stable
  // (or a bounded number of attempts pass).
  const settle = async () => {
    let prev = -1
    for (let i = 0; i < 60; i++) {
      world.step(16)
      const s = frameStats(world.gl, canvas.width, canvas.height)
      if (i > 5 && s.distinctColors === prev) return s
      prev = s.distinctColors
      // Yield so image decode + texImage2D callbacks can run.
      await new Promise((r) => setTimeout(r, 25))
    }
    return frameStats(world.gl, canvas.width, canvas.height)
  }

  world.step(16)
  const emptyFrame = frameStats(world.gl, canvas.width, canvas.height)
  const emptyStats = { ...world.stats() }

  const blueId = await world.addUnit('armcom', { x: 0, z: 0, side: 1 })
  const blueFrame = await settle()
  const unitStats = { ...world.stats() }

  world.removeUnit(blueId)
  const redId = await world.addUnit('armcom', { x: 0, z: 0, side: 2 })
  const redFrame = await settle()

  world.removeUnit(redId)
  world.dispose()

  return { manifest, unitDB, emptyFrame, emptyStats, blueFrame, redFrame, unitStats }
})()
