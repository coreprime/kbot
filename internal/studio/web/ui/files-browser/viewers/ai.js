// ai.js
//
// AI profile viewer.  TA ships per-difficulty plans; TA: Kingdoms files
// often have a single synthetic "default" plan.  Each plan shows unit
// build weights as proportional bars and build limits as a chip list.
// The plan selector only appears when there is more than one plan.

import { htm as html } from '/ui/common/htm-bind.js'
import { useState } from 'preact/hooks'

function PlanView({ plan }) {
  const weights = plan.weights || []
  const limits = plan.limits || []
  const maxWeight = weights.length ? Math.max(...weights.map((w) => Math.abs(w.weight)), 1) : 1
  return html`
    <div class="fx-ai-plan">
      ${weights.length ? html`
        <div class="fx-ai-section">
          <h4 class="fx-ai-section-h">⚖️ Unit Weights</h4>
          <div class="fx-ai-weights">
            ${weights.map((w, i) => html`
              <div key=${i} class="fx-ai-weight-row">
                <span class="fx-ai-unit">${w.unit}</span>
                <div class="fx-ai-bar-track">
                  <div class="fx-ai-bar" style=${`width:${Math.max((Math.abs(w.weight) / maxWeight) * 100, 2)}%`}>
                    <span class="fx-ai-bar-val">${w.weight}</span>
                  </div>
                </div>
              </div>`)}
          </div>
        </div>` : null}
      ${limits.length ? html`
        <div class="fx-ai-section">
          <h4 class="fx-ai-section-h">🔢 Build Limits</h4>
          <div class="fx-ai-limits">
            ${limits.map((l, i) => html`
              <div key=${i} class="fx-ai-limit-row">
                <span class="fx-ai-unit">${l.unit}</span>
                <span class=${'fx-ai-limit-val' + (l.maximum === 0 ? ' disabled' : '')}>
                  ${l.maximum === -1 ? '∞' : l.maximum === 0 ? 'Disabled' : `Max: ${l.maximum}`}
                </span>
              </div>`)}
          </div>
        </div>` : null}
    </div>
  `
}

export function AiViewer({ describe }) {
  const plans = (describe && describe.aiPlans) || []
  const [sel, setSel] = useState(0)
  if (!plans.length) return html`<div class="fx-empty">No AI plans found.</div>`

  const single = plans.length === 1
  const cur = plans[Math.min(sel, plans.length - 1)]
  return html`
    <div class="fx-ai">
      <div class="fx-ai-head">
        <div>
          <h2 class="fx-ai-title">🤖 AI Behaviour Profile</h2>
          <p class="fx-ai-sub">Build weights set production priority; limits cap how many of each unit the AI builds.</p>
        </div>
        ${!single ? html`
          <div class="fx-ai-plans-tabs">
            ${plans.map((p, i) => html`
              <button type="button" key=${i} class=${'fx-ai-plan-tab' + (i === sel ? ' active' : '')} onClick=${() => setSel(i)}>📋 ${p.name}</button>`)}
          </div>` : null}
      </div>
      ${single && cur.name !== 'default' ? html`<h3 class="fx-ai-plan-name">📋 ${cur.name} Difficulty</h3>` : null}
      <${PlanView} plan=${cur} />
    </div>
  `
}
