// dialog-modal.js
//
// Shared chrome for centred modal dialogs — title, optional sub-text,
// body slot, action buttons row, backdrop + Esc-to-cancel handling.
// Same CSS classes as the legacy static dialogs (`.dialog`,
// `.dialog-card`, `.dialog-actions`, `.btn`, `.btn.primary`) so the
// existing studio.css rules apply unchanged.
//
// Modeled after the confirm-dialog migration: a wrapper component that
// other React-managed modals (Settings, Open Unit, Open Map, Resize,
// OTA, etc.) compose with their own body content.  Centralises the
// "lazy mount, signal-driven open, keyboard handling, focus the first
// action" plumbing so each migrated modal only writes its own form +
// state.

import { useEffect } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'

// DialogModal — props:
//   open         — boolean, must be true for the modal to render
//   title        — header text
//   sub          — optional secondary paragraph below title
//   cardClass    — extra class added to `.dialog-card` (e.g.
//                  'dialog-card-wide', 'dialog-card-xwide')
//   children     — body content; rendered between sub and the action row
//   actions      — array of { label, onClick, primary, danger, disabled }
//                  rendered right-aligned in `.dialog-actions`
//   onCancel     — fired on Esc / backdrop click / explicit "Cancel"
//                  action (when no onClick override on a cancel action)
//   autofocusActionLabel — if provided, focuses the matching action
//                  button on mount (defaults to the primary action)
export function DialogModal({
  open,
  title,
  sub = '',
  cardClass = '',
  children,
  actions = [],
  onCancel,
  autofocusActionLabel = null,
}) {
  // Esc-to-cancel.  Capture phase so this beats any panel-level
  // listener that might also Esc-close (the modal stack should
  // unwind from the topmost surface first).
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel && onCancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])
  if (!open) return null
  const cardCls = ('dialog-card ' + (cardClass || '')).trim()
  // First primary action gets autofocus by default — keyboard users
  // can Enter to commit immediately.  Caller can override with
  // `autofocusActionLabel` to point at a specific button.
  const focusLabel = autofocusActionLabel
    || (actions.find((a) => a.primary) || {}).label
    || null
  return html`
    <div class="dialog mv-modal-dialog">
      <div class=${cardCls}>
        <h1>${title}</h1>
        ${sub ? html`<p class="dialog-sub">${sub}</p>` : null}
        ${children}
        ${actions.length > 0 ? html`
          <div class="dialog-actions">
            ${actions.map((a) => {
              const cls = [
                'btn',
                a.primary ? 'primary' : '',
                a.danger ? 'danger' : '',
              ].filter(Boolean).join(' ')
              const refFn = (el) => {
                if (!el) return
                if (focusLabel && a.label === focusLabel) el.focus()
              }
              return html`
                <button key=${a.label}
                        class=${cls}
                        disabled=${!!a.disabled}
                        ref=${refFn}
                        onClick=${a.onClick}>
                  ${a.label}
                </button>
              `
            })}
          </div>
        ` : null}
      </div>
    </div>
  `
}
