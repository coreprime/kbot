// form-field.js
//
// Labelled form controls for KBot Studio dialogs. FormField is the
// generic wrapper (label + control slot + hint/error line); TextField
// and SelectField are the common concrete controls built on it. They
// use the studio.css design tokens so they match the rest of the chrome
// in both the app and Storybook.

import { htm as html } from '@kbot/ui/htm-bind'

// FormField — props:
//   label    — label text (optional)
//   htmlFor  — id of the control the label points at
//   hint     — secondary helper line shown when there's no error
//   error    — error text; when set, shown instead of the hint and the
//              field gets the `has-error` modifier
//   children — the control (input/select/…)
export function FormField({ label, htmlFor, hint, error, children }) {
  const cls = error ? 'form-field has-error' : 'form-field'
  return html`
    <div class=${cls}>
      ${label ? html`<label class="form-field-label" for=${htmlFor}>${label}</label>` : null}
      ${children}
      ${error
        ? html`<div class="form-field-msg form-field-error">${error}</div>`
        : hint
          ? html`<div class="form-field-msg form-field-hint">${hint}</div>`
          : null}
    </div>
  `
}

// TextField — labelled text input. Calls onInput(value) with the raw
// string value (not the event) so call sites stay terse.
export function TextField({
  id, label, value, onInput, placeholder = '', hint, error, type = 'text',
}) {
  return html`
    <${FormField} label=${label} htmlFor=${id} hint=${hint} error=${error}>
      <input
        id=${id}
        class="kb-input"
        type=${type}
        value=${value}
        placeholder=${placeholder}
        onInput=${(e) => onInput && onInput(e.target.value)}
      />
    <//>
  `
}

// SelectField — labelled <select>. `options` accepts either bare strings
// or { value, label } objects. Calls onChange(value).
export function SelectField({
  id, label, value, onChange, options = [], hint, error,
}) {
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  return html`
    <${FormField} label=${label} htmlFor=${id} hint=${hint} error=${error}>
      <select
        id=${id}
        class="kb-select"
        value=${value}
        onChange=${(e) => onChange && onChange(e.target.value)}
      >
        ${norm.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
      </select>
    <//>
  `
}
