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
  MenuSectionLabel, MenuToggleRow, MenuSubmenuRow, MenuSliderRow,
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
    <${MenuSectionLabel}>Geometry<//>
    <${MenuToggleRow}
      icon="🧩"
      label="Enhanced Mesh"
      title="Reconstruct the faces TA's artists deleted as a 90s fill-rate optimisation — open box bottoms, hollow torsos, missing undersides — so the unit reads solid from every angle.  Re-fetches the model geometry."
      on=${s.enhanceMesh}
      onChange=${(next) => set('enhanceMesh', next, next, bridge.setEnhanceMesh)} />

    <${MenuSectionLabel}>Lighting<//>
    <${MenuSliderRow}
      icon="☀️"
      label="Brightness"
      title="Scene light intensity / exposure.  Lower for richer, more saturated textures; raise to brighten.  100% is the default."
      min=${20} max=${200} step=${5}
      value=${s.lightIntensity}
      format=${(v) => `${v}%`}
      onChange=${(v) => set('lightIntensity', v, v / 100, bridge.setLightIntensity)} />
    <${MenuSliderRow}
      icon="💥"
      label="Dynamic Lights"
      title="How many weapon effects (muzzle flashes, tracer shells, the d-gun, lasers) can light the scene at once.  Higher lets a rapid-firing battleship or a crowded battlefield glow from every shot; lower trades that off for fill-rate.  0 disables dynamic lighting entirely."
      min=${0} max=${256} step=${8}
      value=${s.dynamicLights}
      format=${(v) => `${v}`}
      onChange=${(v) => set('dynamicLights', v, v, bridge.setMaxDynamicLights)} />

    <${MenuSectionLabel}>General Effects<//>
    <${MenuSubmenuRow}
      icon="💎"
      label="Specular Highlights"
      title="Master switch for all surface shine — sun/sky sheen on unit hulls + the water surface.  Hover for intensity."
      on=${s.specular}
      onToggle=${(next) => set('specular', next, next, bridge.setSpecular)}>
      <${_Slider}
        label="Intensity"
        min=${0} max=${200} step=${5}
        value=${s.specularLevel}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('specularLevel', v, v / 100, bridge.setSpecularStrength)} />
    <//>

    <${MenuSectionLabel}>Object Enhancements<//>
    <${MenuSubmenuRow}
      icon="💡"
      label="Running Lights"
      title="Tagged tiles (CORE vehicle hulls — corv06a/b) blink their blue/yellow status lamps and emit a glow into the scene.  Configured per-texture via the hints framework.  Hover for intensity."
      on=${s.runningLights}
      onToggle=${(next) => set('runningLights', next, next, bridge.setRunningLights)}>
      <${_Slider}
        label="Intensity"
        min=${0} max=${200} step=${5}
        value=${s.runningLightsLevel}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('runningLightsLevel', v, v / 100, bridge.setRunningLightsStrength)} />
    <//>
    <${MenuSubmenuRow}
      icon="🗻"
      label="Bump Mapping"
      title="Derive surface relief from a tagged tile’s luminance so painted detail — rivets, panel lines — catches light with depth (e.g. ARM building plating).  Hover for intensity."
      on=${s.bumpMap}
      onToggle=${(next) => set('bumpMap', next, next, bridge.setBumpMap)}>
      <${_Slider}
        label="Intensity"
        min=${0} max=${200} step=${5}
        value=${s.bumpLevel}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('bumpLevel', v, v / 100, bridge.setBumpStrength)} />
    <//>
    <${MenuToggleRow}
      icon="🔩"
      label="Surface Hints"
      title=${s.specular
        ? 'Infer each surface’s material from its texture name (metal/chrome/steel + ARM/CORE vehicle/ship/building plating) and give those a sharper, stronger specular.  Builds on top of Specular Highlights.'
        : 'Enable Specular Highlights first — Surface Hints tunes the specular per material.'}
      on=${s.metalSpec}
      disabled=${!s.specular}
      onChange=${(next) => set('metalSpec', next, next, bridge.setMetalSpec)} />

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
      title=${s.shadows
        ? 'The unit casts shadows onto its own geometry.  Off keeps the ground shadow but lights the unit evenly.'
        : 'Enable Shadows first — self-shadowing needs the shadow pass.'}
      on=${s.selfShadow}
      disabled=${!s.shadows}
      onChange=${(next) => set('selfShadow', next, next, bridge.setSelfShadow)} />

    <${MenuSectionLabel}>Liquid Simulation<//>
    <${MenuToggleRow}
      icon="🪞"
      label="Object Reflections"
      title="The unit reflects on the water (and other reflective surfaces)."
      on=${s.reflections}
      onChange=${(next) => set('reflections', next, next, bridge.setReflections)} />
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

    <${MenuSectionLabel}>Post-Processing<//>
    <${MenuToggleRow}
      icon="📐"
      label="Anti-Aliasing"
      title="FXAA edge smoothing.  The normal view already has hardware anti-aliasing, so this mainly helps when a post-processing effect (Cinematic / Bloom / DoF / Lens Flare) is on — those route through an offscreen buffer that loses it."
      on=${s.antialias}
      onChange=${(next) => set('antialias', next, next, bridge.setAntialias)} />
    <${MenuSubmenuRow}
      icon="🌠"
      label="Bloom"
      title="Soft glow bleeding off the brightest pixels — sun glints, muzzle flashes, lasers, glowing panels.  Hover for strength."
      on=${s.bloom}
      onToggle=${(next) => set('bloom', next, next, bridge.setBloom)}>
      <${_Slider}
        label="Strength"
        min=${0} max=${200} step=${5}
        value=${s.bloomLevel}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('bloomLevel', v, v / 100, bridge.setBloomStrength)} />
    <//>
    <${MenuSubmenuRow}
      icon="🎬"
      label="Cinematic"
      title="Filmic look — ACES tonemap, contrast/saturation grade, vignette, and anti-aliasing.  Hover for intensity."
      on=${s.cinematic}
      onToggle=${(next) => set('cinematic', next, next, bridge.setCinematic)}>
      <${_Slider}
        label="Intensity"
        min=${0} max=${100} step=${5}
        value=${s.cinematicLevel}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('cinematicLevel', v, v / 100, bridge.setCinematicStrength)} />
    <//>
    <${MenuSubmenuRow}
      icon="✴️"
      label="Lens Flare"
      title="Screen-space sun flare — a glow + ghosts that hide when geometry crosses in front of the sun.  Hover for strength."
      on=${s.lensFlare}
      onToggle=${(next) => set('lensFlare', next, next, bridge.setLensFlare)}>
      <${_Slider}
        label="Strength"
        min=${0} max=${200} step=${5}
        value=${s.lensFlareLevel}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('lensFlareLevel', v, v / 100, bridge.setLensFlareStrength)} />
    <//>
    <${MenuToggleRow}
      icon="🌟"
      label="God Beams"
      title="Crepuscular light shafts from the sun through clouds"
      on=${s.godbeams}
      onChange=${(next) => set('godbeams', next, next, bridge.setGodBeams)} />
    <${MenuSubmenuRow}
      icon="🎞️"
      label="Depth of Field"
      title="Cinematic depth of field — unit stays sharp, background softens.  Hover for onset distance + blur amount."
      on=${s.dof}
      onToggle=${(next) => set('dof', next, next, bridge.setDoF)}>
      <${_Slider}
        label="Distance"
        min=${100} max=${2000} step=${50}
        value=${s.dofDistance}
        format=${(v) => `${(v / 100).toFixed(1)}×`}
        onChange=${(v) => set('dofDistance', v, v / 100, bridge.setDoFDistance)} />
      <${_Slider}
        label="Amount"
        min=${0} max=${200} step=${5}
        value=${s.dofLevel}
        format=${(v) => `${v}%`}
        onChange=${(v) => set('dofLevel', v, v / 100, bridge.setDoFLevel)} />
    <//>
  `
}
