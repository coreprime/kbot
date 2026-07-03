// draw-capture.test.js — headless whole-scene draw-submission capture.
//
// Drives the REAL ModelRenderer (shaders load from the embedded sources,
// every GL call lands in a recording stub context) with a field of units
// and a close orbiting camera, and asserts every entity submits geometry
// EVERY frame — the regression harness for whole-unit pop-in/flicker:
// stale draw-elision state, frustum-cull misplacement under rotation,
// LOD-tier oscillation and per-entity uniform bleed all surface here as a
// missing entity in a frame's draw list.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// The renderer's requestRedraw schedules through the browser's rAF; the
// test drives draw() explicitly, so queued redraws must simply never fire.
globalThis.requestAnimationFrame ??= () => 0
// resize() reads the device pixel ratio off the browser window.
globalThis.window ??= { devicePixelRatio: 1 }

import { ModelRenderer } from '../model-renderer.js'
import { OrbitCamera } from '../orbit-camera.js'
import { Model } from '../model.js'
import { Piece } from '../piece.js'
import { TIER_MID_MIN_PX, CULL_RADIUS_PADDING_WU } from '../performance.js'

// ── Recording stub WebGL context ────────────────────────────────────────
//
// Real WebGL enum values for everything the renderer composes bitwise or
// compares; everything else falls back to a deterministic per-name id.
const GL_ENUMS = {
  DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400, COLOR_BUFFER_BIT: 0x4000,
  POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
  DEPTH_TEST: 0x0B71, BLEND: 0x0BE2, CULL_FACE: 0x0B44, POLYGON_OFFSET_FILL: 0x8037,
  SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, ONE: 1, ZERO: 0,
  LEQUAL: 0x0203, LESS: 0x0201, ALWAYS: 0x0207,
  FRONT: 0x0404, BACK: 0x0405,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8, STREAM_DRAW: 0x88E0,
  FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403,
  TEXTURE_2D: 0x0DE1, TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, TEXTURE2: 0x84C2, TEXTURE3: 0x84C3, TEXTURE4: 0x84C4,
  RGBA: 0x1908, RGB: 0x1907, DEPTH_COMPONENT: 0x1902,
  NEAREST: 0x2600, LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, CLAMP_TO_EDGE: 0x812F, REPEAT: 0x2901,
  TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
  DEPTH_COMPONENT16: 0x81A5, FRAMEBUFFER_COMPLETE: 0x8CD5,
  COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
  VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
  UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
}

function makeStubGL({ width = 800, height = 600 } = {}) {
  const record = {
    // drawArrays log for the CURRENT frame: { vbo, mode, first, count }
    draws: [],
    // interleaved event stream: { kind: 'draw'|'u1f', ... } in call order
    seq: [],
    reset() { this.draws.length = 0; this.seq.length = 0 },
  }
  let boundArrayBuffer = null
  let nextEnum = 0x20000
  const enumIds = new Map()
  const uniforms = new Map() // name → stable location object

  const fns = {
    getExtension: () => null,
    getParameter: () => 4096,
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({ attrs: new Map(), nextAttr: 0 }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    useProgram: () => {},
    getAttribLocation: (prog, name) => {
      if (!prog.attrs.has(name)) prog.attrs.set(name, prog.nextAttr++)
      return prog.attrs.get(name)
    },
    getUniformLocation: (prog, name) => {
      const key = name
      if (!uniforms.has(prog)) uniforms.set(prog, new Map())
      const m = uniforms.get(prog)
      if (!m.has(key)) m.set(key, { name })
      return m.get(key)
    },
    createBuffer: () => ({ stub: 'buffer' }),
    bindBuffer: (target, buf) => { if (target === GL_ENUMS.ARRAY_BUFFER) boundArrayBuffer = buf },
    bufferData: () => {},
    bufferSubData: () => {},
    deleteBuffer: () => {},
    createTexture: () => ({ stub: 'texture' }),
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    generateMipmap: () => {},
    pixelStorei: () => {},
    activeTexture: () => {},
    deleteTexture: () => {},
    createFramebuffer: () => ({ stub: 'fbo' }),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => GL_ENUMS.FRAMEBUFFER_COMPLETE,
    deleteFramebuffer: () => {},
    createRenderbuffer: () => ({ stub: 'rbo' }),
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    deleteRenderbuffer: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    enable: () => {},
    disable: () => {},
    depthFunc: () => {},
    depthMask: () => {},
    blendFunc: () => {},
    blendFuncSeparate: () => {},
    cullFace: () => {},
    lineWidth: () => {},
    polygonOffset: () => {},
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    uniform1f: (loc, v) => { if (loc && loc.name) record.seq.push({ kind: 'u1f', name: loc.name, value: v }) },
    uniform1i: () => {},
    uniform2f: () => {},
    uniform3f: () => {},
    uniform4f: () => {},
    uniform1fv: () => {},
    uniform2fv: () => {},
    uniform3fv: () => {},
    uniform4fv: () => {},
    uniformMatrix3fv: () => {},
    uniformMatrix4fv: () => {},
    drawArrays: (mode, first, count) => {
      record.draws.push({ vbo: boundArrayBuffer, mode, first, count })
      record.seq.push({ kind: 'draw', vbo: boundArrayBuffer, mode, first, count })
    },
    drawElements: () => {},
    readPixels: () => {},
    finish: () => {},
    flush: () => {},
    getError: () => 0,
    isContextLost: () => false,
  }

  const gl = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'drawingBufferWidth') return width
      if (prop === 'drawingBufferHeight') return height
      if (prop === 'canvas') return { width, height }
      if (prop === '_record') return record
      if (typeof prop === 'string' && /^[A-Z][A-Z0-9_]*$/.test(prop)) {
        if (prop in GL_ENUMS) return GL_ENUMS[prop]
        if (!enumIds.has(prop)) enumIds.set(prop, nextEnum++)
        return enumIds.get(prop)
      }
      if (prop in fns) return fns[prop]
      // Unknown call — a no-op keeps the pass moving; value reads that
      // matter are all covered above.
      return () => undefined
    },
  })
  return gl
}

// makeUnitModel builds a minimal one-piece model whose draw group carries a
// TAGGED vbo, so drawArrays records identify which entity's geometry hit
// the GPU.  bounds are centred on the origin unless overridden.
function makeUnitModel(tag, { bounds = { min: [-8, 0, -8], max: [8, 16, 8] } } = {}) {
  const root = new Piece({ name: 'base' })
  root.drawGroups = [{ vbo: { tag }, vertexCount: 12, mode: 4, first: 0, color: [0.5, 0.5, 0.55, 1] }]
  return new Model({ name: tag, root, bounds })
}

async function makeRenderer(gl) {
  const renderer = new ModelRenderer({
    canvas: { width: 800, height: 600, clientWidth: 800, clientHeight: 600 },
    textureCache: { get: () => ({ tex: {}, width: 64, height: 64 }) },
    gl,
  })
  const camera = new OrbitCamera({})
  renderer.setCamera(camera)
  await renderer.init()
  return { renderer, camera }
}

// ── The pop-in/flicker repro ────────────────────────────────────────────
test('every entity draws every frame under a close orbiting camera', async () => {
  const gl = makeStubGL()
  const { renderer, camera } = await makeRenderer(gl)

  // A 6×5 field of units around the origin, 36 wu apart — the whole field
  // stays inside the (35° fov) frustum for a steep camera orbiting the
  // field centre at ~500 wu, so every unit must draw on every frame.
  const entities = []
  const unitTags = []
  for (let i = 0; i < 30; i++) {
    const tag = `unit-${i}`
    unitTags.push(tag)
    const gx = (i % 6) - 2.5
    const gz = ((i / 6) | 0) - 2
    entities.push({
      id: i + 1,
      model: makeUnitModel(tag),
      transform: {
        x: gx * 36, y: 0, z: gz * 36,
        headingRad: (i * 0.7) % (Math.PI * 2),
        pitchRad: i % 3 === 0 ? 0.06 : 0,
        rollRad: i % 4 === 0 ? -0.05 : 0,
      },
      teamColor: [0.2, 0.4, 0.9],
      buildPercent: i === 7 ? 35 : 100, // one under-construction unit in the mix
    })
  }
  // A "corpse" entity that carries NO buildPercent — the classic victim of
  // per-entity state bleed from the under-construction unit before it.
  entities.push({
    id: 'corpse-1',
    model: makeUnitModel('corpse-1'),
    transform: { x: 30, y: 0, z: 30, headingRad: 1.1 },
    teamColor: null,
  })

  camera.target = [0, 0, 0]
  camera.pitch = 1.15

  const allTags = [...unitTags, 'corpse-1']
  for (let frame = 0; frame < 100; frame++) {
    // Close orbit: full revolution over the run, breathing distance so
    // projected sizes sweep through LOD-threshold territory.
    camera.yaw = (frame / 100) * Math.PI * 2
    camera.distance = 500 + Math.sin(frame * 0.9) * 30
    // Fresh entity objects every frame — exactly what createWorld's
    // syncEntities does — so any per-entity state the renderer needs to
    // persist (LOD hysteresis) must survive object identity churn.
    renderer.setEntities(entities.map((e) => ({ ...e, transform: { ...e.transform } })))

    gl._record.reset()
    renderer.draw()

    const drawn = new Set()
    for (const d of gl._record.draws) {
      if (d.vbo && d.vbo.tag) drawn.add(d.vbo.tag)
    }
    const stats = renderer.getCullStats()
    for (const tag of allTags) {
      assert.ok(drawn.has(tag),
        `frame ${frame}: entity ${tag} missing from the draw list ` +
        `(drew ${drawn.size}/${allTags.length}, stats ${JSON.stringify(stats)})`)
    }
    assert.equal(stats.culled, 0, `frame ${frame}: ${stats.culled} entities frustum-culled while fully in view`)
  }
})

// ── Per-entity uniform bleed: build% must not leak down the loop ────────
test('an under-construction unit does not bleed its build cut into later entities', async () => {
  const gl = makeStubGL()
  const { renderer, camera } = await makeRenderer(gl)

  const building = {
    id: 1,
    model: makeUnitModel('building'),
    transform: { x: -40, y: 0, z: 0, headingRad: 0 },
    buildPercent: 20,
  }
  const corpse = {
    id: 'corpse-9',
    model: makeUnitModel('corpse-9'),
    transform: { x: 40, y: 0, z: 0, headingRad: 0 },
    // no buildPercent — must render COMPLETE, not 20%-cut / near-zero alpha
  }
  camera.target = [0, 0, 0]
  camera.pitch = 0.9
  camera.distance = 400
  renderer.setEntities([building, corpse])

  gl._record.reset()
  renderer.draw()

  // Walk the interleaved GL event stream: for each entity's drawArrays,
  // the LAST uBuildCutOn written before it must be 1 for the under-
  // construction unit and 0 for the percent-less corpse (the bleed drew
  // the corpse 20%-cut — i.e. mostly invisible).
  let cutOn = null
  const cutAtDraw = new Map()
  for (const e of gl._record.seq) {
    if (e.kind === 'u1f' && e.name === 'uBuildCutOn') cutOn = e.value
    if (e.kind === 'draw' && e.vbo && e.vbo.tag) cutAtDraw.set(e.vbo.tag, cutOn)
  }
  assert.equal(cutAtDraw.get('building'), 1, 'under-construction unit should draw with the build cut on')
  assert.equal(cutAtDraw.get('corpse-9'), 0, 'percent-less entity inherited the previous entity\'s build cut')
})

// ── Frustum cull vs rotated bounds centres ──────────────────────────────
test('a yawed entity with an off-origin bounds centre is not falsely culled', async () => {
  const gl = makeStubGL()
  const { renderer, camera } = await makeRenderer(gl)

  // Model whose geometry (and bounds) sit 40 wu along +X from its origin.
  const model = makeUnitModel('offset', { bounds: { min: [30, 0, -10], max: [50, 20, 10] } })
  // At heading π the REAL geometry swings to −40 along X; the camera hugs
  // that side so the unrotated sphere (at +40) falls outside the frustum.
  const ent = { id: 1, model, transform: { x: 0, y: 0, z: 0, headingRad: Math.PI } }

  camera.target = [-40, 10, 0]
  camera.pitch = 0.35
  camera.yaw = Math.PI / 2 // eye along +X of the target, looking back at it
  camera.distance = 70
  camera.updateMatrices(800 / 600, 0.5, 8000)

  // The scenario must actually discriminate: the TRUE (rotated) sphere is
  // in view, the naive unrotated sphere is not.
  const r = model.boundsRadius + CULL_RADIUS_PADDING_WU
  const c = model.boundsCentre
  assert.ok(camera.sphereInFrustum(-c[0], c[1], -c[2], r), 'sanity: rotated geometry is inside the frustum')
  assert.ok(!camera.sphereInFrustum(c[0], c[1], c[2], r), 'sanity: the unrotated sphere is outside the frustum')

  assert.ok(renderer._entityVisible(ent), 'entity culled even though its rotated geometry is on screen')
})

// ── LOD hysteresis must survive per-frame entity object churn ───────────
test('tier hysteresis holds across rebuilt entity objects (no geometry/impostor flicker)', async () => {
  const gl = makeStubGL()
  const { renderer, camera } = await makeRenderer(gl)

  const model = makeUnitModel('hyst') // boundsRadius ≈ 12.5
  camera.target = [0, 0, 0]
  camera.pitch = 0.6
  camera.yaw = 0

  // Distance where the projected radius sits INSIDE the MID/FAR hysteresis
  // band (between midExit and midEnter), after entering from far away.
  const halfH = 300
  const hft = Math.tan((Math.PI / 4) * 0.5)
  const pxAt = (dist) => (model.boundsRadius / dist) * (halfH / hft)
  // Find distances giving px ≈ 0.8×TIER_MID and ≈ 1.1×TIER_MID: the first
  // is below the plain threshold (FAR without memory), both inside/above
  // the band once MID was entered with hysteresis working.
  const dFarEntry = model.boundsRadius * halfH / hft / (TIER_MID_MIN_PX / 2)  // clearly FAR
  const dMidEntry = model.boundsRadius * halfH / hft / (TIER_MID_MIN_PX * 1.5) // clearly MID
  const dBand = model.boundsRadius * halfH / hft / (TIER_MID_MIN_PX * 0.9)     // inside the band
  assert.ok(pxAt(dBand) < TIER_MID_MIN_PX && pxAt(dBand) > TIER_MID_MIN_PX / 1.25,
    'sanity: the oscillation distance sits inside the hysteresis band')

  const tierAt = (dist) => {
    camera.distance = dist
    camera.updateMatrices(800 / 600, 0.5, 16000)
    // Fresh entity object every classification — createWorld's churn.
    const ent = { id: 42, model, transform: { x: 0, y: 0, z: 0, headingRad: 0 } }
    return renderer._pickLodTier(ent)
  }

  assert.equal(tierAt(dFarEntry), 2, 'far away starts FAR')
  assert.equal(tierAt(dMidEntry), 1, 'approaching promotes to MID')
  // Oscillate through the band: with persistent hysteresis the tier stays
  // MID every frame; broken persistence re-derives FAR on the low swings —
  // the whole-unit geometry↔dot flicker.
  for (let i = 0; i < 20; i++) {
    const d = i % 2 === 0 ? dBand : dMidEntry
    assert.equal(tierAt(d), 1, `band oscillation frame ${i} dropped out of MID`)
  }
})
