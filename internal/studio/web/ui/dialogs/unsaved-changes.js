// unsaved-changes.js
//
// "Discard / Save / Cancel" prompt that fires when the user closes
// a tab with pending edits.  Resolves to 'save', 'discard' or
// 'cancel'; Escape resolves 'cancel' so the close is aborted
// rather than silently throwing away unsaved work.
//
// Mirrors the imperative-Promise pattern confirmDialog uses, so
// the closeTab handler can `await` the user's choice without
// untying its own logic.  Falls back to window.confirm when the
// static #unsaved-dialog markup isn't present (early boot, headless
// test harness).

export function unsavedChangesDialog({ mapName } = {}) {
  return new Promise((resolve) => {
    const dlg = document.querySelector('#unsaved-dialog')
    const msg = document.querySelector('#unsaved-message')
    const saveBtn = document.querySelector('#unsaved-save')
    const discardBtn = document.querySelector('#unsaved-discard')
    const cancelBtn = document.querySelector('#unsaved-cancel')
    if (!dlg || !saveBtn || !discardBtn || !cancelBtn) {
      resolve(window.confirm(`Close ${mapName} without saving?`) ? 'discard' : 'cancel')
      return
    }
    msg.textContent = `"${mapName || 'This map'}" has changes that haven't been saved. What would you like to do?`
    dlg.classList.remove('hidden')
    const cleanup = (result) => {
      dlg.classList.add('hidden')
      saveBtn.removeEventListener('click', onSave)
      discardBtn.removeEventListener('click', onDiscard)
      cancelBtn.removeEventListener('click', onCancel)
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }
    const onSave = () => cleanup('save')
    const onDiscard = () => cleanup('discard')
    const onCancel = () => cleanup('cancel')
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup('cancel') }
    }
    saveBtn.addEventListener('click', onSave)
    discardBtn.addEventListener('click', onDiscard)
    cancelBtn.addEventListener('click', onCancel)
    document.addEventListener('keydown', onKey, true)
    saveBtn.focus()
  })
}
