// locals.js
//
// Locals / Globals / Stack tray for the thread-code-view debugger.
// Renders editable integer rows for the current thread's local
// variable bank + the runtime's static (global) vars + a read-only
// snapshot of the operand stack.  Each editable row writes the
// parsed value back through a setter callback so the live runtime
// sees the edit on its next tick.
//
// asm.js' refreshMvThreadCodeHighlight calls renderMvThreadCodeLocals
// once per 4 Hz inspector tick (or on demand after a Step), reaching
// it through the existing hostCallbacks.renderMvThreadCodeLocals
// seam.  No other module talks to this code; pulling it into the
// debugger/ folder finishes the round-of-debugger extraction.

// mvBuildVarRow builds one editable variable row.  `getValue` reads
// the current number; `setValue` writes the parsed result back.
// Both contract the value to a 32-bit signed int (TA's COB stack is
// int32).  Returns the row element + the value <span> so the caller
// can append it where needed.
function mvBuildVarRow(label, getValue, setValue) {
  const row = document.createElement('div')
  const k = document.createElement('span')
  k.textContent = label
  const v = document.createElement('span')
  v.textContent = String(getValue() | 0)
  v.contentEditable = 'true'
  v.spellcheck = false
  v.addEventListener('focus', () => { v.dataset.editing = '1' })
  v.addEventListener('blur', () => {
    v.dataset.editing = ''
    const parsed = parseInt(v.textContent.trim(), 10)
    const next = Number.isFinite(parsed) ? (parsed | 0) : (getValue() | 0)
    setValue(next)
    v.textContent = String(next)
  })
  v.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); v.blur() }
    if (e.key === 'Escape') { v.textContent = String(getValue() | 0); v.blur() }
  })
  row.appendChild(k); row.appendChild(v)
  return { row, valueEl: v }
}

// renderMvThreadCodeLocals rebuilds the three variable-tray sections
// (Locals / Globals / Stack).  Locals + Globals are editable through
// mvBuildVarRow; Stack is a read-only snapshot ordered top-first so
// the newest pushes sit at the top of the list.  Each section skips
// its rebuild while the user is actively editing a value — replacing
// the DOM mid-edit would yank the cursor + commit a stale buffer.
export function renderMvThreadCodeLocals(state, thread) {
  const panel = state.panel
  const locals = panel.querySelector('.mv-thread-code-locals')
  const stack = panel.querySelector('.mv-thread-code-stack')
  const globals = panel.querySelector('.mv-thread-code-globals')
  if (locals) {
    // Skip a rebuild while the user is editing a value — replacing
    // the DOM would yank the cursor mid-edit.
    if (!locals.querySelector('span[data-editing="1"]')) {
      locals.replaceChildren()
      if (thread && thread.locals && thread.locals.length) {
        for (let i = 0; i < thread.locals.length; i++) {
          const { row } = mvBuildVarRow(`L${i}`,
            () => thread.locals[i],
            (n) => { thread.locals[i] = n | 0 })
          locals.appendChild(row)
        }
      } else {
        const empty = document.createElement('div')
        empty.style.color = 'var(--muted)'
        empty.style.fontStyle = 'italic'
        empty.textContent = thread ? '—' : 'no thread'
        locals.appendChild(empty)
      }
    }
  }
  if (globals) {
    if (!globals.querySelector('span[data-editing="1"]')) {
      globals.replaceChildren()
      // staticVars lives on the CobUnit (per-unit globals), not the
      // multi-unit CobRuntime — the legacy reach for `runtime.staticVars`
      // returned undefined after the multi-unit migration and the
      // Globals tray quietly emptied out.
      const u = state.cob?.unit
      if (u && u.staticVars && u.staticVars.length) {
        for (let i = 0; i < u.staticVars.length; i++) {
          const { row } = mvBuildVarRow(`global_${i}`,
            () => u.staticVars[i],
            (n) => { u.staticVars[i] = n | 0 })
          globals.appendChild(row)
        }
      } else {
        const empty = document.createElement('div')
        empty.style.color = 'var(--muted)'
        empty.style.fontStyle = 'italic'
        empty.textContent = '—'
        globals.appendChild(empty)
      }
    }
  }
  if (stack) {
    stack.replaceChildren()
    if (thread && thread.stack && thread.stack.length) {
      // Render top-of-stack first so the newest pushes are at the top
      // (matches a typical stack-trace display).
      for (let i = thread.stack.length - 1; i >= 0; i--) {
        const row = document.createElement('div')
        const k = document.createElement('span')
        k.textContent = i === thread.stack.length - 1 ? 'top' : ' '
        const v = document.createElement('span')
        v.textContent = String(thread.stack[i] | 0)
        row.appendChild(k); row.appendChild(v)
        stack.appendChild(row)
      }
    } else {
      const empty = document.createElement('div')
      empty.style.color = 'var(--muted)'
      empty.style.fontStyle = 'italic'
      empty.textContent = '—'
      stack.appendChild(empty)
    }
  }
}
