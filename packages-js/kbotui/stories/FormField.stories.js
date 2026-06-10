import { html } from '../index.js'
import { useState } from 'preact/hooks'
import { FormField, TextField, SelectField } from '../form-field.js'

export default {
  title: 'Forms/FormField',
  parameters: { layout: 'fullscreen' },
}

// The generic wrapper on its own, showing the label + hint and the
// label + error variants side by side.
export const Wrapper = {
  render: () => html`
    <div style="max-width:420px;display:grid;gap:16px">
      <${FormField} label="Name" htmlFor="f1" hint="Shown beneath the control.">
        <input id="f1" class="kb-input" value="My Arm Overhaul" />
      <//>
      <${FormField} label="Work folder" htmlFor="f2" error="Work folder is required">
        <input id="f2" class="kb-input" value="" placeholder="/Users/you/kbot-workspaces/…" />
      <//>
    </div>
  `,
}

// TextField + SelectField composed into the same form the New Workspace
// dialog uses, so the controls are exercised together.
function FormDemo() {
  const [name, setName] = useState('Arm Overhaul')
  const [base, setBase] = useState('ta-31c')
  const [dir, setDir] = useState('/Users/you/kbot-workspaces/arm-overhaul')
  return html`
    <div style="max-width:460px;display:grid;gap:14px">
      <${TextField} id="n" label="Name" value=${name} onInput=${setName}
        placeholder="My Arm Overhaul" />
      <${SelectField} id="b" label="Base context" value=${base} onChange=${setBase}
        options=${[
          { value: 'ta-31c', label: 'ta-31c (totala)' },
          { value: 'tak-30bb', label: 'tak-30bb (takingdoms)' },
        ]} />
      <${TextField} id="d" label="Work folder" value=${dir} onInput=${setDir}
        hint="Defaults under your workspaces folder; override if you like." />
    </div>
  `
}

export const NewWorkspaceForm = { render: () => html`<${FormDemo} />` }
