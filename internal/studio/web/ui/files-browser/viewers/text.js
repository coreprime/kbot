// text.js
//
// Plain raw-text view for configs and scripts that don't get a richer
// syntax-highlighted treatment.  Fetches the bytes as text (honouring
// the active layer) and shows them with line numbers.

import { htm as html } from '@kbot/ui/htm-bind'
import { useRawText, Loading, ErrorMsg } from '../components/async.js'

export function TextTab({ path, source }) {
  const { data, loading, error } = useRawText(path, source)
  if (loading) return html`<${Loading} />`
  if (error) return html`<${ErrorMsg} message=${error} />`
  const lines = (data || '').split('\n')
  return html`
    <div class="fx-codeview">
      <pre class="fx-code"><code>${lines.map((ln, i) => html`<span class="fx-code-line"><span class="fx-code-gutter">${i + 1}</span><span class="fx-code-text">${ln || ' '}</span></span>`)}</code></pre>
    </div>
  `
}
