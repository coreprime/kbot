// ai.js
//
// AI profile viewer.  A TA profile is a list of plans (easy / medium /
// hard); each plan's weight lines scale build priority and its limit lines
// cap how many of a target the computer player builds.  A target is a unit,
// a category word matched against the units' FBI Category, or ALL.  Lines
// before the first plan are shown on their own tab: TA ignores them when a
// game starts.  When the install's unit table is known, an extra tab shows
// the settings each difficulty leaves the units with.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { useState } from 'preact/hooks'
import { limitLabel, limitDisabled, weightLabel, weightBarPercent, kindLabel, writtenNote } from './ai-format.js'

function Target({ name, kind }) {
  const label = kindLabel(kind)
  return html`
    <span class="fx-ai-target">
      <span class="fx-ai-unit">${name || '—'}</span>
      ${label ? html`<span class=${'fx-ai-kind fx-ai-kind-' + kind}>${label}</span>` : null}
    </span>`
}

function Written({ raw, value }) {
  const note = writtenNote(raw, value)
  return note ? html`<span class="fx-ai-written">${note}</span>` : null
}

function PlanView({ plan }) {
  const weights = plan.weights || []
  const limits = plan.limits || []
  if (!weights.length && !limits.length) return html`<div class="fx-empty">No weight or limit lines.</div>`
  return html`
    <div class="fx-ai-plan">
      ${weights.length ? html`
        <div class="fx-ai-section">
          <h4 class="fx-ai-section-h">⚖️ Weights</h4>
          <div class="fx-ai-weights">
            ${weights.map((w, i) => html`
              <div key=${i} class="fx-ai-weight-row" title=${`line ${w.line}`}>
                <${Target} name=${w.unit} kind=${w.kind} />
                <div class="fx-ai-bar-track">
                  <div class="fx-ai-bar" style=${`width:${Math.max(weightBarPercent(w.weight), 2)}%`}>
                    <span class="fx-ai-bar-val">${weightLabel(w.weight)}</span>
                  </div>
                </div>
                <${Written} raw=${w.raw} value=${w.weight} />
              </div>`)}
          </div>
        </div>` : null}
      ${limits.length ? html`
        <div class="fx-ai-section">
          <h4 class="fx-ai-section-h">🔢 Build Limits</h4>
          <div class="fx-ai-limits">
            ${limits.map((l, i) => html`
              <div key=${i} class="fx-ai-limit-row" title=${`line ${l.line}`}>
                <${Target} name=${l.unit} kind=${l.kind} />
                <span class=${'fx-ai-limit-val' + (limitDisabled(l) ? ' disabled' : '')}>
                  ${limitLabel(l)} <${Written} raw=${l.raw} value=${l.maximum} />
                </span>
              </div>`)}
          </div>
        </div>` : null}
    </div>
  `
}

function EffectiveView({ effective }) {
  const [sel, setSel] = useState(0)
  const cur = effective[Math.min(sel, effective.length - 1)]
  return html`
    <div class="fx-ai-plan">
      <p class="fx-ai-note">
        What each unit is left with when a game starts at this difficulty: weight as a percentage
        of its normal build priority, and its build limit. 🔒 marks a value a unit line fixed, which
        later lines no longer change. Units at 100% and unlimited are not listed.
      </p>
      <div class="fx-ai-plans-tabs">
        ${effective.map((e, i) => html`
          <button type="button" key=${i} class=${'fx-ai-plan-tab' + (i === sel ? ' active' : '')} onClick=${() => setSel(i)}>
            ${e.difficulty} (${e.units.length})
          </button>`)}
      </div>
      ${cur.units.length ? html`
        <table class="fx-ai-effective">
          <thead><tr><th>Unit</th><th>Weight</th><th>Limit</th></tr></thead>
          <tbody>
            ${cur.units.map((s) => html`
              <tr key=${s.unit}>
                <td class="fx-ai-unit">${s.unit}</td>
                <td>${s.weightPercent}%${s.weightLocked ? ' 🔒' : ''}</td>
                <td class=${s.forbidden ? 'disabled' : ''}>${limitLabel(s)}${s.limitLocked ? ' 🔒' : ''}</td>
              </tr>`)}
          </tbody>
        </table>` : html`<div class="fx-empty">No unit is changed at this difficulty.</div>`}
    </div>
  `
}

export function AiViewer({ describe }) {
  const plans = (describe && describe.aiPlans) || []
  const preamble = describe && describe.aiPreamble
  const effective = (describe && describe.aiEffective) || []
  const diagnostics = (describe && describe.aiDiagnostics) || []
  const [sel, setSel] = useState(0)

  const views = []
  if (preamble) views.push({ label: '⏸ Before first plan', preamble: true, plan: preamble })
  for (const p of plans) views.push({ label: `📋 ${p.name || '(no difficulty)'}`, plan: p })
  if (effective.length) views.push({ label: '📊 At game start', effective: true })
  if (!views.length) return html`<div class="fx-empty">No AI plans found.</div>`

  const cur = views[Math.min(sel, views.length - 1)]
  return html`
    <div class="fx-ai">
      <div class="fx-ai-head">
        <h2 class="fx-ai-title">🤖 AI Behaviour Profile</h2>
        <p class="fx-ai-sub">
          Weights multiply build priority; limits cap how many the computer player builds (-1 is
          unlimited, 0 or any other negative value forbids). A target is a unit, a category word from
          the units' FBI Category, or ALL: a category line applies to every matching unit, and a unit
          line applies to that unit and locks it against later lines.
        </p>
        ${views.length > 1 ? html`
          <div class="fx-ai-plans-tabs">
            ${views.map((v, i) => html`
              <button type="button" key=${i} class=${'fx-ai-plan-tab' + (i === sel ? ' active' : '')} onClick=${() => setSel(i)}>${v.label}</button>`)}
          </div>` : html`<h3 class="fx-ai-plan-name">${cur.label}</h3>`}
      </div>
      ${diagnostics.length ? html`
        <div class="fx-ai-diags">
          <h4 class="fx-ai-section-h">⚠️ Lines the game reads differently</h4>
          <ul>${diagnostics.map((d, i) => html`<li key=${i}><span class="fx-ai-line">line ${d.line}</span> ${d.message}</li>`)}</ul>
        </div>` : null}
      ${cur.preamble ? html`
        <p class="fx-ai-note">
          These lines come before the first plan line. TA ignores them when a game starts, because no
          plan has matched yet; they may apply if the profile is reloaded during a game. TA: Kingdoms
          profiles, which have no plan lines, apply them at every difficulty.
        </p>` : null}
      ${cur.effective ? html`<${EffectiveView} effective=${effective} />` : html`<${PlanView} plan=${cur.plan} />`}
    </div>
  `
}
