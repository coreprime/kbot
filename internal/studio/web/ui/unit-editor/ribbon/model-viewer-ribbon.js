// model-viewer-ribbon.js
//
// React-rendered ribbon for the unit editor (model viewer) — the
// long horizontal strip with Model / Camera / Rendering / Scene /
// Graphics Options / Animation (COB) / View / Configure / Help.  Built
// on the shared ribbon primitives so the structural chrome stays
// consistent with the sandbox ribbon migrated earlier.
//
// The "Graphics Options" body (effect toggles + shadow controls + the
// liquid sim) is the SHARED GraphicsOptionsItems component, also used
// by the sandbox ribbon so the two stay in lockstep.  Editor-only
// pickers (Environment / Team colour / Background Terrain) deliberately
// live in this ribbon's Rendering ▸ Scene section instead.
//
// State falls into three families, all module-scoped signals so they
// can be mutated from outside without prop-drilling:
//   _state  — the per-renderer toggle / slider / pick state.  Pushed
//             in by the host via setModelViewerRibbonState() each time
//             the renderer's persisted defaults are applied, and read
//             out via the bridge whenever the user touches a row.
//   _cobState — the loaded unit's COB-related state (script list +
//             lifecycle gate + which scripts have a live thread).
//             Pushed in by refreshCobPanel + the per-tick running-
//             script sweep.
//   _bridge — host-installed callbacks for every action a row can
//             fire (renderer setters, COB invokers, settings opener).
//
// The component never reaches into modelViewerInstance / state
// globals directly — every effect goes through a bridge call so the
// component can be re-mounted independently of the giant host
// module.

import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import { panelSignals } from '/ui/common/panel-store.js'
import {
  Ribbon, RibbonSection, RibbonButton,
  RibbonDropdownButton, Dropdown, MenuRow, MenuToggleRow, MenuSubmenuRow,
  MenuSliderRow, MenuSectionLabel, closeDropdownById,
} from '/ui/common/ribbon.js'
import { SplitMenuItems } from '/ui/common/split-host.js'
import { GraphicsOptionsItems } from '/ui/common/graphics-options-menu.js'
import { persistGraphicsOptions } from '/ui/common/graphics-options-state.js'

// _state — every toggle / slider / picker value displayed on the
// ribbon.  Defaults match the static HTML the legacy markup shipped
// so the ribbon paints sensibly even before the host pushes the
// persisted defaults via setModelViewerRibbonState().
const _state = signal({
  renderMode:        'full',      // 'full' | 'flat' | 'wireframe'
  wireOverlay:       false,
  wireOverlayLocked: false,       // forced-on while in 'wireframe' mode
  wireWidth:         1,           // 1..6 px

  ground:            'terrain',   // 'grid' | 'terrain' | 'sea' | 'off'
  autoRotate:        false,        // off by default — user toggles via R / Camera menu

  env:               'greenworld',
  team:              'blue',

  shadows:           true,        // cast + self shadows master toggle
  shadowIntensity:   100,         // %, 0..100 → uShadowStrength 0..1
  selfShadow:        true,        // unit casts shadows on its own geometry

  reflections:       true,
  specular:          true,
  godbeams:          true,
  dof:               false,
  waterReflections:  true,

  bob:               true,
  bobAmount:         100,
  bobSpeed:          100,
  waves:             true,
  wavesIntensity:    100,
  bgterrain:         true,
  bgterrainHeight:   100,
  bgterrainScale:    100,
  seabedHeight:      100,
  seabedScale:       100,
  seabedRocks:       12,

  cobDamage:         0,
  cobBuild:          100,
  cobPlayback:       100,         // %, 1..1000
})

// _cobState — per-unit COB metadata.  hasCob false → "No COB attached"
// empty state.  scriptNames lists every entry the loaded COB exports
// (for the dynamic "All scripts" tail).  runningScripts is a Set of
// lower-cased names; lifecycle drives the unborn → creating → created
// gating that disables every non-Create button until Create finishes.
const _cobState = signal({
  hasCob:         false,
  scriptNames:    [],             // every script the COB exports (original case)
  runningScripts: new Set(),      // lower-cased names with live threads
  lifecycle:      'created',      // 'unborn' | 'creating' | 'created'
})

// _bridge — host installs every action callback.  Stubs are no-ops so
// the component can mount before the bridge is configured.
const _bridge = {
  openAnother:     () => {},
  showStats:       () => {},

  resetCamera:     () => {},
  setAutoRotate:   (_on) => {},

  setRenderMode:   (_mode) => {},
  setWireOverlay:  (_on) => {},
  setWireWidth:    (_px) => {},

  setGround:       (_mode) => {},

  setEnvironment:  (_env, _opts) => {},   // { preview, commit }
  setTeamColor:    (_team, _opts) => {},  // { preview, commit }

  setShadows:            (_on) => {},
  setShadowIntensity:    (_v) => {},      // already normalised 0..1
  setSelfShadow:         (_on) => {},

  setReflections:        (_on) => {},
  setSpecular:           (_on) => {},
  setGodBeams:           (_on) => {},
  setDoF:                (_on) => {},
  setWaterReflections:   (_on) => {},

  setBob:           (_on) => {},
  setBobAmount:     (_v) => {},
  setBobSpeed:      (_v) => {},
  setWaves:         (_on) => {},
  setWavesIntensity:(_v) => {},
  setBgTerrain:     (_on) => {},
  setBgTerrainHeight:(_v) => {},
  setBgTerrainScale:(_v) => {},
  setSeabedHeight:  (_v) => {},
  setSeabedScale:   (_v) => {},
  setSeabedRocks:   (_v) => {},

  runCobEntry:     (_name) => {},
  setCobDamage:    (_v) => {},
  setCobBuild:     (_v) => {},
  setCobPlayback:  (_pct) => {},   // 0..1000 (UI integer), host converts to rate
  resetCob:        () => {},

  setPanelVisible: (_id, _on) => {},

  splitActive:     (_orient) => {},
  closeActive:     () => {},
  canClose:        () => false,

  openSettings:    () => {},
  openHelp:        () => {},
}

export function configureModelViewerRibbonBridge(impl) {
  const stubs = {
    openAnother: () => {}, showStats: () => {},
    resetCamera: () => {}, setAutoRotate: (_on) => {},
    setRenderMode: (_m) => {}, setWireOverlay: (_o) => {}, setWireWidth: (_p) => {},
    setGround: (_m) => {},
    setEnvironment: (_e, _o) => {}, setTeamColor: (_t, _o) => {},
    setShadows: (_o) => {}, setShadowIntensity: (_v) => {}, setSelfShadow: (_o) => {},
    setReflections: (_o) => {}, setSpecular: (_o) => {},
    setGodBeams: (_o) => {}, setDoF: (_o) => {}, setWaterReflections: (_o) => {},
    setBob: (_o) => {}, setBobAmount: (_v) => {}, setBobSpeed: (_v) => {},
    setWaves: (_o) => {}, setWavesIntensity: (_v) => {},
    setBgTerrain: (_o) => {}, setBgTerrainHeight: (_v) => {}, setBgTerrainScale: (_v) => {},
    setSeabedHeight: (_v) => {}, setSeabedScale: (_v) => {}, setSeabedRocks: (_v) => {},
    runCobEntry: (_n) => {}, setCobDamage: (_v) => {}, setCobBuild: (_v) => {},
    setCobPlayback: (_p) => {}, resetCob: () => {},
    setPanelVisible: (_i, _o) => {},
    splitActive: (_orient) => {}, closeActive: () => {}, canClose: () => false,
    openSettings: () => {}, openHelp: () => {},
  }
  Object.assign(_bridge, stubs, impl)
}

// setModelViewerRibbonState — partial merge into the visible state.
// Host calls this when the renderer's defaults are applied to a fresh
// unit so the ribbon paints the right ticks + slider positions; row
// click handlers also call this internally to keep the displayed
// state in sync with what the user just chose.
export function setModelViewerRibbonState(patch) {
  if (!patch) return
  _state.value = { ..._state.value, ...patch }
}

// _applyGraphicsPatch — the setState the shared Graphics Options menu
// calls.  Mirrors the value into the ribbon signal AND persists it
// (graphics options are a global, preserved-across-reload setting like
// the sandbox's).  Only ever receives graphics-option keys, and
// persistGraphicsOptions filters to the known set, so non-graphics
// ribbon state is never written to the prefs blob.
function _applyGraphicsPatch(patch) {
  setModelViewerRibbonState(patch)
  persistGraphicsOptions(patch)
}

// setModelViewerCobState — push the per-unit COB state.  Pass the
// fully-formed { hasCob, hasScripts, scriptNames, runningScripts,
// lifecycle } object so the signal sees a new reference and React
// re-renders the COB dropdown + entry button grid.
export function setModelViewerCobState(patch) {
  if (!patch) return
  _cobState.value = { ..._cobState.value, ...patch }
}

// closeModelViewerRibbonDropdowns — host helper to dismiss any open
// model-viewer ribbon dropdown (e.g. on tab switch).  Cheap idempotent.
export function closeModelViewerRibbonDropdowns() {
  for (const id of [
    'mv-model-dropdown',
    'mv-camera-dropdown',
    'mv-render-dropdown',
    'mv-ground-dropdown',
    'mv-options-dropdown',
    'mv-anim-dropdown',
    'mv-view-dropdown',
  ]) closeDropdownById(id)
}

// ── Static row tables ────────────────────────────────────────────────

const _RENDER_MODES = [
  { mode: 'full',      icon: '🧱', label: 'Studio Mode',
    title: 'Full lit + textured render — the showroom look' },
  { mode: 'flat',      icon: '⬜', label: 'Flat Shading',
    title: 'Textured but flat-shaded — no directional lighting or shadows' },
  { mode: 'wireframe', icon: '📐', label: 'Wireframe Only',
    title: 'Polygon outlines only, no surface texturing' },
]

const _GROUND_MODES = [
  { mode: 'grid',    icon: '⊞', label: 'Grid',
    title: 'Light-green grid sized to one TA map tile' },
  { mode: 'terrain', icon: '🌱', label: 'Terrain',
    title: 'Tiled tileset under the unit (changes with Environment)' },
  { mode: 'sea',     icon: '🌊', label: 'Sea',
    title: 'Procedural animated water under the unit' },
  { mode: 'off',     icon: '🚫', label: 'Off',
    title: 'Hide the ground plane entirely' },
]

const _ENVIRONMENTS = [
  { env: 'greenworld', icon: '🌳', label: 'Greenworld',
    title: 'Greenworld — lush forest, deeper-blue ocean (TA default)' },
  { env: 'archipelago', icon: '🏝️', label: 'Archipelago',
    title: 'Archipelago — tropical white-sand seabed, crystal blue translucent water' },
  { env: 'metal', icon: '⚙️', label: 'Metal',
    title: 'Metal world — cloudless industrial sky, thick oily coolant' },
  { env: 'desert', icon: '🏜️', label: 'Desert',
    title: 'Desert — sandy terrain, acid-green lake' },
  { env: 'lava', icon: '🌋', label: 'Lava',
    title: 'Lava world — red sky, glowing molten lakes' },
  { env: 'marsh', icon: '🪷', label: 'Marsh',
    title: 'Marsh — hazy sky, tannin-stained swamp water' },
  { env: 'slate', icon: '⛰️', label: 'Slate',
    title: 'Slate — overcast sky, cold grey quarry water' },
  { env: 'moon', icon: '🌙', label: 'Lunar',
    title: 'Lunar — airless black sky, highly translucent water' },
  { env: 'mars', icon: '🔴', label: 'Mars',
    title: 'Mars — orange dusty sky, purple water' },
  { env: 'sunset', icon: '🌇', label: 'Sunset',
    title: 'Greenworld at sunset — warm sky, muted water' },
  { env: 'night', icon: '🌌', label: 'Night',
    title: 'Greenworld at night — dark sky, moonlit water' },
  { env: 'alienTwin', icon: '👽', label: 'Alien (twin suns)',
    title: 'Alien — twin suns, purple sky, bioluminescent water' },
]

const _TEAMS = [
  { team: 'blue',   icon: '🔵', label: 'Blue (default)',
    title: 'ARM blue — the original game default, no recolouring applied' },
  { team: 'red',    icon: '🔴', label: 'Red',    title: 'CORE red' },
  { team: 'green',  icon: '🟢', label: 'Green',  title: 'Green team' },
  { team: 'yellow', icon: '🟡', label: 'Yellow', title: 'Yellow team' },
  { team: 'purple', icon: '🟣', label: 'Purple', title: 'Purple team' },
  { team: 'cyan',   icon: '🩵', label: 'Cyan',   title: 'Cyan team' },
  { team: 'orange', icon: '🟠', label: 'Orange', title: 'Orange team' },
  { team: 'white',  icon: '⚪', label: 'White',  title: 'White team' },
  { team: 'black',  icon: '⚫', label: 'Black',  title: 'Black team' },
]

const _COB_ENTRIES = [
  { section: 'Lifecycle', rows: [
    { name: 'Create',      icon: '🪄', title: 'Initial setup script that runs on unit spawn (hides flares, sets piece offsets).' },
    { name: 'Activate',    icon: '⚡', title: 'Powers on the unit — radar dishes spin, hatches open, etc.' },
    { name: 'Deactivate',  icon: '🔌', title: 'Powers off — folds antennas, closes hatches.' },
    { name: 'Killed',      icon: '💀', title: 'Death animation — body parts fly off, smoke trails.' },
  ] },
  { section: 'Movement', rows: [
    { name: 'StartMoving',   icon: '🚶', title: 'Start walking / driving animation.' },
    { name: 'StopMoving',    icon: '🛑', title: 'Stop walking / driving animation.' },
    { name: 'StartBuilding', icon: '🏗️', title: 'Begin construction animation (cranes extending).' },
    { name: 'StopBuilding',  icon: '✋', title: 'End construction animation.' },
  ] },
  { section: 'Weapons', rows: [
    { name: 'AimPrimary',   icon: '🎯', title: 'Aim primary weapon at a random heading + elevation in the unit’s FOV.' },
    { name: 'FirePrimary',  icon: '💥', title: 'Fire primary weapon (recoil + muzzle flash).' },
    { name: 'AimSecondary', icon: '🎯', title: 'Aim secondary weapon at a random target.' },
    { name: 'FireSecondary',icon: '💥', title: 'Fire secondary weapon.' },
    { name: 'AimTertiary',  icon: '🎯', title: 'Aim tertiary weapon.' },
    { name: 'FireTertiary', icon: '💥', title: 'Fire tertiary weapon.' },
  ] },
]

const _VIEW_PANELS = [
  { id: 'mv-inspector-scripts',    icon: '⚙', label: 'Runtime',
    title: 'Toggle the Runtime overlay — every loaded unit’s live COB threads, grouped by unit, with PC + signal mask + a one-click debugger jump.' },
  { id: 'mv-inspector-actions',    icon: '▶', label: 'Script Commands',
    title: 'Toggle the Script Commands overlay — a clickable button for every script the loaded COB exports (Activate, Deactivate, Fire*, AimWeapon*, etc.).' },
  { id: 'mv-inspector-ports',      icon: '🎮', label: 'Controls',
    title: 'Toggle the Controls overlay — drive the unit (Move, Aim+Fire Primary/Secondary/Tertiary) AND view+edit its COB unit-value ports (Active, Move/Fire orders, Health, Build %, etc.).' },
  { id: 'mv-inspector-unit-ports', icon: '🔌', label: 'Unit Ports',
    title: 'Toggle the Unit Ports overlay — read-only view of every well-known COB unit-value port (ACTIVATION, STANDINGMOVE/FIREORDERS, HEALTH, BUILD_PERCENT_LEFT, YARD_OPEN, BUGGER_OFF, ARMORED, …).' },
  { id: 'mv-inspector-staticvars', icon: '📊', label: 'Unit Variables',
    title: 'Toggle the Unit Variables overlay — current value of every COB `static-var` (global_0, global_1, …) the scripts share.' },
  { id: 'mv-inspector-camera',     icon: '🎥', label: 'Renderer',
    title: 'Toggle the Renderer overlay — live read-out of the viewer camera (eye, target, yaw, pitch, distance, FOV) plus the GL canvas’s current frame rate.' },
  { id: 'mv-inspector-effects',    icon: '✨', label: 'Effects',
    title: 'Toggle the Effects overlay — live inspector of every active particle (kind, position, velocity, life remaining) plus the COB binding’s particle-pool occupancy.' },
  { id: 'mv-inspector-audio',      icon: '🔊', label: 'Audio',
    title: 'Toggle the Audio overlay — live inspector of every sound currently playing (stem, source label, world XYZ of emission, volume, progress).' },
]

// ── Sub-components ──────────────────────────────────────────────────

function ModelDropdown() {
  return html`
    <div class="ribbon-dropdown" id="mv-model-dropdown">
      <${RibbonDropdownButton}
        id="mv-model-dropdown-btn"
        dropdownId="mv-model-dropdown"
        icon="🛠"
        label="Model"
        title="Model file actions" />
      <${Dropdown} id="mv-model-dropdown">
        <${MenuRow}
          icon="📂"
          label="Open another model…"
          title="Browse another unit from the loaded VFS (FBI-derived list with build pictures and FBI / 3DO / COB presence chips)"
          dropdownId="mv-model-dropdown"
          onClick=${() => _bridge.openAnother()} />
        <${MenuRow}
          icon="📤"
          label="Export as glTF…"
          title="Coming soon: export as glTF / OBJ."
          dropdownId="mv-model-dropdown"
          onClick=${() => {}}
          className="menu-row-disabled" />
        <${MenuRow}
          icon="💾"
          label="Save as .3do…"
          title="Coming soon: convert and save as .3do."
          dropdownId="mv-model-dropdown"
          onClick=${() => {}}
          className="menu-row-disabled" />
        <${MenuSectionLabel}>Info<//>
        <${MenuRow}
          icon="ℹ️"
          label="Show model stats"
          title="Show piece counts and texture refs in the status bar"
          dropdownId="mv-model-dropdown"
          onClick=${() => _bridge.showStats()} />
      <//>
    </div>
  `
}

function CameraDropdown() {
  const { autoRotate } = _state.value
  return html`
    <div class="ribbon-dropdown" id="mv-camera-dropdown">
      <${RibbonDropdownButton}
        id="mv-camera-dropdown-btn"
        dropdownId="mv-camera-dropdown"
        icon="📷"
        label="Camera"
        title="Camera controls" />
      <${Dropdown} id="mv-camera-dropdown">
        <${MenuRow}
          icon="🎯"
          label="Reset Camera"
          title="Reset camera framing to the unit’s bounding box"
          dropdownId="mv-camera-dropdown"
          onClick=${() => _bridge.resetCamera()} />
        <${MenuToggleRow}
          icon="🔄"
          label="Auto-Rotate"
          title="Slow turntable around the model"
          on=${autoRotate}
          onChange=${(next) => {
            setModelViewerRibbonState({ autoRotate: next })
            _bridge.setAutoRotate(next)
          }} />
      <//>
    </div>
  `
}

function RenderingDropdown() {
  const {
    renderMode, wireOverlay, wireOverlayLocked, wireWidth,
    bgterrain, bgterrainHeight, bgterrainScale,
  } = _state.value
  const current = _RENDER_MODES.find((m) => m.mode === renderMode) || _RENDER_MODES[0]
  return html`
    <div class="ribbon-dropdown" id="mv-render-dropdown">
      <${RibbonDropdownButton}
        id="mv-render-dropdown-btn"
        dropdownId="mv-render-dropdown"
        icon=${current.icon}
        label=${current.label}
        title="Pick the render mode + wireframe overlay" />
      <${Dropdown} id="mv-render-dropdown">
        <${MenuSectionLabel}>Mode<//>
        ${_RENDER_MODES.map((m) => html`
          <${MenuRow}
            key=${m.mode}
            icon=${m.icon}
            label=${m.label}
            title=${m.title}
            active=${renderMode === m.mode}
            dropdownId="mv-render-dropdown"
            onClick=${() => {
              const isWire = m.mode === 'wireframe'
              setModelViewerRibbonState({
                renderMode:        m.mode,
                wireOverlay:       isWire ? true : false,
                wireOverlayLocked: isWire,
              })
              _bridge.setRenderMode(m.mode)
              _bridge.setWireOverlay(isWire)
            }} />
        `)}
        <${MenuSectionLabel}>Wireframe<//>
        <${MenuToggleRow}
          icon="🪡"
          label="Show Wireframe"
          title="Overlay polygon edges on top of the current mode"
          on=${wireOverlay}
          disabled=${wireOverlayLocked}
          onChange=${(next) => {
            if (wireOverlayLocked) return
            setModelViewerRibbonState({ wireOverlay: next })
            _bridge.setWireOverlay(next)
          }} />
        <${MenuSliderRow}
          icon="📏"
          label="Edge thickness"
          min=${1} max=${6} step=${1}
          value=${wireWidth}
          format=${(v) => String(v)}
          onChange=${(v) => {
            setModelViewerRibbonState({ wireWidth: v })
            _bridge.setWireWidth(v)
          }} />

        <${MenuSectionLabel}>Scene<//>
        <${EnvironmentSubmenu} />
        <${TeamSubmenu} />
        <${MenuSubmenuRow}
          icon="🏔️"
          label="Background Mountains"
          title="Procedural mountains in the background of non-sea worlds — hover for height + scale"
          on=${bgterrain}
          onToggle=${(next) => {
            setModelViewerRibbonState({ bgterrain: next })
            _bridge.setBgTerrain(next)
          }}>
          <${_SubmenuSlider}
            label="Height"
            min=${0} max=${200} step=${5}
            value=${bgterrainHeight}
            onChange=${(v) => {
              setModelViewerRibbonState({ bgterrainHeight: v })
              _bridge.setBgTerrainHeight(v / 100)
            }} />
          <${_SubmenuSlider}
            label="Scale"
            min=${30} max=${300} step=${5}
            value=${bgterrainScale}
            onChange=${(v) => {
              setModelViewerRibbonState({ bgterrainScale: v })
              _bridge.setBgTerrainScale(v / 100)
            }} />
        <//>
        <${SeabedSubmenu} />
      <//>
    </div>
  `
}

function GroundDropdown() {
  const { ground } = _state.value
  const current = _GROUND_MODES.find((g) => g.mode === ground) || _GROUND_MODES[1]
  return html`
    <div class="ribbon-dropdown" id="mv-ground-dropdown">
      <${RibbonDropdownButton}
        id="mv-ground-dropdown-btn"
        dropdownId="mv-ground-dropdown"
        icon=${current.icon}
        label=${current.label}
        title="Pick what the unit stands on" />
      <${Dropdown} id="mv-ground-dropdown">
        ${_GROUND_MODES.map((g) => html`
          <${MenuRow}
            key=${g.mode}
            icon=${g.icon}
            label=${g.label}
            title=${g.title}
            active=${ground === g.mode}
            dropdownId="mv-ground-dropdown"
            onClick=${() => {
              setModelViewerRibbonState({ ground: g.mode })
              _bridge.setGround(g.mode)
            }} />
        `)}
      <//>
    </div>
  `
}

// EnvironmentSubmenu — hover-preview / revert / commit picker for the
// environment row.  Local `previewing` ref tracks whether the user
// has hovered onto a non-committed row; mouseleave on the submenu (or
// the dropdown closing, which unmounts this) reverts the renderer
// back to the committed env.
function EnvironmentSubmenu() {
  const { env } = _state.value
  const previewing = useRef(false)
  const current = _ENVIRONMENTS.find((e) => e.env === env) || _ENVIRONMENTS[0]
  const onSubmenuClose = () => {
    if (previewing.current) {
      previewing.current = false
      _bridge.setEnvironment(_state.value.env, { preview: true })
    }
  }
  // Unmount-on-close revert — when the parent Dropdown unmounts the
  // submenu (popup closes) the MenuSubmenuRow's onClose fires.  We
  // ALSO need to revert if the popup is dismissed without ever moving
  // the cursor back over the submenu — useEffect cleanup covers that.
  useEffect(() => () => {
    if (previewing.current) {
      previewing.current = false
      _bridge.setEnvironment(_state.value.env, { preview: true })
    }
  }, [])
  return html`
    <${MenuSubmenuRow}
      icon=${current.icon}
      currentLabel=${current.label}
      title="Pick the world look"
      onClose=${onSubmenuClose}>
      ${_ENVIRONMENTS.map((e) => html`
        <button key=${e.env}
                class=${'menu-row mv-env-row ' + (env === e.env ? 'active' : '')}
                title=${e.title}
                onMouseEnter=${() => {
                  if (e.env !== _state.value.env) {
                    previewing.current = true
                    _bridge.setEnvironment(e.env, { preview: true })
                  }
                }}
                onClick=${(ev) => {
                  ev.stopPropagation()
                  previewing.current = false
                  setModelViewerRibbonState({ env: e.env })
                  _bridge.setEnvironment(e.env, { commit: true })
                }}>
          <span class="ico">${e.icon}</span><span>${e.label}</span>
        </button>
      `)}
    <//>
  `
}

// TeamSubmenu — mirror of EnvironmentSubmenu for the team-colour
// picker.  Same hover-preview / revert / commit pattern.
function TeamSubmenu() {
  const { team } = _state.value
  const previewing = useRef(false)
  const current = _TEAMS.find((t) => t.team === team) || _TEAMS[0]
  const onSubmenuClose = () => {
    if (previewing.current) {
      previewing.current = false
      _bridge.setTeamColor(_state.value.team, { preview: true })
    }
  }
  useEffect(() => () => {
    if (previewing.current) {
      previewing.current = false
      _bridge.setTeamColor(_state.value.team, { preview: true })
    }
  }, [])
  return html`
    <${MenuSubmenuRow}
      icon=${current.icon}
      currentLabel=${current.label}
      title="Recolour the unit’s team-colour panels"
      onClose=${onSubmenuClose}>
      ${_TEAMS.map((t) => html`
        <button key=${t.team}
                class=${'menu-row mv-team-row ' + (team === t.team ? 'active' : '')}
                title=${t.title}
                onMouseEnter=${() => {
                  if (t.team !== _state.value.team) {
                    previewing.current = true
                    _bridge.setTeamColor(t.team, { preview: true })
                  }
                }}
                onClick=${(ev) => {
                  ev.stopPropagation()
                  previewing.current = false
                  setModelViewerRibbonState({ team: t.team })
                  _bridge.setTeamColor(t.team, { commit: true })
                }}>
          <span class="ico">${t.icon}</span><span>${t.label}</span>
        </button>
      `)}
    <//>
  `
}

// SeabedSubmenu — hover-only row (no on/off toggle).  Sliders live
// inside the hover-revealed submenu body.
function SeabedSubmenu() {
  const {
    seabedHeight, seabedScale, seabedRocks,
  } = _state.value
  return html`
    <${MenuSubmenuRow}
      icon="🪨"
      label="Seabed Features"
      title="Sea-floor rocks + dunes — height, scale, density">
      <div class="submenu-slider-row">
        <span class="slider-lbl">Height</span>
        <input type="range" min="0" max="300" step="5" value=${seabedHeight}
               onInput=${(e) => {
                 const v = +e.currentTarget.value
                 setModelViewerRibbonState({ seabedHeight: v })
                 _bridge.setSeabedHeight(v / 100)
               }}
               onClick=${(e) => e.stopPropagation()}
               onPointerDown=${(e) => e.stopPropagation()} />
        <span class="slider-val">${(seabedHeight / 100).toFixed(1)}×</span>
      </div>
      <div class="submenu-slider-row">
        <span class="slider-lbl">Scale</span>
        <input type="range" min="30" max="300" step="5" value=${seabedScale}
               onInput=${(e) => {
                 const v = +e.currentTarget.value
                 setModelViewerRibbonState({ seabedScale: v })
                 _bridge.setSeabedScale(v / 100)
               }}
               onClick=${(e) => e.stopPropagation()}
               onPointerDown=${(e) => e.stopPropagation()} />
        <span class="slider-val">${(seabedScale / 100).toFixed(1)}×</span>
      </div>
      <div class="submenu-slider-row">
        <span class="slider-lbl">Rocks</span>
        <input type="range" min="0" max="100" step="2" value=${seabedRocks}
               onInput=${(e) => {
                 const v = +e.currentTarget.value
                 setModelViewerRibbonState({ seabedRocks: v })
                 _bridge.setSeabedRocks(v / 100)
               }}
               onClick=${(e) => e.stopPropagation()}
               onPointerDown=${(e) => e.stopPropagation()} />
        <span class="slider-val">${seabedRocks}%</span>
      </div>
    <//>
  `
}

// _SubmenuSlider — small helper for the toggle-submenu sliders that
// share a uniform "1.0×" label format.  Keeps the slider markup out
// of every parent row body so the BgTerrain / Waves / Bob blocks
// don't repeat the same three lines.
function _SubmenuSlider({ label, min, max, step, value, onChange }) {
  return html`
    <div class="submenu-slider-row">
      <span class="slider-lbl">${label}</span>
      <input type="range" min=${min} max=${max} step=${step} value=${value}
             onInput=${(e) => onChange(+e.currentTarget.value)}
             onClick=${(e) => e.stopPropagation()}
             onPointerDown=${(e) => e.stopPropagation()} />
      <span class="slider-val">${(value / 100).toFixed(1)}×</span>
    </div>
  `
}

function OptionsDropdown() {
  const s = _state.value
  return html`
    <div class="ribbon-dropdown" id="mv-options-dropdown">
      <${RibbonDropdownButton}
        id="mv-options-dropdown-btn"
        dropdownId="mv-options-dropdown"
        icon="🎨"
        label="Options"
        title="Shadows, lighting effects + liquid simulation" />
      <${Dropdown} id="mv-options-dropdown">
        <${GraphicsOptionsItems}
          s=${s}
          setState=${_applyGraphicsPatch}
          bridge=${_bridge} />
      <//>
    </div>
  `
}

// CobScriptRow — one button in the dynamic "All scripts" list at the
// bottom of the COB dropdown.  Disabled while the script has a live
// thread (matches the static entry-button gating).
function CobScriptRow({ name, running, gated }) {
  const disabled = running || (gated && !/^Create$/i.test(name))
  return html`
    <button class="cob-row"
            disabled=${disabled || null}
            title=${running
              ? `${name} is already running`
              : (gated && !/^Create$/i.test(name))
                ? 'Run Create first — it must finish before other scripts can fire'
                : `Run ${name} (one-shot)`}
            onClick=${(e) => { e.stopPropagation(); _bridge.runCobEntry(name) }}>
      ${name}
    </button>
  `
}

function CobDropdown() {
  const { cobDamage, cobBuild, cobPlayback } = _state.value
  const { hasCob, scriptNames, runningScripts, lifecycle } = _cobState.value
  const gated = lifecycle === 'unborn' || lifecycle === 'creating'
  // Lower-cased lookup set for case-insensitive "does the COB
  // declare this entry?" checks (matches the runtime's own script
  // resolution semantics).  Recomputed per render; the list is small
  // (typically <30 entries) and the dropdown only re-renders when the
  // COB swaps or a script's running state flips.
  const lower = new Set(scriptNames.map((n) => n.toLowerCase()))
  const showEntry = (name) => {
    // No COB loaded → show every row (the empty state below
    // communicates the missing-script case).  COB loaded → only show
    // rows the COB defines, matching the legacy `hidden` toggle.
    if (!hasCob) return true
    return lower.has(name.toLowerCase())
  }
  return html`
    <div class="ribbon-dropdown" id="mv-anim-dropdown">
      <${RibbonDropdownButton}
        id="mv-anim-dropdown-btn"
        dropdownId="mv-anim-dropdown"
        icon="🎬"
        label="COB"
        title="COB-driven animation: trigger the unit’s standard entry points." />
      <${Dropdown} id="mv-anim-dropdown">
        ${_COB_ENTRIES.map((section) => html`
          <${MenuSectionLabel} key=${section.section}>${section.section}<//>
          ${section.rows.filter((r) => showEntry(r.name)).map((r) => {
            const running = runningScripts.has(r.name.toLowerCase())
            const blocked = gated && !/^Create$/i.test(r.name)
            return html`
              <button key=${r.name}
                      class="menu-row cob-entry"
                      disabled=${(running || blocked) || null}
                      title=${running
                        ? `${r.name} is already running`
                        : blocked
                          ? 'Run Create first — it must finish before other scripts can fire'
                          : r.title}
                      onClick=${(e) => { e.stopPropagation(); _bridge.runCobEntry(r.name) }}>
                <span class="ico">${r.icon}</span><span>${r.name}</span>
              </button>
            `
          })}
        `)}
        <${MenuSectionLabel}>Unit attributes<//>
        <div class="submenu-slider-row" title="Unit damage % - low health triggers SmokeUnit which emits damage smoke from the hull.">
          <span class="slider-lbl">Damage</span>
          <input type="range" min="0" max="100" step="5" value=${cobDamage}
                 onInput=${(e) => {
                   const v = +e.currentTarget.value | 0
                   setModelViewerRibbonState({ cobDamage: v })
                   _bridge.setCobDamage(v)
                 }}
                 onClick=${(e) => e.stopPropagation()}
                 onPointerDown=${(e) => e.stopPropagation()} />
          <span class="slider-val">${cobDamage}%</span>
        </div>
        <div class="submenu-slider-row" title="Build progress 0-100%.  Under 100% renders the unit as a pulsing green nano-frame; at 100% the textures fade in fully.  Returned by GET BUILD_PERCENT_LEFT for scripts that poll it (SmokeUnit’s intro check, factory nano-spray).">
          <span class="slider-lbl">Build</span>
          <input type="range" min="0" max="100" step="5" value=${cobBuild}
                 onInput=${(e) => {
                   const v = +e.currentTarget.value | 0
                   setModelViewerRibbonState({ cobBuild: v })
                   _bridge.setCobBuild(v)
                 }}
                 onClick=${(e) => e.stopPropagation()}
                 onPointerDown=${(e) => e.stopPropagation()} />
          <span class="slider-val">${cobBuild}%</span>
        </div>
        <div class="submenu-slider-row" title="Playback speed for COB animations.  0.25x = quarter speed (slow-motion inspection).  1.0x = real-time TA pacing.  2x = double speed.">
          <span class="slider-lbl">Playback</span>
          <input type="range" min="1" max="1000" step="1" value=${cobPlayback}
                 onInput=${(e) => {
                   const v = +e.currentTarget.value | 0
                   setModelViewerRibbonState({ cobPlayback: v })
                   _bridge.setCobPlayback(v)
                 }}
                 onClick=${(e) => e.stopPropagation()}
                 onPointerDown=${(e) => e.stopPropagation()} />
          <span class="slider-val">${(cobPlayback / 100).toFixed(1)}×</span>
        </div>
        <${MenuRow}
          icon="↺"
          label="Reset State"
          title="Reset every piece to its original 3DO position, kill all COB threads, and zero all static vars.  The unit returns to its raw rest state — exactly as it would look just after Open with no scripts run."
          closesDropdown=${false}
          onClick=${() => _bridge.resetCob()} />
        <${MenuSectionLabel}>All scripts<//>
        <div class="cob-script-list">
          ${!hasCob
            ? html`<div class="cob-empty">No COB attached.</div>`
            : scriptNames.length === 0
              ? html`<div class="cob-empty">COB has no scripts.</div>`
              : scriptNames.map((n) => html`
                  <${CobScriptRow} key=${n} name=${n}
                                   running=${runningScripts.has(n.toLowerCase())}
                                   gated=${gated} />
                `)}
        </div>
      <//>
    </div>
  `
}

// _ViewPanelToggle — single panel-visibility row in the View dropdown.
// Subscribes to the panel's `visible` signal so the check flips the
// instant a panel's ✕ button (or the sandbox Developer Tools dropdown)
// changes its visibility, without an extra cross-channel sync.
function _ViewPanelToggle({ id, icon, label, title }) {
  const sig = panelSignals(id)
  const visible = !!sig.visible.value
  return html`
    <${MenuToggleRow}
      icon=${icon} label=${label} title=${title}
      on=${visible}
      onChange=${(next) => _bridge.setPanelVisible(id, next)} />
  `
}

function ViewDropdown() {
  return html`
    <div class="ribbon-dropdown" id="mv-view-dropdown">
      <${RibbonDropdownButton}
        id="mv-view-dropdown-btn"
        dropdownId="mv-view-dropdown"
        icon="👁"
        label="View"
        title="Toggle floating inspector overlays." />
      <${Dropdown} id="mv-view-dropdown">
        <${MenuSectionLabel}>Inspectors<//>
        ${_VIEW_PANELS.map((p) => html`
          <${_ViewPanelToggle} key=${p.id} id=${p.id} icon=${p.icon}
                               label=${p.label} title=${p.title} />
        `)}
        <${MenuSectionLabel}>Layout<//>
        <${SplitMenuItems}
          dropdownId="mv-view-dropdown"
          onSplitH=${() => _bridge.splitActive('h')}
          onSplitV=${() => _bridge.splitActive('v')}
          onClose=${() => _bridge.closeActive()}
          canClose=${() => _bridge.canClose()} />
      <//>
    </div>
  `
}

export function ModelViewerRibbon() {
  // Subscribe to the state signal at the top so every nested
  // component sees a fresh reference when any field changes.  Cheap —
  // signal reads are diff-free.
  void _state.value
  void _cobState.value
  return html`
    <${Ribbon} className="model-viewer-ribbon" align="space-between">
      <${RibbonSection} label="Model">
        <${ModelDropdown} />
      <//>
      <${RibbonSection} label="Camera">
        <${CameraDropdown} />
      <//>
      <${RibbonSection} label="Rendering">
        <${RenderingDropdown} />
      <//>
      <${RibbonSection} label="Scene">
        <${GroundDropdown} />
      <//>
      <${RibbonSection} label="Graphics Options">
        <${OptionsDropdown} />
      <//>
      <${RibbonSection} label="Animation">
        <${CobDropdown} />
      <//>
      <${RibbonSection} label="View" right=${true}>
        <${ViewDropdown} />
      <//>
      <${RibbonSection} label="Configure" right=${true}>
        <${RibbonButton}
          id="mv-btn-settings"
          icon="⚙"
          label="Settings"
          title="KBot Studio settings"
          onClick=${() => _bridge.openSettings()} />
      <//>
      <${RibbonSection} label="Help">
        <${RibbonButton}
          id="mv-btn-help"
          icon="❓"
          label="Help"
          title="Keyboard shortcuts & tips"
          onClick=${() => _bridge.openHelp()} />
      <//>
    <//>
  `
}

// Unused-import placeholders intentionally avoided — `signal` is used
// by the module-scope state signal, `useState` is used internally by
// the shared MenuSubmenuRow.  We keep the explicit imports up top so
// adding/removing fields here is contained to the constants.
void signal
void useState
