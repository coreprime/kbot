// export-mod-dialog.js
//
// The picker's Export mod dialog: pick the archive format (.ufo, .ccx or
// .hpi for Total Annihilation) and file name, see the server's preflight
// check — where the archive would rank in TA 3.1c's mount order, and which
// of the workspace's files an archive or loose file the game reads first
// also provides (those must ship as loose files to take effect) — then
// download.

import { useEffect, useState } from 'preact/hooks'
import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { DialogModal } from '@coreprime/kbot-ui/dialog-modal'
import { TextField, SelectField } from '@coreprime/kbot-ui/form-field'
import { exportFormats, exportURL, preflightLines, shadowedRows, slugify } from './export-mod.js'

// PREFLIGHT_DELAY_MS debounces the check while the name is being typed:
// without an open session the server mounts the base install for it.
const PREFLIGHT_DELAY_MS = 450

export function ExportModDialog({ workspace, onClose }) {
  const open = !!workspace
  const formats = exportFormats(workspace && workspace.game)
  const [ext, setExt] = useState(formats[0].value)
  const [name, setName] = useState('')
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setExt(exportFormats(workspace.game)[0].value)
    setName(workspace.name || '')
    setCheck(null)
    setError('')
  }, [open, workspace && workspace.path])

  // The server slugs the name the same way; checking and downloading
  // under the slug keeps the dialog's hint and the file in step.
  const fileName = name.trim() ? slugify(name) : ''

  useEffect(() => {
    if (!open || !fileName) return undefined
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      setError('')
      try {
        const r = await fetch(exportURL(workspace.path, { ext, name: fileName, preflight: true }))
        if (!r.ok) throw new Error(await r.text())
        const body = await r.json()
        if (!cancelled) setCheck(body)
      } catch (e) {
        if (!cancelled) { setCheck(null); setError(e.message || String(e)) }
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, PREFLIGHT_DELAY_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, ext, fileName])

  if (!open) return null
  const download = () => {
    window.open(exportURL(workspace.path, { ext, name: fileName }), '_blank')
    onClose()
  }
  const lines = preflightLines(check)
  const shadowed = shadowedRows(check)

  return html`
    <${DialogModal}
      open=${open}
      title=${`Export ${workspace.name}`}
      sub="Packs the workspace's changed files into one archive for the game directory."
      cardClass="dialog-card-wide"
      onCancel=${onClose}
      actions=${[
        { label: 'Cancel', onClick: onClose },
        { label: 'Download', primary: true, onClick: download, disabled: !fileName },
      ]}
    >
      <div class="form-grid">
        <${SelectField} id="export-ext" label="Archive type" value=${ext}
          onChange=${setExt} options=${formats} />
        <${TextField} id="export-name" label="File name" value=${name}
          onInput=${setName}
          hint=${`Downloads as ${fileName || '…'}.${ext}`} />
      </div>
      <div class="export-check">
        ${busy ? html`<p class="export-check-line">Checking the base install…</p>` : null}
        ${error ? html`<p class="export-check-line export-check-error">${error}</p>` : null}
        ${lines.map((l, i) => html`<p key=${i} class=${'export-check-line export-check-' + l.tone}>${l.text}</p>`)}
        ${shadowed.rows.length > 0 ? html`
          <ul class="export-check-list">
            ${shadowed.rows.map((r) => html`<li key=${r.path}><code>${r.path}</code> ← ${r.by}</li>`)}
            ${shadowed.more > 0 ? html`<li>… and ${shadowed.more} more</li>` : null}
          </ul>` : null}
        ${check && check.hint ? html`<p class="export-check-line export-check-hint">${check.hint}</p>` : null}
      </div>
    <//>
  `
}
