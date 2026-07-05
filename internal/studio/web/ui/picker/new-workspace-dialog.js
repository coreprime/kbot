// new-workspace-dialog.js
//
// Native New Workspace dialog: name, base context, and a work folder
// that defaults to <workspaceRoot>/<slug(name)> (OS-specific root from
// the hub) and auto-tracks the name until the user overrides it.
//
// Built on @coreprime/kbot-ui DialogModal + FormField controls so it matches the
// editor's other dialogs.

import { useEffect, useState } from 'preact/hooks'
import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { DialogModal } from '@coreprime/kbot-ui/dialog-modal'
import { TextField, SelectField } from '@coreprime/kbot-ui/form-field'

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// joinPath appends a name-slug to the workspace root, picking the
// separator the root already uses (so Windows paths stay backslashed).
function joinPath(root, name) {
  if (!root) return ''
  const slug = slugify(name) || 'workspace'
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return root.replace(/[/\\]+$/, '') + sep + slug
}

export function NewWorkspaceDialog({ open, base, contexts, workspaceRoot, onCancel, onCreate }) {
  const [name, setName] = useState('')
  const [baseAlias, setBaseAlias] = useState('')
  const [dir, setDir] = useState('')
  const [pathEdited, setPathEdited] = useState(false)
  const [error, setError] = useState('')

  // (Re)initialise each time the dialog opens for a given base context.
  useEffect(() => {
    if (!open) return
    const initialName = base ? `${base} mod` : 'new mod'
    setName(initialName)
    setBaseAlias(base || (contexts[0] && contexts[0].alias) || '')
    setDir(joinPath(workspaceRoot, initialName))
    setPathEdited(false)
    setError('')
  }, [open, base])

  // Keep the path tracking the name until the user edits it by hand.
  useEffect(() => {
    if (open && !pathEdited) setDir(joinPath(workspaceRoot, name))
  }, [name, open, pathEdited, workspaceRoot])

  const submit = () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (!baseAlias) { setError('Pick a base context'); return }
    if (!dir.trim()) { setError('Work folder is required'); return }
    onCreate({ kind: 'new', name: name.trim(), base: baseAlias, dir: dir.trim() })
  }

  const ctxOptions = contexts.map((c) => ({ value: c.alias, label: `${c.alias} (${c.game})` }))

  return html`
    <${DialogModal}
      open=${open}
      title="New workspace"
      sub="Create a local mod workspace layered on a base context. Your edits live here and can be exported as an HPI later."
      onCancel=${onCancel}
      actions=${[
        { label: 'Cancel', onClick: onCancel },
        { label: 'Create & open', primary: true, onClick: submit },
      ]}
    >
      <div class="form-grid">
        <${TextField} id="ws-name" label="Name" value=${name} onInput=${setName}
          placeholder="My Arm Overhaul" />
        <${SelectField} id="ws-base" label="Base context" value=${baseAlias}
          onChange=${setBaseAlias} options=${ctxOptions} />
        <${TextField} id="ws-dir" label="Work folder" value=${dir}
          onInput=${(v) => { setPathEdited(true); setDir(v) }}
          hint="Defaults under your workspaces folder; override if you like." />
        ${error ? html`<div class="form-field-msg form-field-error">${error}</div>` : null}
      </div>
    <//>
  `
}
