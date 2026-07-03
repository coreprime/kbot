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
