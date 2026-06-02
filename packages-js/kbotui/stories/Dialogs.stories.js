import { html } from '../index.js'
import { useState } from 'preact/hooks'
import { DialogModal } from '../dialog-modal.js'
import { confirmDialog } from '../confirm-dialog.js'

export default {
  title: 'Chrome/Dialogs',
  parameters: { layout: 'fullscreen' },
}

// The shared modal shell: title, sub-text, a body slot, and a
// right-aligned action row.  Toggle it from the trigger button.
function ModalDemo() {
  const [open, setOpen] = useState(true)
  return html`
    <div style="padding:24px">
      <button class="btn" onClick=${() => setOpen(true)}>Open dialog</button>
      <${DialogModal}
        open=${open}
        title="Resize Map"
        sub="Choose a new size — content outside the new bounds is cropped."
        actions=${[
          { label: 'Cancel', onClick: () => setOpen(false) },
          { label: 'Resize', primary: true, onClick: () => setOpen(false) },
        ]}
        onCancel=${() => setOpen(false)}
      >
        <div style="padding:8px 0;display:grid;gap:8px;color:var(--muted)">
          <label>Width <input type="number" value="64" style="width:80px" /></label>
          <label>Height <input type="number" value="64" style="width:80px" /></label>
        </div>
      <//>
    </div>
  `
}

export const Modal = { render: () => html`<${ModalDemo} />` }

// The imperative confirm() replacement: returns a Promise<boolean>.
function ConfirmDemo() {
  const [last, setLast] = useState('—')
  const ask = async (danger) => {
    const ok = await confirmDialog({
      title: danger ? 'Clear Field?' : 'Confirm',
      message: danger
        ? 'This removes every spawned unit from the sandbox. This cannot be undone.'
        : 'Proceed with this action?',
      okLabel: danger ? 'Clear' : 'OK',
      okDanger: danger,
    })
    setLast(ok ? 'confirmed' : 'cancelled')
  }
  return html`
    <div style="padding:24px;display:grid;gap:10px;justify-items:start">
      <button class="btn" onClick=${() => ask(false)}>Ask…</button>
      <button class="btn primary danger" onClick=${() => ask(true)}>Clear Field…</button>
      <div style="color:var(--muted)">Last choice: <strong style="color:var(--text)">${last}</strong></div>
    </div>
  `
}

export const Confirm = { render: () => html`<${ConfirmDemo} />` }
