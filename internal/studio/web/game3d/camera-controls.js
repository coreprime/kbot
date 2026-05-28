// camera-controls.js
//
// Reusable orbit-camera input wiring shared by single-entity and
// multi-entity host views.  Pulls the pointer / wheel gestures into
// one place so both views feel identical:
//
//   left-drag           orbit (yaw + pitch)
//   right-drag          pan freely
//   shift + drag        axis-locked pan (dominant axis wins)
//   ctrl/cmd + drag     pan along the world's GROUND PLANE — walks
//                       the camera through the scene without tilting
//   wheel               zoom (in on scroll-up, out on scroll-down)
//   R                   toggle auto-rotate
//
// Auto-rotate is dropped on PAN gestures only (shift/ctrl/right-drag)
// — orbit-drag and wheel-zoom keep it on since neither moves the
// orbit pivot.  The optional `onUserInteract` hook lets the host
// clear external state (e.g. the "Tracking" checkbox the Renderer
// panel exposes) when the user starts driving the camera manually.

// onLeftDragStart (optional) — when supplied, plain left-drags
// (no modifier, no right-button) hand off to the host instead of
// orbiting the camera.  The host receives the live pointer events
// directly and decides what the drag means (e.g. drawing a
// rectangle-select).  The orbit handler still runs for non-left
// drags (right-drag pan, shift/ctrl modifiers).
export function attachOrbitControls({ canvas, renderer, camera, onUserInteract, dialogId, onLeftDragStart, isActive = null, onSimSpeedStep = null }) {
  if (!canvas || !camera) return () => {}
  let pointer = null
  // Host-claimed flag — set when onLeftDragStart returns truthy to
  // mark this gesture as owned by the host (drag-select).  Skips
  // the orbit math entirely while still releasing pointer capture
  // on the matching up/cancel event so a follow-up gesture is
  // recognised.
  let hostClaim = false
  const handlers = {}
  // ── Arrow-key smooth scroll ─────────────────────────────────────
  //
  // Arrow presses don't pan instantly — they ADD to a pending screen-
  // delta accumulator, and a RAF loop ease-outs the accumulator into
  // panAlongGround() calls per frame.  Repeated presses pile distance
  // on top of in-flight motion, so the camera glides toward the
  // user's intended destination without jerky single-frame jumps.
  // Shift quintuples the per-press delta for fast scrolling.
  //
  // Tolerance: when both axes are < TOLERANCE pixels of pending pan
  // we drop the accumulator and stop the RAF loop entirely — no
  // sub-pixel chatter, no idle CPU burn.
  const SCROLL_STEP = 48
  const SCROLL_SHIFT_MULT = 5
  const SCROLL_DECAY = 0.18  // fraction of pending applied per frame
  const SCROLL_TOLERANCE = 0.5
  const scroll = { dx: 0, dy: 0, raf: 0 }
  const scrollStep = () => {
    scroll.raf = 0
    const ax = Math.abs(scroll.dx)
    const ay = Math.abs(scroll.dy)
    if (ax < SCROLL_TOLERANCE && ay < SCROLL_TOLERANCE) {
      // Below tolerance — discard accumulator + stop the loop.
      scroll.dx = 0
      scroll.dy = 0
      return
    }
    // Ease-out: apply DECAY × accumulator, subtract from pending.
    // The applied delta gets smaller each frame so motion glides to
    // a halt instead of a hard stop.
    const stepX = scroll.dx * SCROLL_DECAY
    const stepY = scroll.dy * SCROLL_DECAY
    scroll.dx -= stepX
    scroll.dy -= stepY
    if (typeof camera.panAlongGround === 'function') {
      camera.panAlongGround(stepX, stepY)
    }
    if (renderer && !renderer.running) renderer.requestRedraw?.()
    scroll.raf = requestAnimationFrame(scrollStep)
  }
  const queueScroll = (dx, dy) => {
    scroll.dx += dx
    scroll.dy += dy
    if (!scroll.raf) scroll.raf = requestAnimationFrame(scrollStep)
  }

  handlers.down = (e) => {
    // Host first-pass — let the host inspect every plain-left or
    // shift-left press.  Shift is a host modifier now (hosts may use
    // it for drag-select rectangle); ctrl/cmd remain camera-only
    // (ground-plane pan).  The host returns truthy to claim the
    // gesture; we then skip camera input until pointer-up so the
    // orbit pivot stays put while the host's gesture runs.
    hostClaim = false
    if (typeof onLeftDragStart === 'function'
        && e.button === 0 && !e.ctrlKey && !e.metaKey) {
      try { hostClaim = !!onLeftDragStart(e) } catch { hostClaim = false }
    }
    if (hostClaim) return
    canvas.setPointerCapture(e.pointerId)
    pointer = { x: e.clientX, y: e.clientY, button: e.button }
    // NOTE: auto-rotate is preserved on pointerdown.  Only pan
    // gestures (shift / ctrl / right-drag) drop it — see `move`
    // below.  This lets the user orbit-drag around an auto-rotating
    // unit to inspect a side without the turntable stopping.
  }

  handlers.move = (e) => {
    if (!pointer) return
    const dx = e.clientX - pointer.x
    const dy = e.clientY - pointer.y
    pointer.x = e.clientX
    pointer.y = e.clientY
    // Shift is intentionally NOT a camera modifier here — hosts
    // claim it for unit-orders gestures (e.g. drag-select), so the
    // camera leaves it alone and the gesture falls through to the
    // host via onLeftDragStart.
    // Ctrl/Cmd + drag stays as the ground-plane pan (the canonical
    // "scroll across the battlefield" gesture); right-drag stays as
    // camera-relative pan (TA convention).
    if (pointer.button === 2 || e.ctrlKey || e.metaKey) {
      // Pan moves the camera target — auto-rotate around a moving
      // target reads as "the world is sliding" instead of "the camera
      // is spinning", so we drop the turntable + any unit-tracking
      // flag the host carries.  Plain orbit-drag (the else branch
      // below) keeps both because rotateBy preserves the target.
      if (renderer && typeof renderer.setAutoRotate === 'function') {
        renderer.setAutoRotate(false)
      }
      if (e.ctrlKey || e.metaKey) {
        if (typeof onUserInteract === 'function') onUserInteract('pan')
        if (typeof camera.panAlongGround === 'function') camera.panAlongGround(dx, dy)
        else if (typeof camera.panBy === 'function') camera.panBy(dx, dy)
      } else {
        camera.panBy(dx, dy)
      }
    } else {
      // Plain drag → orbit.  0.35 scaling matches the historical
      // single-entity feel — comfortable for both fine inspection and
      // sweeping turns without needing two gears.  Auto-rotate +
      // tracking are intentionally PRESERVED — the user is just
      // looking at the scene from a different angle, not redirecting
      // the camera's pivot.
      camera.rotateBy(dx * 0.35, dy * 0.35)
    }
    if (renderer && !renderer.running) renderer.requestRedraw?.()
  }

  handlers.up = (e) => {
    if (pointer && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId)
    }
    pointer = null
    hostClaim = false
  }
  handlers.cancel = handlers.up

  handlers.wheel = (e) => {
    e.preventDefault()
    // Wheel zooms in/out from the current target — the orbit point
    // doesn't move, so auto-rotate + tracking stay sensible.  We
    // intentionally do NOT drop either flag here.
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1
    if (typeof camera.zoomBy === 'function') camera.zoomBy(factor)
    if (renderer && !renderer.running) renderer.requestRedraw?.()
  }

  // Suppress the browser's right-click context menu — right-drag is
  // pan, not a menu trigger.
  handlers.context = (e) => e.preventDefault()

  // R-key toggles auto-rotate.  Shared across host views so the same
  // muscle memory works everywhere.  Gated on the owning dialog being
  // visible (caller passes dialogId) so the shortcut doesn't fire while
  // a different tab type owns the screen.  Skipped while the user is
  // typing in any form control.
  handlers.key = (e) => {
    if (dialogId) {
      const dlg = document.getElementById(dialogId)
      if (!dlg || dlg.classList.contains('hidden')) return
    }
    // Per-tab gate: when multiple host-view tabs are open, each calls
    // attachOrbitControls and adds its own window-
    // level keydown listener.  Only the foreground tab's canvas is
    // attached to the DOM (per-tab attach/detach moves canvases in /
    // out of the stage), so `canvas.isConnected` distinguishes the
    // active listener from the backgrounded ones — without this, R
    // for auto-rotate and the arrow-key pans fire on every tab's
    // camera at once and bleed state across tabs.
    if (canvas && !canvas.isConnected) return
    // Split-pane filter — when a host opts in via `isActive`, the
    // keydown only acts on the currently-focused pane.  Without this,
    // R (auto-rotate) and the arrow-key pans fire on every pane at
    // once because all canvases sit attached to the DOM at the same
    // time.  Single-pane callers omit isActive and the gate is open.
    if (typeof isActive === 'function' && !isActive()) return
    const t = e.target
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
    if (t && t.isContentEditable) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const k = (e.key || '').toLowerCase()
    if (k === 'r') {
      e.preventDefault()
      if (renderer && typeof renderer.setAutoRotate === 'function') {
        renderer.setAutoRotate(!renderer.autoRotate)
      }
      return
    }
    // +/- (and the bare =, _).  Shift + the key zooms the camera in /
    // out; the bare key steps the simulation speed (when the host
    // supplies onSimSpeedStep).  On US layouts the symbols the user
    // presses for "+/-" already carry Shift (Shift+= → "+", Shift+- →
    // "_"), so reading e.shiftKey here lines up with the key faces.
    const isPlus = e.key === '+' || e.key === '='
    const isMinus = e.key === '-' || e.key === '_'
    if (isPlus || isMinus) {
      e.preventDefault()
      if (e.shiftKey) {
        // zoomBy(<1) zooms in, (>1) zooms out — matches the wheel.
        if (typeof camera.zoomBy === 'function') camera.zoomBy(isPlus ? 1 / 1.1 : 1.1)
        if (renderer && !renderer.running) renderer.requestRedraw?.()
      } else if (typeof onSimSpeedStep === 'function') {
        onSimSpeedStep(isPlus ? +1 : -1)
      }
      return
    }
    // Arrow keys pan the camera along the ground plane — same gesture
    // as ctrl-drag, just keyboard-driven and SMOOTHED via the scroll
    // accumulator above.  Each press adds SCROLL_STEP (or ×5 with
    // Shift) to the pending delta; a RAF loop ease-outs it into
    // panAlongGround() calls each frame so the camera glides instead
    // of teleporting.  Auto-rotate is dropped on the FIRST press (the
    // user is moving the orbit target, not looking around it).
    //
    // Up/Down direction follows panAlongGround's drag convention:
    // dy>0 advances the camera target in its facing direction (the
    // user's "look forward" expectation), dy<0 retreats.  Earlier
    // versions of this handler inverted the Y axis — the prior
    // mapping (Up = dy<0) read as backwards because mouse drag-down
    // (dy>0) is what visually advances the scene.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (typeof camera.panAlongGround !== 'function') return
      e.preventDefault()
      const mult = e.shiftKey ? SCROLL_SHIFT_MULT : 1
      const step = SCROLL_STEP * mult
      let dx = 0, dy = 0
      if (e.key === 'ArrowLeft')  dx = -step
      if (e.key === 'ArrowRight') dx =  step
      if (e.key === 'ArrowUp')    dy =  step  // advance forward
      if (e.key === 'ArrowDown')  dy = -step  // retreat
      if (renderer && typeof renderer.setAutoRotate === 'function') renderer.setAutoRotate(false)
      if (typeof onUserInteract === 'function') onUserInteract('pan')
      queueScroll(dx, dy)
    }
  }

  canvas.addEventListener('pointerdown', handlers.down)
  canvas.addEventListener('pointermove', handlers.move)
  canvas.addEventListener('pointerup', handlers.up)
  canvas.addEventListener('pointercancel', handlers.cancel)
  canvas.addEventListener('wheel', handlers.wheel, { passive: false })
  canvas.addEventListener('contextmenu', handlers.context)
  window.addEventListener('keydown', handlers.key)

  // Detach returns the resources back to the host so a view swap
  // doesn't leak listeners onto the shared canvas — including the
  // arrow-key scroll RAF loop if one is in flight.
  return function detach() {
    canvas.removeEventListener('pointerdown', handlers.down)
    canvas.removeEventListener('pointermove', handlers.move)
    canvas.removeEventListener('pointerup', handlers.up)
    canvas.removeEventListener('pointercancel', handlers.cancel)
    canvas.removeEventListener('wheel', handlers.wheel)
    canvas.removeEventListener('contextmenu', handlers.context)
    window.removeEventListener('keydown', handlers.key)
    if (scroll.raf) { cancelAnimationFrame(scroll.raf); scroll.raf = 0 }
    scroll.dx = 0; scroll.dy = 0
  }
}
