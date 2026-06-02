// lamp-map.js
//
// Builds a "lamp atlas" for the running-lights effect.  A fragment shader
// can't group touching pixels into one lamp on its own — it only ever sees
// a local neighbourhood, so a single painted lamp ends up with per-pixel
// colour drift (the dim centre, the bluer edge), which in turn drives a
// per-pixel blink phase and the lamp visibly splits into two competing
// lights on the same spot.
//
// Instead we do the grouping ONCE on the CPU, off the decoded texture
// pixels, and bake the result into a companion RGBA image the shader can
// sample 1:1 with the base texture:
//
//   * keyed mask    — texels bright + saturated enough to read as a lamp
//   * morphological close (radius = gapPx) — merges proximal / touching
//     areas into one region and fills the small holes in the middle of a
//     lamp, so the whole spot lights (not just its rim)
//   * connected components (8-connectivity) over the closed mask
//   * per component: one DOMINANT colour (brightness × saturation weighted
//     average of the original keyed texels), stored vivid/normalised
//
// Atlas encoding (RGBA8):
//   * lamp texel       → RGB = component's vivid dominant colour, A = 255
//   * everything else  → 0,0,0,0
//
// Because every texel of a component carries the exact same colour, the
// shader derives one blink phase and one intensity for the whole lamp — no
// drift, no split.  Pure: takes raw pixels in, returns raw pixels out; no
// DOM, no WebGL.

const EPS = 0.004

// keyedMask flags texels that read as a lamp.  A texel qualifies if it is
// opaque AND either:
//   * VERY bright (max channel ≥ keyBrightHi) — a white-hot lamp keys on
//     brightness alone, so white / desaturated lamps (e.g. Armpanel1's top
//     lights, RGB ≈ 255,255,255) are caught even though their saturation is
//     ~0; OR
//   * bright enough (≥ keyBright) AND saturated enough (≥ keySat) — a
//     COLOURED lamp (the pink/blue/green status dots).
// Lower keyBright/keySat to pick up dimmer coloured lamps; lower keyBrightHi
// to pick up dimmer white lamps (at the risk of bright grey grain leaking in).
function keyedMask(rgba, w, h, keyBright, keySat, keyBrightHi) {
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    if (rgba[o + 3] < 128) continue
    const r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const rsat = (mx - mn) / Math.max(mx, EPS)
    if (mx >= keyBrightHi || (mx >= keyBright && rsat >= keySat)) mask[i] = 1
  }
  return mask
}

// groupByProximity assigns a shared component label to keyed texels that are
// near each other, so a connected (or nearly-connected) blob carries ONE
// dominant colour + blink phase.  Unlike a morphological close it neither
// grows the lit area nor fills the dark gaps BETWEEN blobs — it only shares an
// identity — so raising `gap` merges a split lamp's colour without bloating it.
//
// Two keyed texels join the same lamp when their centres are within
// Euclidean distance 1.45 + gap:
//   gap 0    → radius 1.45 → 8-connectivity (orthogonal + diagonal touch)
//   gap ~0.5 → radius ~2.0 → bridges a 1-texel dark gap (the corv06b
//              purple/blue split merges here)
//   gap ~1.4 → radius ~2.8 → bridges a 2-texel-diagonal gap
// `gap` is fractional, so the merge distance is finely tunable.  Labels are
// set ONLY on keyed texels (0 elsewhere), so downstream the atlas lights just
// the painted lamp texels.
function groupByProximity(keyed, w, h, gap) {
  const n = w * h
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const R = 1.45 + Math.max(0, gap)
  const R2 = R * R
  const rad = Math.ceil(R)
  for (let i = 0; i < n; i++) {
    if (!keyed[i]) continue
    const x = i % w, y = (i - x) / w
    // Scan the forward half-window only (each pair is visited once).
    for (let dy = 0; dy <= rad; dy++) {
      const yy = y + dy
      if (yy >= h) continue
      for (let dx = -rad; dx <= rad; dx++) {
        if (dy === 0 && dx <= 0) continue
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        if (dx * dx + dy * dy > R2) continue
        const j = yy * w + xx
        if (!keyed[j]) continue
        const ra = find(i), rb = find(j)
        if (ra !== rb) parent[ra] = rb
      }
    }
  }
  const remap = new Map()
  const labels = new Int32Array(n)
  let count = 0
  for (let i = 0; i < n; i++) {
    if (!keyed[i]) continue
    const r = find(i)
    let lab = remap.get(r)
    if (lab == null) { lab = ++count; remap.set(r, lab) }
    labels[i] = lab
  }
  return { labels, count }
}

// Radius (texels) of the window used to estimate a candidate's local
// background brightness for the positive-contrast gate.
const RISE_RADIUS = 3

// Shape sanity for a finished lamp component.  A running light reads as a
// COMPACT blob; the false positives left after the colour + positive-rise
// gates are thin bright STRIPS along a gradient's bright edge (e.g. corv04b's
// y5-6 highlight band).  So drop any component whose bounding box is more
// elongated than a lamp plausibly is.  MIN_LAMP_PX stays at 1 on purpose —
// several real lamps are single bright texels (Armpanel1's white panel-top
// dots), and the positive-rise gate already culls the lone dim specks.  Not
// exposed as knobs: they encode "a lamp is a dot, not a streak".
const MIN_LAMP_PX = 1
const MAX_LAMP_ASPECT = 3.5

// Colour-merge: two lamp components whose vivid colours differ by more than
// this (sum of |ΔR|+|ΔG|+|ΔB|, 0..765) AND sit within colorMergePx of each
// other are snapped to the cluster's dominant colour.  Below the threshold
// the shades are "the same colour" and left alone (the timing buckets keep
// them in phase).  ~90 treats two shades of blue as the same but a blue vs a
// purple/yellow as different.
const COLOR_DIFF_THRESHOLD = 90

// risenMask drops every keyed texel that is NOT a positive local bright spike:
// a real lamp sits brighter than the surface AROUND it (a dark→bright shift),
// whereas a smooth gradient ramp or a recess sits at ~its neighbourhood mean
// (or below it).  For each keyed texel we compare its brightness to the mean
// brightness of a RISE_RADIUS window and require a rise of at least `minRise`.
// This rejects corv04b's gradient recesses (no local rise) and stray dim
// specks (rise below the floor) while keeping crisp lamp dots (large rise).
function risenMask(keyed, rgba, w, h, minRise) {
  if (minRise <= 0) return keyed
  const bright = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    bright[i] = Math.max(rgba[o], rgba[o + 1], rgba[o + 2]) / 255
  }
  const out = new Uint8Array(w * h)
  const r = RISE_RADIUS
  for (let i = 0; i < w * h; i++) {
    if (!keyed[i]) continue
    const x = i % w, y = (i - x) / w
    let sum = 0, n = 0
    for (let dy = -r; dy <= r; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy))
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx))
        sum += bright[yy * w + xx]; n++
      }
    }
    if (bright[i] - sum / n >= minRise) out[i] = 1
  }
  return out
}

// buildLampAtlas: decoded RGBA pixels → lamp-atlas RGBA (same dimensions).
//   opts.keyBright   (0..1) — min brightness for a COLOURED lamp     (0.20)
//   opts.keySat      (0..1) — min relative saturation for a coloured lamp (0.50)
//   opts.keyBrightHi (0..1) — brightness above which colour is ignored, so
//                             white/desaturated lamps still key          (0.80)
//   opts.minRise     (0..1) — min brightness rise over the local surroundings;
//                             only positive dark→bright spikes key, so gradient
//                             recesses + dim specks fall through          (0.12)
//   opts.gapPx     (float)  — grouping radius: merges nearby lamp blobs into
//                             one colour/phase (0 = 8-connect only, ~0.5
//                             bridges a 1-texel gap); shares identity without
//                             growing the lit area                        (0)
//   opts.colorMergePx (px)  — colour-harmonise radius: components within this
//                             distance with DIFFERENT colours all adopt the
//                             cluster's dominant colour (RUNNING_LIGHT_COLOR_
//                             MERGE_PX in performance.js)                  (4)
export function buildLampAtlas(rgba, w, h, opts = {}) {
  const keyBright = opts.keyBright != null ? opts.keyBright : 0.20
  const keySat = opts.keySat != null ? opts.keySat : 0.50
  const keyBrightHi = opts.keyBrightHi != null ? opts.keyBrightHi : 0.80
  const minRise = opts.minRise != null ? opts.minRise : 0.12
  const gapPx = Math.max(0, opts.gapPx != null ? opts.gapPx : 0)
  const colorMergePx = Math.max(0, opts.colorMergePx != null ? opts.colorMergePx : 4)

  const out = new Uint8ClampedArray(w * h * 4) // zero-filled = transparent
  const keyed = risenMask(keyedMask(rgba, w, h, keyBright, keySat, keyBrightHi), rgba, w, h, minRise)
  const { labels, count } = groupByProximity(keyed, w, h, gapPx)
  if (count === 0) return out

  // Compactness filter — measure each component's size + bounding box, then
  // void (set label 0) any that's an elongated strip.  Zeroing the label makes
  // the colour accumulation + atlas write below skip it for free.  A larger
  // gapPx merges blobs into longer runs, so the aspect tolerance grows with it.
  {
    const size = new Int32Array(count + 1)
    const minX = new Int32Array(count + 1).fill(w)
    const minY = new Int32Array(count + 1).fill(h)
    const maxX = new Int32Array(count + 1).fill(-1)
    const maxY = new Int32Array(count + 1).fill(-1)
    for (let i = 0; i < w * h; i++) {
      const lab = labels[i]
      if (!lab) continue
      const x = i % w, y = (i - x) / w
      size[lab]++
      if (x < minX[lab]) minX[lab] = x
      if (x > maxX[lab]) maxX[lab] = x
      if (y < minY[lab]) minY[lab] = y
      if (y > maxY[lab]) maxY[lab] = y
    }
    const maxAspect = MAX_LAMP_ASPECT + 2 * gapPx
    const valid = new Uint8Array(count + 1)
    for (let lab = 1; lab <= count; lab++) {
      if (size[lab] < MIN_LAMP_PX) continue
      const bw = maxX[lab] - minX[lab] + 1
      const bh = maxY[lab] - minY[lab] + 1
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))
      if (aspect <= maxAspect) valid[lab] = 1
    }
    for (let i = 0; i < w * h; i++) {
      if (labels[i] && !valid[labels[i]]) labels[i] = 0
    }
  }

  // Accumulate each component's dominant colour from its ORIGINAL keyed
  // texels (not the close-filled ones), weighted by brightness × saturation
  // so the vivid lamp colour wins over dim fringe texels.  Components with
  // no keyed seed (a fully filled hole) fall back to a flat mid-grey.
  const sumR = new Float64Array(count + 1)
  const sumG = new Float64Array(count + 1)
  const sumB = new Float64Array(count + 1)
  const sumW = new Float64Array(count + 1)
  for (let i = 0; i < w * h; i++) {
    const lab = labels[i]
    if (!lab || !keyed[i]) continue
    const o = i * 4
    const r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const rsat = (mx - mn) / Math.max(mx, EPS)
    const wgt = mx * rsat + 1e-3
    sumR[lab] += r * wgt
    sumG[lab] += g * wgt
    sumB[lab] += b * wgt
    sumW[lab] += wgt
  }

  // Vivid (value-normalised) dominant colour per component, in 0..255.
  const colR = new Uint8ClampedArray(count + 1)
  const colG = new Uint8ClampedArray(count + 1)
  const colB = new Uint8ClampedArray(count + 1)
  for (let lab = 1; lab <= count; lab++) {
    const wsum = sumW[lab]
    if (wsum <= 0) { colR[lab] = colG[lab] = colB[lab] = 160; continue }
    const r = sumR[lab] / wsum, g = sumG[lab] / wsum, b = sumB[lab] / wsum
    const mx = Math.max(r, g, b, EPS)
    colR[lab] = (r / mx) * 255
    colG[lab] = (g / mx) * 255
    colB[lab] = (b / mx) * 255
  }

  // Colour harmonisation — any two components within colorMergePx of each
  // other whose colours differ (> COLOR_DIFF_THRESHOLD) are unioned into a
  // colour-cluster, and every member adopts the cluster's DOMINANT (highest
  // weight = brightest × most-saturated) component's colour.  This only
  // changes the colour written; it does NOT merge their identity/timing
  // grouping or grow the lit area.  Combined with the shader's hue-bucketed
  // blink, harmonised neighbours then also pulse together.
  if (colorMergePx > 0 && count > 1) {
    const cParent = new Int32Array(count + 1)
    for (let i = 0; i <= count; i++) cParent[i] = i
    const cfind = (a) => { while (cParent[a] !== a) { cParent[a] = cParent[cParent[a]]; a = cParent[a] } return a }
    const r2 = colorMergePx * colorMergePx
    const rad = Math.ceil(colorMergePx)
    for (let i = 0; i < w * h; i++) {
      const la = labels[i]
      if (!la) continue
      const x = i % w, y = (i - x) / w
      for (let dy = 0; dy <= rad; dy++) {
        const yy = y + dy
        if (yy >= h) continue
        for (let dx = -rad; dx <= rad; dx++) {
          if (dy === 0 && dx <= 0) continue
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          if (dx * dx + dy * dy > r2) continue
          const lb = labels[yy * w + xx]
          if (!lb || lb === la) continue
          const diff = Math.abs(colR[la] - colR[lb]) + Math.abs(colG[la] - colG[lb]) + Math.abs(colB[la] - colB[lb])
          if (diff <= COLOR_DIFF_THRESHOLD) continue
          const ra = cfind(la), rb = cfind(lb)
          if (ra !== rb) cParent[ra] = rb
        }
      }
    }
    // Pick the dominant (max weight) member per colour-cluster, then repaint
    // every member with its colour.
    const dom = new Int32Array(count + 1)
    for (let lab = 1; lab <= count; lab++) {
      const r = cfind(lab)
      if (dom[r] === 0 || sumW[lab] > sumW[dom[r]]) dom[r] = lab
    }
    for (let lab = 1; lab <= count; lab++) {
      const d = dom[cfind(lab)]
      if (d && d !== lab) { colR[lab] = colR[d]; colG[lab] = colG[d]; colB[lab] = colB[d] }
    }
  }

  for (let i = 0; i < w * h; i++) {
    const lab = labels[i]
    if (!lab) continue
    const o = i * 4
    out[o] = colR[lab]
    out[o + 1] = colG[lab]
    out[o + 2] = colB[lab]
    out[o + 3] = 255
  }
  return out
}
