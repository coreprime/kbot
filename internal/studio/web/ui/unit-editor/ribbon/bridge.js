// bridge.js
//
// Host-side wiring for the React unit-editor ribbon + the host bridge
// the React COB/Runtime/Camera panels read through.  Two entry points:
//
//   - wireModelViewerRibbon() — install the unit-editor ribbon's
//     React bridge + mount the ribbon into #model-viewer-ribbon-mount.
//     Every action callback resolves the active ModelViewer / its
//     renderer at call time so a tab swap from one unit to another
//     reaches the right renderer.
//   - wireUnitEditorHostBridge(reactUi) — install the configureHostBridge
//     bundle (camera + cob + runtime + reset + thread-debugger opener)
//     and the two unit-editor preference bridges (Include-Private +
//     Developer Controls section visibility).
//
// External callers route through hostCallbacks where needed (e.g.
// stopAllThreads + stepRuntime reach the live sandbox view + active
// MvControls without an import cycle).  The bridge is constructed
// once per configureReactUi() resolution; the ribbon mount is
// idempotent on subsequent calls.

import { $, state, hostCallbacks, getReactUi } from '../../host-context.js'
import { persistPrefs } from '../../common/prefs.js'
import {
  _activeRuntime,
  mvSetSimulationSpeed,
  mvToggleRuntimePaused,
  mvRefreshRuntimeToggle,
} from '../../common/sim-controls.js'
import { setMvInspectorVisible } from '../../common/inspectors.js'
import { activeRendererView } from '../../common/active-renderer-view.js'
import { confirmDialog } from '../../dialogs/confirm.js'
import { openSettingsDialog } from '../../dialogs/settings.js'
import { openHelpDialog } from '../../dialogs/help.js'
import { openModelPicker } from '../../pickers/open-unit-flow.js'
import { openMvThreadCodeModal } from '../debugger/modal.js'
import { TA_TICK_MS } from '/engine/tick-rate.js'
import { isCobScriptRunning, runCobEntry } from '../cob-sync.js'
import { startMvAutoBuild } from '../runtime.js'
import {
  getActiveModelViewer,
  setUnitEditorAutoRotate,
  setModelOpenIntent,
  teamColourForKey,
} from '../host-state.js'
import { playWeaponSound, openWeaponPicker, selectPiece } from '../sidebar.js'
import { splitActivePane, closeActivePane, canCloseActivePane } from '@coreprime/kbot-ui/split-host'
import { setEnhanceMeshEnabled } from '@coreprime/kbot-game3d/enhance-mesh'

// wireModelViewerRibbon — install the React unit-editor ribbon bridge
// + mount the React tree into #model-viewer-ribbon-mount.  Called
// once configureReactUi has resolved.  Idempotent: the bridge is
// stub-merged on every call, the mount is a no-op when the React
// tree already lives in the slot.
//
// Every action callback resolves modelViewerInstance / its renderer
// at call time so a tab swap from one unit to another reaches the
// right renderer (the React state lives on its own signal — when the
// renderer changes the host pushes fresh defaults via
// applyUnitEditorDefaults, so the toggle row check-marks reflect
// the new unit's renderer state).
export function wireModelViewerRibbon() {
  const reactUi = getReactUi()
  if (!reactUi) return
  // Graphics Options apply scene-wide: a unit-editor tab can host a
  // primary ModelViewer plus N observer panes, each with its own
  // renderer + GL context.  A toggle has to reach every pane or the
  // observers drift out of sync with the primary.  Walk tab.panes
  // (dedup by renderer instance) and fall back to the active viewer.
  const eachRenderer = (fn) => {
    const tab = hostCallbacks.getActiveTab?.()
    const seen = new Set()
    if (tab && tab.panes && tab.panes.size > 0) {
      for (const v of tab.panes.values()) {
        const r = v && v.renderer
        if (r && !seen.has(r)) { seen.add(r); try { fn(r) } catch { /* ignore */ } }
      }
    }
    if (seen.size === 0) {
      const r = getActiveModelViewer()?.renderer
      if (r) { try { fn(r) } catch { /* ignore */ } }
    }
  }
  if (typeof reactUi.configureModelViewerRibbonBridge === 'function') {
    reactUi.configureModelViewerRibbonBridge({
      openAnother: () => { setModelOpenIntent('add'); openModelPicker() },
      showStats:   () => {
        const mv = getActiveModelViewer()
        if (!mv || !mv.model) return
        const m = mv.model
        const triCount = m.flat.reduce((n, p) => n + p.drawGroups.reduce(
          (s, g) => s + (g.mode === mv.renderer.gl.TRIANGLES ? g.vertexCount / 3 : 0), 0), 0)
        const msg = `${m.name} · ${m.flat.length} pieces · ${Math.round(triCount)} triangles`
        const el = $('#status')
        if (el) el.textContent = msg
      },

      resetCamera: () => {
        const mv = getActiveModelViewer()
        if (!mv || !mv.model) return
        const cam = mv.camera
        cam.frameBounds(mv.model.bounds.min, mv.model.bounds.max)
        // Restore the entry-view angle the auto-rotate sweep has
        // walked away from.
        cam.yaw = 215 * Math.PI / 180
        cam.pitch = 18 * Math.PI / 180
        cam.distance *= 1.25
        mv.renderer.requestRedraw()
      },
      setAutoRotate: (on) => {
        setUnitEditorAutoRotate(!!on)
        getActiveModelViewer()?.setAutoRotate(!!on)
      },

      setRenderMode:   (mode) => getActiveModelViewer()?.renderer?.setRenderMode(mode),
      setWireOverlay:  (on)   => getActiveModelViewer()?.renderer?.setWireframeOverlay(!!on),
      setWireWidth:    (px)   => getActiveModelViewer()?.renderer?.setWireframeWidth(px),

      setGround:       (mode) => getActiveModelViewer()?.renderer?.setGroundMode(mode),

      setEnvironment:  (env, _opts) => {
        getActiveModelViewer()?.renderer?.setEnvironment(env)
      },
      setTeamColor:    (key, _opts) => {
        getActiveModelViewer()?.renderer?.setTeamColor(teamColourForKey(key))
      },

      // Geometry — flip the shared Enhanced Mesh flag.  Every open
      // model-viewer subscribes via onEnhanceMeshChanged and reloads its
      // geometry in place, so this is identical to the sandbox bridge —
      // one entry point, the views react.
      setEnhanceMesh:       (on) => setEnhanceMeshEnabled(!!on),

      // Graphics Options — broadcast across every pane's renderer so a
      // toggle/slider takes effect on the primary AND its observers.
      setLightIntensity:    (v)  => eachRenderer((r) => r.setExposure?.(v)),
      setMaxDynamicLights:  (v)  => eachRenderer((r) => r.setMaxDynamicLights?.(v)),
      setShadows:           (on) => eachRenderer((r) => r.setShadowsEnabled?.(!!on)),
      setShadowIntensity:   (v)  => eachRenderer((r) => r.setShadowStrength?.(v)),
      setSelfShadow:        (on) => eachRenderer((r) => r.setSelfShadow?.(!!on)),

      setReflections:       (on) => eachRenderer((r) => r.setReflectionsEnabled?.(!!on)),
      setSpecular:          (on) => eachRenderer((r) => r.setSpecularEnabled?.(!!on)),
      setSpecularStrength:  (v)  => eachRenderer((r) => r.setSpecularStrength?.(v)),
      setMetalSpec:         (on) => eachRenderer((r) => r.setMetalSpecEnabled?.(!!on)),
      setRunningLights:     (on) => eachRenderer((r) => r.setRunningLightsEnabled?.(!!on)),
      setRunningLightsStrength: (v) => eachRenderer((r) => r.setRunningLightsStrength?.(v)),
      setBumpMap:           (on) => eachRenderer((r) => r.setBumpEnabled?.(!!on)),
      setBumpStrength:      (v)  => eachRenderer((r) => r.setBumpStrength?.(v)),
      setGodBeams:          (on) => eachRenderer((r) => r.setGodBeamsEnabled?.(!!on)),
      setDoF:               (on) => eachRenderer((r) => r.setDoFEnabled?.(!!on)),
      setDoFDistance:       (v)  => eachRenderer((r) => r.setDoFDistance?.(v)),
      setDoFLevel:          (v)  => eachRenderer((r) => r.setDoFLevel?.(v)),
      setAntialias:         (on) => eachRenderer((r) => r.setAntialiasEnabled?.(!!on)),
      setCinematic:         (on) => eachRenderer((r) => r.setCinematic?.(!!on)),
      setCinematicStrength: (v)  => eachRenderer((r) => r.setCinematicStrength?.(v)),
      setBloom:             (on) => eachRenderer((r) => r.setBloomEnabled?.(!!on)),
      setBloomStrength:     (v)  => eachRenderer((r) => r.setBloomStrength?.(v)),
      setLensFlare:         (on) => eachRenderer((r) => r.setLensFlareEnabled?.(!!on)),
      setLensFlareStrength: (v)  => eachRenderer((r) => r.setLensFlareStrength?.(v)),
      setWaterReflections:  (on) => eachRenderer((r) => r.setWaterReflectionsEnabled?.(!!on)),

      setBob:               (on) => eachRenderer((r) => r.setBobEnabled?.(!!on)),
      setBobAmount:         (v)  => eachRenderer((r) => r.setBobAmount?.(v)),
      setBobSpeed:          (v)  => eachRenderer((r) => r.setBobSpeed?.(v)),
      setWaves:             (on) => eachRenderer((r) => r.setWavesEnabled?.(!!on)),
      setWavesIntensity:    (v)  => eachRenderer((r) => r.setWavesIntensity?.(v)),
      setBgTerrain:         (on) => getActiveModelViewer()?.renderer?.setBgTerrainEnabled(!!on),
      setBgTerrainHeight:   (v)  => getActiveModelViewer()?.renderer?.setBgTerrainHeight(v),
      setBgTerrainScale:    (v)  => getActiveModelViewer()?.renderer?.setBgTerrainScale(v),
      setSeabedHeight:      (v)  => getActiveModelViewer()?.renderer?.setSeabedHeight(v),
      setSeabedScale:       (v)  => getActiveModelViewer()?.renderer?.setSeabedScale(v),
      setSeabedRocks:       (v)  => getActiveModelViewer()?.renderer?.setSeabedRockChance(v),

      runCobEntry: (name) => {
        const cob = getActiveModelViewer()?.cob
        if (cob) runCobEntry(cob, name)
      },
      setCobDamage: (v) => getActiveModelViewer()?.setDamage?.(v | 0),
      setCobBuild:  (v) => {
        const mv = getActiveModelViewer()
        if (mv) mv._autoBuild = null
        mv?.setBuildPercent?.(v | 0)
      },
      setCobPlayback: (pct) => mvSetSimulationSpeed((pct | 0) / 100),
      resetCob:       () => getActiveModelViewer()?.resetState?.(),

      setPanelVisible: (panelId, on) => setMvInspectorVisible(panelId, !!on),

      // Pane layout — split / close the active unit-editor tab's panes
      // from the View menu.  The unit adapter refuses to close the
      // primary leaf (it owns the COB-running ModelViewer), so canClose
      // hides the row whenever the primary pane is focused or it's the
      // only pane.
      splitActive: (orient) => {
        const tab = hostCallbacks.getActiveTab?.()
        if (tab) splitActivePane(tab, orient)
      },
      closeActive: () => {
        const tab = hostCallbacks.getActiveTab?.()
        if (tab) closeActivePane(tab)
      },
      canClose: () => {
        const tab = hostCallbacks.getActiveTab?.()
        return tab ? canCloseActivePane(tab) : false
      },

      openSettings: () => {
        if (typeof openSettingsDialog === 'function') openSettingsDialog()
        else $('#btn-settings')?.click()
      },
      openHelp: () => {
        if (typeof openHelpDialog === 'function') openHelpDialog()
        else $('#btn-help')?.click()
      },
    })
  }
  if (typeof reactUi.mountModelViewerRibbon === 'function') {
    reactUi.mountModelViewerRibbon()
  }
}

// wireUnitEditorHostBridge installs the React host-bridge bundle the
// COB/Runtime/Camera panels read through, plus the two unit-editor
// preference bridges (Include-Private toggle + Developer Controls
// section visibility).  Bridges resolve the active view / runtime
// at call time so a sandbox / unit-editor swap reaches the right
// place even though configure runs only once.
export function wireUnitEditorHostBridge(reactUi) {
  if (!reactUi) return
  reactUi.configureHostBridge({
    setTracking:   (on) => {
      const v = activeRendererView()
      if (v && typeof v.setTracking === 'function') v.setTracking(on)
      else {
        const ctrls = hostCallbacks.getActiveMvControls?.()
        if (ctrls && typeof ctrls.setTracking === 'function') {
          ctrls.setTracking(on)
        }
      }
    },
    setAutoRotate: (on) => {
      setUnitEditorAutoRotate(!!on)
      const v = activeRendererView()
      const r = v && v.renderer
      if (r && typeof r.setAutoRotate === 'function') r.setAutoRotate(on)
    },
    runCobEntry:        (cob, name) => runCobEntry(cob, name),
    isCobScriptRunning: (cob, name) => isCobScriptRunning(cob, name),
    runControlsCreate:  () => {
      // Mirror of the old #mv-controls-create-btn click handler:
      // launch Create, flip lifecycle to 'creating' so the action
      // grid stays gated, then kick the visual build ramp so the
      // user sees the construction-stripe wireframe phase in.
      const mvi = getActiveModelViewer()
      const cob = mvi && mvi.cob
      if (!cob || !cob.hasScript || !cob.hasScript('Create')) return
      cob.start('Create')
      cob._lifecycle = 'creating'
      startMvAutoBuild(mvi)
    },
    // Runtime overlay controls.  setSimSpeed routes through the
    // same mvSetSimulationSpeed entry point the COB-menu Playback
    // slider uses, so dragging either keeps both labels + sandbox
    // runtime in sync.  toggle/step/stopAll target whichever
    // runtime is active (unit-editor viewer first, then sandbox).
    setSimSpeed: (rate) => mvSetSimulationSpeed(rate),
    toggleRuntimePaused: () => mvToggleRuntimePaused(),
    stepRuntime: () => {
      const rt = _activeRuntime()
      if (!rt) return
      // Joined sandbox: a single-step is authoritative.  Ask the host to advance
      // exactly one tick and broadcast it; every client's local prediction then
      // follows via serverTick.  No local frame replay — that would desync this
      // window ahead of the others.
      if (rt.isJoin && typeof rt.stepOnce === 'function') {
        rt.stepOnce()
        const ui = getReactUi()
        if (ui && typeof ui.bumpRuntimeTick === 'function') ui.bumpRuntimeTick()
        return
      }
      // Force one fixed TA_TICK_MS step across the WHOLE per-frame
      // pipeline, not just the COB scripts.  rt.tick(TA_TICK_MS) alone
      // only advances bytecode — weapons, movement, particles, audio,
      // and smoke trails are driven elsewhere (engine.tick + the
      // per-view onAfterFrame hook), so a script-only step looked
      // like "the panel stats tick but nothing in the world moves."
      //
      // Unpause briefly, drive the same calls a real frame makes,
      // then re-pause.  Leave each thread's breakpointHit flag
      // ALONE — _runThread treats a set flag as "skip the BP check
      // on the first instruction this tick" so the BP'd line
      // executes once, the PC moves past it, and subsequent ops
      // re-engage BP checking.  Clearing the flag here would let
      // the BP at the same PC re-fire immediately and Step would
      // be stuck pacing the same line forever.
      //
      // Override playbackRate to 1× for the duration of the step so
      // every downstream tick consumer (runtime accumulator, engine
      // dtSec, smoke trails, simRate helper) treats this as exactly
      // one TA tick regardless of the user's sim-speed setting.  At
      // 0.5× the runtime's accumulator would only see 12.5 ms per
      // step and would never reach the TA_TICK_MS threshold —
      // multiple clicks would advance one tick.  At 2× the
      // accumulator would see 50 ms and drain two ticks per click.
      // Both wrong: Step is meant to be a "freeze-frame advance",
      // not a sped-up/slowed-down advance.
      const dlg = document.getElementById('model-viewer-dialog')
      const sandboxOn = dlg && dlg.classList.contains('sandbox-mode')
      const wasPaused = rt.paused
      const savedRate = rt.playbackRate
      rt.paused = false
      rt.playbackRate = 1
      try {
        if (sandboxOn) {
          // Sandbox per-frame: scene.tick → engine.tick (runtime +
          // movement + attack + weapons + particles + audio via
          // syncBinding) + the shared smoke-trail advance through
          // the SmokeTrailManager that view-helpers stashed on
          // sv._smokeTrails.  With playbackRate forced to 1 above,
          // the smokeTrails rate calc below resolves to 1 too — so
          // the trails get exactly one TA tick's worth of advance
          // regardless of the user's sim-speed selection.
          const sv = hostCallbacks.getActiveSandboxView?.() || null
          if (sv && sv.scene && typeof sv.scene.tick === 'function') sv.scene.tick(TA_TICK_MS)
          if (sv && sv._smokeTrails) {
            const rt = sv.runtime
            const rate = !rt ? 1 : (rt.paused ? 0 : (rt.playbackRate || 1))
            try { sv._smokeTrails.tick(TA_TICK_MS * rate) } catch { /* ignore */ }
          }
        } else {
          // Viewer per-frame: binding.tick (runtime + particles +
          // audio) + MvControls.tick (movement + weapons via
          // engine.tick(skipRuntime, skipMovement, skipSync), plus
          // its own tickSmokeTrails inside).
          const mv = getActiveModelViewer()
          const cob = mv && mv.cob
          if (cob && typeof cob.tick === 'function') cob.tick(TA_TICK_MS)
          const ctrls = hostCallbacks.getActiveMvControls?.()
          if (ctrls && typeof ctrls.tick === 'function') ctrls.tick(TA_TICK_MS)
        }
      } finally {
        // Restore the user's chosen playback rate even if a tick
        // call threw — otherwise a buggy script could permanently
        // pin the sim to 1× and leave the user wondering why their
        // slider stopped working.
        rt.playbackRate = savedRate
      }
      // Always leave the runtime paused after a step so the user
      // can keep stepping (`wasPaused || true === true`).
      rt.paused = wasPaused || true
      mvRefreshRuntimeToggle()
      // Snap the React panels to the post-step state immediately
      // instead of waiting for the next 4 Hz publish — the stats
      // row, the thread list, and the Pause/Resume label all read
      // through mutable refs that need a tick to re-paint.
      const ui = getReactUi()
      if (ui && typeof ui.bumpRuntimeTick === 'function') {
        ui.bumpRuntimeTick()
      }
    },
    stopAllThreads: async () => {
      const rt = _activeRuntime()
      if (!rt || typeof rt.killAllThreads !== 'function') return
      // Confirm before tearing every COB thread down — motion
      // controllers, smoke loops, the unit's idle background scripts
      // all die.  Users almost always WANT this when they click
      // Terminate All Scripts, but the action is irreversible (the
      // dead threads' state is gone), so the in-app confirm modal
      // routes the click through a yes/no prompt.
      const ok = await confirmDialog({
        title: 'Terminate All Scripts',
        message: 'This will stop all unit scripts, including motion controllers, smoke and other background threads.  Proceed?',
        okLabel: 'Terminate All',
        cancelLabel: 'Cancel',
        okDanger: true,
      })
      if (!ok) return
      rt.killAllThreads()
      // Repaint the thread list NOW so the user sees the empty /
      // "killed" state without a 250 ms publish lag.
      const ui = getReactUi()
      if (ui && typeof ui.bumpRuntimeTick === 'function') {
        ui.bumpRuntimeTick()
      }
    },
    resetUnit: (unit, cob) => {
      const mv = getActiveModelViewer()
      if (cob && mv && mv.cob === cob && cob.unit === unit) {
        mv.resetState()
        return
      }
      // wasm sandbox units own their script state in the engine; the field-poking
      // path below resets only the JS adapter snapshot, so route to the adapter's
      // engine-backed reset() when present and repaint the panel immediately.
      if (typeof unit.reset === 'function') {
        unit.reset()
        const ui = getReactUi()
        if (ui && typeof ui.bumpRuntimeTick === 'function') ui.bumpRuntimeTick()
        return
      }
      if (typeof unit.killAllThreads === 'function') unit.killAllThreads()
      unit._threads.length = 0
      unit._recentlyKilled.length = 0
      for (let i = 0; i < unit.staticVars.length; i++) unit.staticVars[i] = 0
      unit._moveAnims.length = 0
      unit._rotAnims.length = 0
      for (let i = 0; i < unit._pieceVisible.length; i++) unit._pieceVisible[i] = true
      // Wipe the debugger's coverage hints so the next run paints
      // a clean dim/lit map.  Without this, lines that ran before
      // the reset stay lit even though execution starts over.
      if (typeof unit.clearExecutedOffsets === 'function') unit.clearExecutedOffsets()
    },
    openThreadCodeModal: (cob, thread) => openMvThreadCodeModal(cob, thread),
    // Force Sync (Network panel) — re-pull the authority's full snapshot,
    // discarding local work. Only the joined sandbox scene can honour it; the
    // unit editor and an offline sandbox simply have no authority to re-pull.
    forceSync: () => {
      const sv = hostCallbacks.getActiveSandboxView?.() || null
      sv?.scene?.forceSync?.()
      const ui = getReactUi()
      if (ui && typeof ui.bumpRuntimeTick === 'function') ui.bumpRuntimeTick()
    },
    // Diagnose (Network panel) — fetch a read-only authoritative snapshot for a
    // drift comparison without disturbing local prediction. Routes to the joined
    // sandbox scene; rejects elsewhere (no authority to query).
    diagnose: () => {
      const sv = hostCallbacks.getActiveSandboxView?.() || null
      if (sv?.scene?.diagnose) return sv.scene.diagnose()
      return Promise.reject(new Error('no authority'))
    },
    // Hover-highlight (Sync Diagnostics panel) — mark the hovered row's unit /
    // projectile ids so the active sandbox renderer outlines them. Empty arrays
    // clear the highlight. Only the joined sandbox scene carries live entities.
    highlightEntities: (unitIds, projIds) => {
      const sv = hostCallbacks.getActiveSandboxView?.() || null
      sv?.scene?.setHighlight?.(unitIds || [], projIds || [])
    },
  })
  // Bridge the Include-Private toggle into the prefs system so the
  // React Script Commands panel signal + persisted
  // state.mvActionsIncludePrivate stay in lockstep.  Pref key keeps
  // the legacy 'mvActions' prefix so saved preferences survive the
  // Actions → Script Commands rename.
  reactUi.configureActionsIncludePrivate(
    () => !!state.mvActionsIncludePrivate,
    (on) => { state.mvActionsIncludePrivate = !!on; persistPrefs() },
  )
  // Bridge the Developer Controls toggle so the React Controls
  // panel reads + writes the same persisted preference the
  // Developer Tools dropdown row in the sandbox ribbon uses.
  reactUi.configureControlsDevSectionVisible(
    () => state.mvControlsDevVisible === undefined ? true : !!state.mvControlsDevVisible,
    (on) => { state.mvControlsDevVisible = !!on; persistPrefs() },
  )
  // Bridge the React unit-editor sidebar tabs (Pieces / Textures /
  // Weapons) to the live renderer / viewer / weapon-picker / audio
  // so the tab components reach the active ModelViewer through
  // getActiveModelViewer() rather than a module-let reference.  Each
  // configure* call is guarded — the React island may pre-date the
  // matching bridge if mount.js' surface diverges.
  if (typeof reactUi.configureTexturesBridge === 'function') {
    reactUi.configureTexturesBridge({
      setHoveredTexture: (name) => {
        getActiveModelViewer()?.renderer?.setHoveredTexture?.(name)
      },
      // Re-apply the hints table (incl. live session overrides) to the
      // loaded model + redraw — drives the Textures panel's per-tile
      // specular / running-lights / bump parameter editors.
      refreshHints: () => {
        getActiveModelViewer()?.renderer?.reapplyTextureHints?.()
      },
    })
  }
  if (typeof reactUi.configurePieceTreeBridge === 'function') {
    reactUi.configurePieceTreeBridge({
      setHoveredPieceName: (name) => {
        getActiveModelViewer()?.renderer?.setHoveredPieceName?.(name)
      },
      selectPiece: (name) => selectPiece(name),
      // Per-piece rotate dial.  The dial works in degrees (0-360° = the full
      // TA rotation arc in game units); the renderer + COB engine state work
      // in radians, so the deg↔rad conversion lives here at the bridge.
      rotatePiece: (name, axis, deg) => {
        const rad = (((+deg || 0) % 360) * Math.PI) / 180
        getActiveModelViewer()?.renderer?.rotatePiece?.(name, axis, rad)
      },
      getPieceRotation: (name) => {
        const rads = getActiveModelViewer()?.renderer?.getPieceRotation?.(name)
        if (!rads) return [0, 0, 0]
        // radians → degrees in [0, 360)
        return rads.map((r) => {
          let d = (r * 180) / Math.PI
          d = ((d % 360) + 360) % 360
          return Math.round(d)
        })
      },
      requestRedraw: () => getActiveModelViewer()?.renderer?.requestRedraw?.(),
    })
  }
  if (typeof reactUi.configureWeaponsTabBridge === 'function') {
    reactUi.configureWeaponsTabBridge({
      paletteColor: (idx) => {
        const mv = getActiveModelViewer()
        const pal = mv && mv.palette
        if (!pal || idx <= 0) return null
        return pal.colorFor(idx)
      },
      openWeaponPicker: (slotIndex) => openWeaponPicker(getActiveModelViewer(), slotIndex),
      playSound: (stem) => playWeaponSound(stem),
    })
  }
}
