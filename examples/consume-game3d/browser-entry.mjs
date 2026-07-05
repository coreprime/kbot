// In-page half of the game3d consume proof.  Bundled (with @coreprime/kbot-game3d
// resolved from node_modules) by test.mjs and injected into a headless
// page.  Uses a minimal in-memory AssetProvider — a 256-entry synthetic
// palette and one flat-coloured cube model — so the proof exercises the
// published renderer with zero server I/O, exactly the seam contract.
//
// Proves two things (V1.1's renderer assertion, local variant):
//   1. createWorld() paints a NON-BLANK frame (sky/ground pass) — pixel
//      variance across the canvas is > 0.
//   2. addUnit() increases the rendered entity draw count (stats().drew).

import { createWorld } from '@coreprime/kbot-game3d'

// A 20-world-unit flat-shaded cube: 8 vertices, 6 quad faces, palette
// colour 100.  No textures, no COB — the smallest real model the loader
// accepts (triangulation, normals, AO and GPU upload all still run).
function cubeModel() {
  const s = 10
  const vertices = [
    -s, 0, -s,   s, 0, -s,   s, 0, s,   -s, 0, s,       // bottom ring (y=0)
    -s, 2 * s, -s,   s, 2 * s, -s,   s, 2 * s, s,   -s, 2 * s, s, // top ring
  ]
  const q = (a, b, c, d) => ({ indices: [a, b, c, d], isColored: true, colorIndex: 100 })
  return {
    name: 'proofcube',
    root: {
      name: 'base',
      origin: [0, 0, 0],
      vertices,
      primitives: [
        q(4, 5, 6, 7),      // top
        q(0, 1, 5, 4),      // sides
        q(1, 2, 6, 5),
        q(2, 3, 7, 6),
        q(3, 0, 4, 7),
      ],
      children: [],
    },
    bounds: { min: [-s, 0, -s], max: [s, 2 * s, s] },
    textures: [],
    decals: [],
  }
}

const provider = {
  async palette() {
    return Array.from({ length: 256 }, (_, i) => [i, 160, 255 - i])
  },
  async model(name) {
    if (name !== 'proofcube') throw new Error(`fixture has no model ${name}`)
    return cubeModel()
  },
  async texture() {
    const c = document.createElement('canvas')
    c.width = 4
    c.height = 4
    const cx = c.getContext('2d')
    cx.fillStyle = '#808080'
    cx.fillRect(0, 0, 4, 4)
    return c
  },
}

function frameVariance(gl, w, h) {
  const px = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
  let min = 255
  let max = 0
  let sum = 0
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] + px[i + 1] + px[i + 2]) / 3
    if (lum < min) min = lum
    if (lum > max) max = lum
    sum += lum
  }
  return { min, max, mean: sum / (px.length / 4), spread: max - min }
}

window.__proof = (async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 320
  document.body.appendChild(canvas)

  const world = await createWorld(canvas, {
    assets: provider,
    controls: false,
    // Keep the drawing buffer readable after the draw call returns.
    contextAttributes: { preserveDrawingBuffer: true },
  })
  // Deterministic counting: no frustum cull, no self-driving loop.
  world.renderer.setCullEnabled(false)

  world.step(16)
  const emptyStats = { ...world.stats() }
  const emptyFrame = frameVariance(world.gl, canvas.width, canvas.height)

  const id = await world.addUnit('proofcube', { x: 0, z: 0 })
  // A couple of frames so async texture/piece state (none here, but the
  // path is real) settles before counting.
  world.step(16)
  world.step(16)
  const unitStats = { ...world.stats() }
  const unitFrame = frameVariance(world.gl, canvas.width, canvas.height)

  world.moveUnit(id, { x: 40 })
  world.step(16)
  const movedStats = { ...world.stats() }

  world.dispose()
  return { emptyStats, emptyFrame, unitStats, unitFrame, movedStats, unitId: id }
})()
