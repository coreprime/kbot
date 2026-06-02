// port-rows.js
//
// Preact components for the per-port editor rows shared by the
// Controls panel's body.  Each row matches the legacy DOM shape
// (data-port="<key>" on the row, plus the existing inner classes)
// so studio.css doesn't have to change and refreshMvInspectors'
// per-tick re-render hands React the same data the legacy
// renderMvPortsPanel handed to its DOM builders.
//
// Editing semantics: each row's onChange callback writes straight
// through to the live cobPorts / cobDamage / cobBuildPercent
// fields the COB hooks read on the next `get <port>`.  No
// imperative DOM writes, no per-tick refresh — Preact's keyed
// re-render handles the live update via the inspector-store
// runtimeTick signal.

import { htm as html } from '@kbot/ui/htm-bind'

const _stopProp = (e) => e.stopPropagation()

// PortChoiceRow — segmented-button row for Move/Fire orders.  The
// `options` prop is the same [label, value, title] triple shape the
// legacy builder used.
export function PortChoiceRow({ label, portKey, current, options, tip, onChange }) {
  return html`
    <div class="mv-port-row" data-port=${portKey}>
      <span class="mv-port-label" title=${tip}>${label}</span>
      <div class="mv-port-choice">
        ${options.map(([optLabel, optValue, optTip]) => html`
          <button
            class=${current === optValue ? 'active' : ''}
            data-value=${optValue}
            title=${optTip}
            onClick=${(e) => { _stopProp(e); onChange(optValue) }}
            onPointerDown=${_stopProp}>
            ${optLabel}
          </button>
        `)}
      </div>
    </div>
  `
}

// PortToggleRow — On/Off pill (Active port).
export function PortToggleRow({ label, portKey, on, tip, onChange }) {
  return html`
    <div class="mv-port-row" data-port=${portKey}>
      <span class="mv-port-label" title=${tip}>${label}</span>
      <button
        class=${on ? 'mv-port-toggle on' : 'mv-port-toggle'}
        title=${tip}
        onClick=${(e) => { _stopProp(e); onChange(!on) }}
        onPointerDown=${_stopProp}>
        ${on ? 'On' : 'Off'}
      </button>
    </div>
  `
}

// PortChipRow — read-only Yes/No chip (Armoured, In build stance).
// COB scripts toggle these via SET_VALUE; the panel just surfaces
// the current state so the user can see when a script flips them.
export function PortChipRow({ label, portKey, yes, tip }) {
  return html`
    <div class="mv-port-row" data-port=${portKey}>
      <span class="mv-port-label" title=${tip}>${label}</span>
      <span class=${`mv-port-chip ${yes ? 'yes' : 'no'}`}>${yes ? 'Yes' : 'No'}</span>
    </div>
  `
}

// PortSliderRow — 0..100% drag with live label (Health, Build %).
// Uses an uncontrolled-ish pattern: the slider's value prop reflects
// the current state but onChange writes through immediately, so the
// next render's value comes from the freshly-updated source.
export function PortSliderRow({ label, portKey, value, min = 0, max = 100, unit = '%', tip, onInput }) {
  return html`
    <div class="mv-port-row" data-port=${portKey}>
      <span class="mv-port-label" title=${tip}>${label}</span>
      <div class="mv-port-slider-wrap">
        <input
          type="range"
          min=${min}
          max=${max}
          value=${value}
          onInput=${(e) => onInput(parseInt(e.currentTarget.value, 10) | 0)}
          onClick=${_stopProp}
          onPointerDown=${_stopProp} />
        <span class="mv-port-slider-val">${value}${unit}</span>
      </div>
    </div>
  `
}
