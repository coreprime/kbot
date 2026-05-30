// graphics-options-menu.js
//
// Shared "Graphics Options" menu body, used by BOTH the unit-editor
// ribbon and the sandbox ribbon so the effect toggles + shadow
// controls stay in lockstep across editors (the user asked for the
// menu in both, renamed from "Studio Options").
//
// This is a pure presentational component — it owns no state and no
// renderer handle.  The host passes:
//
//   s        — the current values { reflections, specular, godbeams,
//              dof, waterReflections, waves, wavesIntensity, bob,
//              bobAmount, bobSpeed, shadows, shadowIntensity,
//              selfShadow }.
//   setState — (partial) => merge into the host's state signal so the
//              menu re-renders with the new value.
//   bridge   — renderer-facing setters; each receives the already-
//              normalised value (sliders divided by 100).  The host
//              wires these to its renderer(s).
//
// Editor-specific items the user wants kept OUT of here (Environment /
// Team-colour pickers, Background Terrain) live in the unit-editor's
// Rendering ▸ Scene section and are intentionally NOT part of this
// shared body.

import { htm as html } from '/ui/common/htm-bind.js'
import {
  MenuSectionLabel, MenuToggleRow, MenuSubmenuRow,
} from '/ui/common/ribbon.js'

// _Slider — pop-out submenu slider row, matching the look of the
// unit-editor's submenu sliders (.submenu-slider-row in studio.css).
// `format` renders the value caption (e.g. "1.0×" or "60%").
function _Slider({ label, min, max, step, value, format, onChange }) {
  return html`
    <div class="submenu-slider-row">
      <span class="slider-lbl">${label}</span>
      <input type="range" min=${min} max=${max} step=${step} value=${value}
             onInput=${(e) => onChange(+e.currentTarget.value)}
             onClick=${(e) => e.stopPropagation()}
             onPointerDown=${(e) => e.stopPropagation()} />
      <span class="slider-val">${format(value)}</span>
    </div>
  `
}

// GraphicsOptionsItems — the menu rows.  Returned as a fragment so the
// host drops it straight inside its own <Dropdown>.
export function GraphicsOptionsItems({ s, setState, bridge }) {
  const set = (key, rawVal, applyVal, fn) => {
    setState({ [key]: rawVal })
    if (typeof fn === 'function') fn(applyVal)
  }
  return html`
    <${MenuSectionLabel}>Shadows<//>
    <${MenuSubmenuRow}
      icon="🌑"
      label="Shadows"
      title="Cast + self shadows — hover for intensity.  Off removes all shadows."
      on=${s.shadows}
      onToggle=${(next) => set('shadows', next, next, bridge.setShadows)}>
      <${_Slider}
        label="Intensity"
        min=${0} max=${100} step=${5}
        value=${s.shadowIntensity}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('shadowIntensity', v, v / 100, bridge.setShadowIntensity)} />
    <//>
    <${MenuToggleRow}
      icon="🫥"
      label="Self-Shadowing"
      title="The unit casts shadows onto its own geometry.  Off keeps the ground shadow but lights the unit evenly."
      on=${s.selfShadow}
      onChange=${(next) => set('selfShadow', next, next, bridge.setSelfShadow)} />

    <${MenuSectionLabel}>General Effects<//>
    <${MenuToggleRow}
      icon="🪞"
      label="Reflections"
      title="The unit reflects on the water (and other reflective surfaces)."
      on=${s.reflections}
      onChange=${(next) => set('reflections', next, next, bridge.setReflections)} />
    <${MenuToggleRow}
      icon="💎"
      label="Specular Highlights"
      title="Bright sun highlights on the water surface"
      on=${s.specular}
      onChange=${(next) => set('specular', next, next, bridge.setSpecular)} />
    <${MenuToggleRow}
      icon="🌟"
      label="God Beams"
      title="Crepuscular light shafts from the sun through clouds"
      on=${s.godbeams}
      onChange=${(next) => set('godbeams', next, next, bridge.setGodBeams)} />
    <${MenuToggleRow}
      icon="🎞️"
      label="Depth of Field"
      title="Cinematic depth of field — unit stays sharp, background softens"
      on=${s.dof}
      onChange=${(next) => set('dof', next, next, bridge.setDoF)} />

    <${MenuSectionLabel}>Liquid Simulation<//>
    <${MenuToggleRow}
      icon="🌅"
      label="Water Surface Reflections"
      title="Water reflects onto the unit’s hull — caustic bounce + sun shimmer on side plates"
      on=${s.waterReflections}
      onChange=${(next) => set('waterReflections', next, next, bridge.setWaterReflections)} />
    <${MenuSubmenuRow}
      icon="🌊"
      label="Waves"
      title="Animate the water surface — hover for intensity"
      on=${s.waves}
      onToggle=${(next) => set('waves', next, next, bridge.setWaves)}>
      <${_Slider}
        label="Intensity"
        min=${0} max=${200} step=${5}
        value=${s.wavesIntensity}
        format=${(v) => `${(v / 100).toFixed(1)}×`}
        onChange=${(v) => set('wavesIntensity', v, v / 100, bridge.setWavesIntensity)} />
    <//>
    <${MenuSubmenuRow}
      icon="🚤"
      label="Bobbing / Swaying"
      title="Unit bobs + sways with the swell — hover for amount + speed"
      on=${s.bob}
      onToggle=${(next) => set('bob', next, next, bridge.setBob)}>
      <${_Slider}
        label="Amount"
        min=${0} max=${200} step=${5}
        value=${s.bobAmount}
        format=${(v) => `${(v / 100).toFixed(1)}×`}
        onChange=${(v) => set('bobAmount', v, v / 100, bridge.setBobAmount)} />
      <${_Slider}
        label="Speed"
        min=${0} max=${200} step=${5}
        value=${s.bobSpeed}
        format=${(v) => `${(v / 100).toFixed(1)}×`}
        onChange=${(v) => set('bobSpeed', v, v / 100, bridge.setBobSpeed)} />
    <//>
  `
}
