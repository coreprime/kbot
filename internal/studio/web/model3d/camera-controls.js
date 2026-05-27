// camera-controls.js
//
// Reusable orbit-camera input wiring shared by the single-unit editor
// (ModelViewer) and the multi-unit Sandbox.  Pulls the pointer / wheel
// gestures into one place so both views feel identical:
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

export function attachOrbitControls({ canvas, renderer, camera, onUserInteract, dialogId }) {
  if (!canvas || !camera) return () => {}
  let pointer = null
  const handlers = {}

  handlers.down = (e) => {
    canvas.setPointerCapture(e.pointerId)
    pointer = { x: e.clientX, y: e.clientY, button: e.button, lockDxAccum: 0, lockDyAccum: 0 }
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
    if (pointer.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey) {
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
      } else if (e.shiftKey) {
        if (typeof onUserInteract === 'function') onUserInteract('pan')
        // Shift = axis-locked pan.  Pick the dominant axis from the
        // gesture's accumulated motion so a single jittery frame
        // can't flip the lock back and forth.
        pointer.lockDxAccum += dx
        pointer.lockDyAccum += dy
        if (Math.abs(pointer.lockDxAccum) > Math.abs(pointer.lockDyAccum)) {
          camera.panBy(dx, 0)
        } else {
          camera.panBy(0, dy)
        }
      } else {
        camera.panBy(dx, dy)
      }
    } else {
      // Plain drag → orbit.  0.35 scaling matches the unit editor's
      // historical feel — comfortable for both fine inspection and
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

  // R-key toggles auto-rotate.  Shared across views so the same
  // muscle memory works in unit editor + sandbox.  Gated on the
  // owning dialog being visible (caller passes dialogId) so the
  // shortcut doesn't fire while a different tab type owns the
  // screen.  Skipped while the user is typing in any form control.
  handlers.key = (e) => {
    if (dialogId) {
      const dlg = document.getElementById(dialogId)
      if (!dlg || dlg.classList.contains('hidden')) return
    }
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
    }
  }

  canvas.addEventListener('pointerdown', handlers.down)
  canvas.addEventListener('pointermove', handlers.move)
  canvas.addEventListener('pointerup', handlers.up)
  canvas.addEventListener('pointercancel', handlers.cancel)
  canvas.addEventListener('wheel', handlers.wheel, { passive: false })
  canvas.addEventListener('contextmenu', handlers.context)
  window.addEventListener('keydown', handlers.key)

  // Detach returns the resources back to the host so a viewer swap
  // doesn't leak listeners onto the shared canvas.
  return function detach() {
    canvas.removeEventListener('pointerdown', handlers.down)
    canvas.removeEventListener('pointermove', handlers.move)
    canvas.removeEventListener('pointerup', handlers.up)
    canvas.removeEventListener('pointercancel', handlers.cancel)
    canvas.removeEventListener('wheel', handlers.wheel)
    canvas.removeEventListener('contextmenu', handlers.context)
    window.removeEventListener('keydown', handlers.key)
  }
}
