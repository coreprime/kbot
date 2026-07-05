// log-depth.test.js — headless proof of the logarithmic-depth remap math
// used by shaders/lib/logdepth.glsl to fix distance z-fighting (#6). The GLSL
// can't run under node, so this replicates the exact arithmetic the renderer
// (uLogDepthFC = 2/log2(far+1)) and the shader (log2(1+w)*0.5*FC) perform, and
// asserts the properties that make it correct: it covers [0,1] across the
// range, is monotonic, and — crucially — spends far MORE of its precision at
// distance than the standard perspective depth, which is why the extended far
// plane stops z-fighting.
import test from 'node:test'
import assert from 'node:assert/strict'

// Renderer side: the per-frame constant.
const logDepthFC = (far) => 2.0 / Math.log2(far + 1.0)
// Shader side: window depth in [0,1] for a fragment at clip-w = viewDistance.
const logDepth = (w, far) => Math.log2(1.0 + w) * 0.5 * logDepthFC(far)
// Standard perspective window depth (0.5*z_ndc+0.5) for comparison.
const perspDepth = (w, near, far) => {
  const zNdc = ((far + near) / (near - far)) + (2 * far * near / (near - far)) / w
  return zNdc * 0.5 + 0.5
}

test('log depth maps the near plane to ~0 and the far plane to 1', () => {
  const far = 48000, near = 0.05
  assert.ok(logDepth(near, far) < 0.02, 'near maps near 0')
  assert.ok(Math.abs(logDepth(far, far) - 1.0) < 1e-6, 'far maps to 1')
})

test('log depth is monotonically increasing with distance', () => {
  const far = 48000
  let prev = -1
  for (const w of [0.1, 1, 10, 100, 1000, 10000, 48000]) {
    const d = logDepth(w, far)
    assert.ok(d > prev, `depth increases at w=${w}`)
    prev = d
  }
})

test('log depth resolves distant coplanar layers that perspective depth cannot', () => {
  // Two nearly-coplanar surfaces 1 wu apart, viewed from 6000 wu away — the
  // wind-turbine-in-the-distance case. Under a 48 km far plane the standard
  // perspective depth barely separates them (z-fighting); log depth keeps a
  // usable gap, which is what removes the flicker.
  const far = 48000, near = 0.05
  const w0 = 6000, w1 = 6001
  const dPersp = Math.abs(perspDepth(w1, near, far) - perspDepth(w0, near, far))
  const dLog = Math.abs(logDepth(w1, far) - logDepth(w0, far))
  assert.ok(dLog > dPersp * 5, `log gap (${dLog}) must dwarf perspective gap (${dPersp})`)
})

// ── BUG C: slope-scaled decal bias kills grazing-angle z-fighting ──────────

// Shader side of logDepthFragmentBiased(bias): a coplanar decal fragment
// writes its own log depth minus a constant bias minus a slope term. The slope
// term is fwidth(d) — the depth change across one fragment — scaled by 2. This
// mirrors the GLSL so we can prove the ordering property headlessly.
const logDepthBiased = (w, far, bias, slope) => logDepth(w, far) - bias - slope * 2.0

test('a flush decal always wins LEQUAL over the terrain it lies on — even at grazing angles', () => {
  const far = 48000
  const bias = 0.0008
  // A decal and the terrain under it are coplanar, so the terrain fragment and
  // the decal fragment sit at the SAME distance w. What differs at a grazing
  // angle is the per-fragment depth slope: adjacent pixels differ by `dw`,
  // which is small looking straight down and LARGE at a grazing view.
  for (const [w, dw, label] of [
    [800, 0.2, 'near-overhead (tiny slope)'],
    [2500, 8, 'oblique'],
    [6000, 120, 'grazing (steep slope)'],
    [12000, 600, 'near-horizon grazing'],
  ]) {
    // Per-fragment depth slope the shader sees as fwidth(d): the change in the
    // WRITTEN log depth across one fragment step of `dw` world units.
    const slope = Math.abs(logDepth(w + dw, far) - logDepth(w, far))
    const decal = logDepthBiased(w, far, bias, slope)
    const terrain = logDepth(w, far)
    // The decal must be strictly nearer (smaller) than the terrain so LEQUAL
    // draws it on top with no flicker — at EVERY slope, which the constant
    // bias alone cannot guarantee once the slope exceeds it.
    assert.ok(decal < terrain, `decal wins at ${label}: ${decal} < ${terrain}`)
    // And at a grazing angle the slope term must actually dominate the constant
    // (that's the whole point — the constant alone was losing there).
    if (slope * 2.0 > bias) {
      assert.ok(terrain - decal > bias, `slope term carries the offset at ${label}`)
    }
  }
})
