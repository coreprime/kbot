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
//
// Auto-rotate is dropped on any user gesture so the camera holds the
// angle the user just chose — matches the live game's instinct that
// "if I touched it, stop moving it."  The optional `onUserInteract`
// hook lets the host clear external state (e.g. the "Tracking"
// checkbox the Renderer panel exposes) when the user starts driving
// the camera manually.

export function attachOrbitControls({ canvas, renderer, camera, onUserInteract }) {
  if (!canvas || !camera) return () => {}
  let pointer = null
  const handlers = {}

  handlers.down = (e) => {
    canvas.setPointerCapture(e.pointerId)
    pointer = { x: e.clientX, y: e.clientY, button: e.button, lockDxAccum: 0, lockDyAccum: 0 }
    // Any user grab drops auto-rotate.  The common case for stopping
    // the turntable is "I want to look at this manually."
    if (renderer && typeof renderer.setAutoRotate === 'function') {
      renderer.setAutoRotate(false)
    }
    if (typeof onUserInteract === 'function') onUserInteract('pointerdown')
  }

  handlers.move = (e) => {
    if (!pointer) return
    const dx = e.clientX - pointer.x
    const dy = e.clientY - pointer.y
    pointer.x = e.clientX
    pointer.y = e.clientY
    if (pointer.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey) {
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
      // sweeping turns without needing two gears.
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
    if (renderer && typeof renderer.setAutoRotate === 'function') {
      renderer.setAutoRotate(false)
    }
    if (typeof onUserInteract === 'function') onUserInteract('wheel')
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1
    if (typeof camera.zoomBy === 'function') camera.zoomBy(factor)
    if (renderer && !renderer.running) renderer.requestRedraw?.()
  }

  // Suppress the browser's right-click context menu — right-drag is
  // pan, not a menu trigger.
  handlers.context = (e) => e.preventDefault()

  canvas.addEventListener('pointerdown', handlers.down)
  canvas.addEventListener('pointermove', handlers.move)
  canvas.addEventListener('pointerup', handlers.up)
  canvas.addEventListener('pointercancel', handlers.cancel)
  canvas.addEventListener('wheel', handlers.wheel, { passive: false })
  canvas.addEventListener('contextmenu', handlers.context)

  // Detach returns the resources back to the host so a viewer swap
  // doesn't leak listeners onto the shared canvas.
  return function detach() {
    canvas.removeEventListener('pointerdown', handlers.down)
    canvas.removeEventListener('pointermove', handlers.move)
    canvas.removeEventListener('pointerup', handlers.up)
    canvas.removeEventListener('pointercancel', handlers.cancel)
    canvas.removeEventListener('wheel', handlers.wheel)
    canvas.removeEventListener('contextmenu', handlers.context)
  }
}
