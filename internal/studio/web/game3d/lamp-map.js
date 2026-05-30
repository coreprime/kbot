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

// keyedMask flags texels that read as a lamp: bright enough (max channel ≥
// keyBright) AND saturated enough (relative saturation ≥ keySat) AND opaque.
// Lower either threshold to pick up more pixels.
function keyedMask(rgba, w, h, keyBright, keySat) {
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    if (rgba[o + 3] < 128) continue
    const r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const rsat = (mx - mn) / Math.max(mx, EPS)
    if (mx >= keyBright && rsat >= keySat) mask[i] = 1
  }
  return mask
}

// Square-kernel dilate / erode with edge-clamped sampling so lamps on the
// tile border aren't eaten.  r ≤ 0 is a no-op.
function dilate(mask, w, h, r) {
  if (r <= 0) return mask
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0
      for (let dy = -r; dy <= r && !on; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy))
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx))
          if (mask[yy * w + xx]) { on = 1; break }
        }
      }
      out[y * w + x] = on
    }
  }
  return out
}

function erode(mask, w, h, r) {
  if (r <= 0) return mask
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = 1
      for (let dy = -r; dy <= r && all; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy))
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx))
          if (!mask[yy * w + xx]) { all = 0; break }
        }
      }
      out[y * w + x] = all
    }
  }
  return out
}

// Label 8-connected components of `mask` with an iterative flood fill.
// Returns { labels: Int32Array (0 = background, ≥1 = component id), count }.
function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h)
  const stack = []
  let next = 0
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue
    next++
    labels[s] = next
    stack.length = 0
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()
      const px = p % w
      const py = (p - px) / w
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (mask[q] && !labels[q]) {
            labels[q] = next
            stack.push(q)
          }
        }
      }
    }
  }
  return { labels, count: next }
}

// buildLampAtlas: decoded RGBA pixels → lamp-atlas RGBA (same dimensions).
//   opts.keyBright (0..1) — min brightness to read as a lamp (default 0.12)
//   opts.keySat    (0..1) — min relative saturation                (0.50)
//   opts.gapPx     (int)  — close radius: merges areas within ~2·gapPx and
//                           fills holes up to that wide                (1)
export function buildLampAtlas(rgba, w, h, opts = {}) {
  const keyBright = opts.keyBright != null ? opts.keyBright : 0.12
  const keySat = opts.keySat != null ? opts.keySat : 0.50
  const gapPx = Math.max(0, Math.round(opts.gapPx != null ? opts.gapPx : 1))

  const out = new Uint8ClampedArray(w * h * 4) // zero-filled = transparent
  const keyed = keyedMask(rgba, w, h, keyBright, keySat)
  const closed = erode(dilate(keyed, w, h, gapPx), w, h, gapPx)
  const { labels, count } = labelComponents(closed, w, h)
  if (count === 0) return out

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
