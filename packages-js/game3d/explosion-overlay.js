// explosion-overlay.js
//
// Per-renderer screen-space overlay that displays real TA GAF
// animations on top of the WebGL canvas at the world-space impact
// position.  Browsers handle APNG playback natively, so the overlay
// just clones the cached <img> (one per impact) into an absolutely-
// positioned wrapper, projects the world position to canvas pixels
// each frame, and removes the element when the configured lifeMs
// elapses.
//
// Why a DOM overlay and not a textured GL quad?
//   * APNG decode is browser-native, no per-frame manual texture
//     uploads.
//   * Single shared <img> tag = single decode buffer per (weapon,
//     variant) regardless of how many simultaneous explosions.
//   * Pixel-perfect transparency without an alpha-mask atlas.
//   * Trivially additive-blends with the existing post-FX bloom
//     since the overlay sits ABOVE the canvas — no shader change.
//
// The trade-off: explosions don't depth-test against scene geometry
// (they always draw "on top").  For TA-scale impacts at the unit
// surface that's barely visible; we accept it for the simplicity win.

export class ExplosionOverlay {
  // canvas:  the renderer's canvas element.  The overlay's root <div>
  //          is appended as a sibling so it inherits the canvas's
  //          parent's relative-positioned bounds.
  // project: function(worldXYZ) => {x, y, depth} in canvas-pixel
  //          coordinates.  When supplied, sprites track the world
  //          position every frame (handles camera orbit / pan / zoom).
  //          Set to null to pin sprites at their initial screen pos.
  constructor(canvas, project = null) {
    this.canvas = canvas
    this.project = project
    // Root wrapper — sits over the canvas, pointer-events:none so it
    // never eats clicks meant for the unit-selection layer beneath.
    this.root = document.createElement('div')
    this.root.className = 'explosion-overlay'
    this.root.style.cssText = [
      'position:absolute', 'inset:0',
      'pointer-events:none', 'overflow:hidden',
      'z-index:30',
    ].join(';')
    const parent = canvas.parentElement
    if (parent) {
      // Make sure the parent is a positioning context so inset:0
      // resolves to the canvas's bounding box.
      const cs = getComputedStyle(parent)
      if (cs.position === 'static') parent.style.position = 'relative'
      parent.appendChild(this.root)
    }
    this._active = []  // { el, pos, expiresAt, sizeWU }
    this._tickHandle = 0
  }

  // play — spawn one sprite at worldPos using the cached img element.
  // The img is cloned so multiple simultaneous explosions can each
  // animate on their own copy of the source.  Returns the cloned
  // element in case the caller wants to override styling further.
  //
  // opts.lifeMs    — auto-remove after this many ms (default 800).
  // opts.sizeWU    — sprite size in world units (default 24).  We
  //                  convert to pixels each frame so it scales
  //                  correctly as the camera zooms.
  // opts.opacity   — initial alpha (default 1.0).
  play(worldPos, img, opts = {}) {
    if (!img || !this.root || !this.root.isConnected) return null
    const el = img.cloneNode(true)
    el.style.cssText = [
      'position:absolute', 'transform-origin:center center',
      'pointer-events:none', 'will-change:transform',
      'image-rendering:auto',
    ].join(';')
    if (opts.opacity != null) el.style.opacity = String(opts.opacity)
    this.root.appendChild(el)
    const rec = {
      el,
      pos: [worldPos[0], worldPos[1], worldPos[2]],
      expiresAt: performance.now() + (opts.lifeMs || 800),
      sizeWU: +opts.sizeWU || 24,
    }
    this._active.push(rec)
    this._positionEl(rec)
    this._ensureTicking()
    return el
  }

  // _positionEl — project worldPos to canvas pixels and apply as a
  // CSS transform.  Hides the element when the projection puts it
  // behind the camera (depth <= 0) so a sprite spawned across the
  // map doesn't bleed onto the front of the screen.
  _positionEl(rec) {
    if (!this.project) return
    const p = this.project(rec.pos)
    if (!p || !(p.depth > 0)) { rec.el.style.display = 'none'; return }
    rec.el.style.display = ''
    // Size in pixels — same world-unit-per-pixel scale the projection
    // gives us, with a sensible floor so tiny explosions stay visible
    // and a ceiling so massive ones don't fill the whole viewport.
    const pxScale = (p.pxPerWU != null) ? +p.pxPerWU : 4
    const size = Math.max(24, Math.min(512, rec.sizeWU * pxScale))
    rec.el.style.width = `${size}px`
    rec.el.style.height = 'auto'
    rec.el.style.transform = `translate(${p.x - size / 2}px, ${p.y - size / 2}px)`
  }

  // _ensureTicking — start the rAF loop if we have any active sprites
  // and aren't already running.  Single shared loop across every
  // active explosion on this overlay.
  _ensureTicking() {
    if (this._tickHandle) return
    const loop = () => {
      this._tickHandle = 0
      if (!this._active.length) return
      const now = performance.now()
      let w = 0
      for (let i = 0; i < this._active.length; i++) {
        const r = this._active[i]
        if (now >= r.expiresAt) {
          try { r.el.remove() } catch { /* ignore */ }
          continue
        }
        this._positionEl(r)
        this._active[w++] = r
      }
      this._active.length = w
      if (this._active.length > 0) {
        this._tickHandle = requestAnimationFrame(loop)
      }
    }
    this._tickHandle = requestAnimationFrame(loop)
  }

  // dispose — remove every active sprite + the wrapper.  Called on
  // view tear-down so a re-open doesn't inherit lingering DOM.
  dispose() {
    if (this._tickHandle) { cancelAnimationFrame(this._tickHandle); this._tickHandle = 0 }
    for (const r of this._active) {
      try { r.el.remove() } catch { /* ignore */ }
    }
    this._active.length = 0
    try { this.root.remove() } catch { /* ignore */ }
    this.root = null
  }
}
