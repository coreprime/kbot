// armed-cursor.js
//
// Reusable "armed action" cursor overlay shared by the single-unit
// editor (MvControls) and the multi-unit Sandbox.  When the user
// arms a command (Move / Attack / Primary / Secondary / Tertiary)
// the canvas's native cursor is hidden and an absolutely-positioned
// <img> tracks the pointer with the TA-style animated GAF for that
// action.  Same visual the live game uses for its order cursors.
//
// Usage:
//   const cursor = new ArmedCursor({ canvas, host })
//   cursor.setSlot('move')     // arm
//   cursor.setSlot(null)       // disarm
//   cursor.dispose()           // detach + remove overlay
//
// Pointer-tracking listeners attach to `canvas` so the overlay only
// follows the mouse while it's inside the rendering surface — once
// the user moves over to the Controls panel the native cursor returns
// so they can re-click the disarm button.

export class ArmedCursor {
  constructor({ canvas, host }) {
    this.canvas = canvas
    // host = where the overlay <img> lives.  Defaults to body so it
    // composites over any inspector panel; callers can pass the
    // dialog root to scope it tighter when needed.
    this.host = host || document.body
    this._overlay = null
    this._slot = null
    this._inside = true
    this._x = 0
    this._y = 0
    this._wired = false
    this._handlers = null
    this.#wire()
  }

  // setSlot arms ('move' | 'primary' | 'secondary' | 'tertiary' |
  // 'attack') or disarms (null).  Slot mapping:
  //   move                        → cursormove
  //   primary/secondary/tertiary/ → cursorattack
  //   attack                        (anything weapon-related uses
  //                                  the attack glyph)
  setSlot(slot) {
    const want = (slot === 'move' || slot === 'attack' ||
                  slot === 'primary' || slot === 'secondary' || slot === 'tertiary')
      ? slot
      : null
    if (this._slot === want) return
    this._slot = want
    this.#refresh()
  }

  // dispose removes the overlay + detaches listeners.  Called on
  // viewer tear-down so we don't leak per-mode singletons.
  dispose() {
    if (this._overlay) {
      this._overlay.remove()
      this._overlay = null
    }
    if (this.canvas) this.canvas.style.cursor = ''
    if (this._wired && this.canvas && this._handlers) {
      this.canvas.removeEventListener('mousemove', this._handlers.move)
      this.canvas.removeEventListener('mouseleave', this._handlers.leave)
      this.canvas.removeEventListener('mouseenter', this._handlers.enter)
    }
    this._wired = false
    this._handlers = null
  }

  #wire() {
    if (!this.canvas || this._wired) return
    this._handlers = {
      move: (e) => { this._x = e.clientX; this._y = e.clientY; this.#refresh() },
      leave: () => { this._inside = false; this.#refresh() },
      enter: () => { this._inside = true; this.#refresh() },
    }
    this.canvas.addEventListener('mousemove', this._handlers.move)
    this.canvas.addEventListener('mouseleave', this._handlers.leave)
    this.canvas.addEventListener('mouseenter', this._handlers.enter)
    this._wired = true
  }

  #refresh() {
    const visible = this._slot && this._inside
    if (!visible) {
      if (this._overlay) this._overlay.style.display = 'none'
      if (this.canvas) this.canvas.style.cursor = ''
      return
    }
    if (!this._overlay) {
      const img = document.createElement('img')
      img.className = 'mv-ctrl-armed-cursor'
      this.host.appendChild(img)
      this._overlay = img
    }
    const img = this._overlay
    const srcName = (this._slot === 'move') ? 'cursormove' : 'cursorattack'
    const want = `/api/studio/cursor/${srcName}`
    if (img.dataset.src !== want) {
      img.dataset.src = want
      img.src = want
    }
    img.style.display = ''
    img.style.left = this._x + 'px'
    img.style.top = this._y + 'px'
    // Hide the native cursor — the overlay glyph IS the cursor.
    if (this.canvas) this.canvas.style.cursor = 'none'
  }
}
