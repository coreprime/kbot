// armed-cursor.js
//
// Reusable "armed action" cursor overlay shared by single-entity
// and multi-entity host views.  When the user arms a command
// (Move / Attack / Primary / Secondary / Tertiary)
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
    // _armed wins over _ambient when both are set — see setArmed /
    // setAmbient.  Single-slot callers just use setSlot which leaves
    // both null and drives _slot directly.
    this._armed = null
    this._ambient = null
    this._inside = true
    this._x = 0
    this._y = 0
    // _kind is an optional flavour modifier for weapon-arming slots:
    // 'airstrike' swaps the cursorattack glyph for cursorairstrike, used when
    // the armed weapon is a dropped bomb (TDF `dropped=1`).  null = default.
    this._kind = null
    // _visible is the host's tab-active gate.  Defaults to true so a
    // single-tab consumer doesn't have to wire setVisible explicitly.
    // The host's deactivate path (MvControls.setSilenced /
    // SandboxView.setSilenced) flips this off so a backgrounded tab's
    // overlay disappears even without a mousemove to drive #refresh.
    this._visible = true
    this._wired = false
    this._handlers = null
    this.#wire()
  }

  // setSlot arms ('move' | 'primary' | 'secondary' | 'tertiary' |
  // 'attack' | 'select' | 'normal') or disarms (null).  Slot mapping:
  //   move                        → cursormove
  //   primary/secondary/tertiary/ → cursorattack
  //   attack                        (anything weapon-related uses
  //                                  the attack glyph)
  //   select                      → cursorselect (hover-a-unit glyph)
  //   normal                      → cursornormal (idle TA cursor)
  //
  // The 'select' / 'normal' slots are AMBIENT cursors — the host can
  // leave them set permanently and they'll show whenever no armed
  // slot is active.  Armed slots (move/attack/*) take priority over
  // ambient via setAmbient + setArmed below.  For back-compat
  // setSlot() still works as a single-slot setter.
  setSlot(slot) {
    const want = this.#normalizeSlot(slot)
    if (this._slot === want) return
    this._slot = want
    this._armed = null
    this._ambient = null
    this.#refresh()
  }

  // setArmed sets the armed (high-priority) slot.  When null, the
  // ambient slot (see setAmbient) takes over.  Use for command
  // arming — Move / Primary / etc — that should clearly trump the
  // idle hover cursor.
  setArmed(slot) {
    const want = this.#normalizeSlot(slot)
    if (this._armed === want) return
    this._armed = want
    this._slot = this._armed || this._ambient
    this.#refresh()
  }

  // setAmbient sets the ambient (low-priority) slot.  Replaced by
  // setArmed when armed is non-null; shown otherwise.  Use for the
  // idle / hover cursor (normal vs select-on-unit-hover) that hosts
  // want always-on while no command is armed.
  setAmbient(slot) {
    const want = this.#normalizeSlot(slot)
    if (this._ambient === want) return
    this._ambient = want
    this._slot = this._armed || this._ambient
    this.#refresh()
  }

  // setKind tags the current weapon-arming slot with a flavour that picks a
  // different glyph at refresh time.  Currently:
  //   'airstrike' → cursorairstrike (used when the armed weapon's TDF flags
  //                  dropped=1 — bombers releasing area-effect bombs).
  //   null        → the default (cursorattack for weapon slots).
  // The kind is independent of slot priority — it only modifies the rendered
  // glyph, not which slot the click routes to.
  setKind(kind) {
    const want = (kind === 'airstrike') ? 'airstrike' : null
    if (this._kind === want) return
    this._kind = want
    this.#refresh()
  }

  // setVisible flips a hard-hide flag the host can flip on the
  // outgoing tab during a tab swap, even though our slot is still
  // armed.  Without this, the overlay glyph would stay frozen at the
  // last (x, y) captured before the canvas was pulled out of the
  // DOM — refresh only re-runs on events, and a backgrounded canvas
  // generates none.  Idempotent.
  setVisible(on) {
    const want = !!on
    if (this._visible === want) return
    this._visible = want
    this.#refresh()
  }

  // #normalizeSlot returns one of the known names or null.  Centralised
  // so setSlot / setArmed / setAmbient share the validation.
  #normalizeSlot(slot) {
    if (slot === 'move' || slot === 'attack' ||
        slot === 'primary' || slot === 'secondary' || slot === 'tertiary' ||
        slot === 'select' || slot === 'normal') return slot
    return null
  }

  // dispose removes the overlay + detaches listeners.  Called on
  // view tear-down so we don't leak per-mode singletons.
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
    // Hide the overlay when our owning canvas has been pulled out of
    // the DOM — tab swaps detach the inactive tab's canvas but leave
    // its ArmedCursor alive, so without this gate a setSlot() called
    // by the still-alive MvControls (e.g. on a Controls panel mode
    // flip) would render the cursor overlay frozen at whatever x/y
    // the mousemove last captured before the canvas was detached.
    const canvasDetached = this.canvas && !this.canvas.isConnected
    const visible = this._visible && this._slot && this._inside && !canvasDetached
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
    let srcName
    switch (this._slot) {
      case 'move':   srcName = 'cursormove'; break
      case 'select': srcName = 'cursorselect'; break
      case 'normal': srcName = 'cursornormal'; break
      // primary / secondary / tertiary / attack share the attack glyph by
      // default — but a `dropped` weapon (TDF dropped=1) is a bomb run, so
      // the host can tag the kind as 'airstrike' to swap in cursorairstrike.
      default:
        srcName = (this._kind === 'airstrike') ? 'cursorairstrike' : 'cursorattack'
        break
    }
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
