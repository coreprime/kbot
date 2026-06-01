// cob.js
//
// COB script viewers: a stats panel with piece/script name chips, the
// decompiled high-level source (BOS-style highlighting + folding + lint
// annotations), and the raw bytecode disassembly (control-flow arrows).

import { htm as html } from '/ui/common/htm-bind.js'
import { BosHighlighter, CobaHighlighter } from './highlight.js'

function StatCard({ value, label }) {
  return html`<div class="fx-cob-stat"><div class="fx-cob-stat-val">${value}</div><div class="fx-cob-stat-label">${label}</div></div>`
}

function NameChips({ title, names }) {
  const real = (names || []).filter((n) => n)
  if (!real.length) return null
  return html`
    <div class="fx-cob-names">
      <h3 class="fx-section-h">${title} (${real.length})</h3>
      <div class="fx-chips">
        ${real.slice(0, 40).map((name, i) => html`<span key=${i} class="fx-chip">[${i}] ${name}</span>`)}
        ${real.length > 40 ? html`<span class="fx-chip muted">…and ${real.length - 40} more</span>` : null}
      </div>
    </div>`
}

export function CobInfoTab({ describe }) {
  const d = describe || {}
  const stats = [
    [d.version, 'Version'],
    [d.scriptCount, 'Scripts'],
    [d.pieceCount, 'Pieces'],
    [d.codeLength != null ? Number(d.codeLength).toLocaleString() : null, 'Code Length'],
    [d.staticVars, 'Static Vars'],
  ]
  return html`
    <div class="fx-cob">
      <div class="fx-cob-stats">
        ${stats.map(([v, l], i) => (v != null ? html`<${StatCard} key=${i} value=${String(v)} label=${l} />` : null))}
      </div>
      <${NameChips} title="Pieces" names=${d.pieceNames} />
      <${NameChips} title="Scripts" names=${d.scriptNames} />
    </div>
  `
}

export function CobDecompiledTab({ describe, lintLines, highlightLine }) {
  if (!describe.decompiled) return html`<div class="fx-empty">No decompiled source available.</div>`
  return html`<${BosHighlighter} code=${describe.decompiled} lintLines=${lintLines} highlightLine=${highlightLine} />`
}

export function CobDisassemblyTab({ describe }) {
  if (!describe.disassembly) return html`<div class="fx-empty">No disassembly available.</div>`
  return html`<${CobaHighlighter} code=${describe.disassembly} />`
}
