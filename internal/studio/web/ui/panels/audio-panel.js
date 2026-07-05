// audio-panel.js
//
// React-rendered Audio overlay — live debugger of the AudioPool.
// Lists every sound currently playing with stem, source label, world
// position (when known), volume, and a progress bar driven off the
// HTMLAudioElement's currentTime + the entry's recorded durationMs.
//
// Same layout as the legacy vanilla renderer (chip strip + per-entry
// cards) so the existing studio.css rules apply unchanged.  The body
// is gated on the panel-store visible signal so a closed / collapsed
// panel does no per-tick work even though the host's inspector tick
// keeps publishing fresh mv references at 4 Hz.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { FloatingPanel } from '@coreprime/kbot-ui/floating-panel'
import { panelSignals } from '@coreprime/kbot-ui/panel-store'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'

const PANEL_ID = 'mv-inspector-audio'

// Human-friendly tag labels for each AudioPool entry kind.  Keeps
// the chip strip + per-entry tag readable instead of leaking the
// internal slugs (e.g. 'weapon-fire' → 'WEAPON').
const KIND_NAMES = {
  'unit':        'UNIT',
  'weapon-fire': 'WEAPON',
  'weapon-hit':  'HIT',
  'ui':          'UI',
  'cob':         'COB',
}

const fmt = (v) => `${(+v).toFixed(1)}`

// _collectEntries — drains the AudioPool into a plain array so we
// can iterate it twice (once for the chip tally, once for the per-
// entry cards) without re-walking the pool's internal map.  Returns
// the live entries with the kind-tally Map alongside.
function _collectEntries(pool) {
  const entries = []
  const counts = new Map()
  pool.each((e) => {
    entries.push(e)
    counts.set(e.kind, (counts.get(e.kind) || 0) + 1)
  })
  return { entries, counts }
}

// AudioCard — one card per playing sound.  Pulled out as its own
// component so each card's reconcile is independent — if 10 sounds
// are playing and only one's progress bar updates a sub-pixel each
// tick, Preact's keyed diff still touches only that card's nodes.
function AudioCard({ entry: e }) {
  const tagClass = `mv-au-kind kind-${e.kind}`
  const tagText = KIND_NAMES[e.kind] || e.kind.toUpperCase()
  const dur = e.durationMs && e.durationMs > 0
    ? e.durationMs
    : (e.audio.duration > 0 ? e.audio.duration * 1000 : null)
  const cur = e.audio.currentTime * 1000
  const timeText = dur
    ? `${(cur / 1000).toFixed(2)}s / ${(dur / 1000).toFixed(2)}s`
    : `${(cur / 1000).toFixed(2)}s`
  const pct = dur ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0
  return html`
    <div class="mv-au-card">
      <div class="mv-au-card-head">
        <span class=${tagClass}>${tagText}</span>
        <span class="mv-au-stem">${e.stem}</span>
      </div>
      <div class="mv-au-source">${e.source || '—'}</div>
      <div class="mv-au-card-stats">
        ${e.x != null ? html`
          <div class="mv-au-stat">
            <span class="k">Pos</span>
            <span class="v">${fmt(e.x)}, ${fmt(e.y)}, ${fmt(e.z)}</span>
          </div>` : null}
        <div class="mv-au-stat">
          <span class="k">Vol</span>
          <span class="v">${(e.vol * 100).toFixed(0)}%</span>
        </div>
        <div class="mv-au-stat">
          <span class="k">Time</span>
          <span class="v">${timeText}</span>
        </div>
      </div>
      <div class="mv-au-life-bar">
        <div class="mv-au-life-fill" style=${`width:${pct.toFixed(1)}%`}></div>
      </div>
    </div>
  `
}

function AudioBody() {
  const { visible } = panelSignals(PANEL_ID)
  // Subscribe to runtimeTick so per-publish refresh re-walks the
  // AudioPool — in unit-editor mode mv.value's reference is stable
  // (it's the singleton modelViewerInstance) so without the tick
  // read this body would never re-render when sounds start / stop.
  void runtimeTick.value
  if (!visible.value) return null
  const proxy = mv.value
  const pool = proxy && proxy.cob && proxy.cob.audio
  if (!pool) {
    return html`<div class="mv-inspector-empty">No audio pool.</div>`
  }
  if (pool.count() === 0) {
    return html`<div class="mv-inspector-empty">No sounds playing.</div>`
  }
  const { entries, counts } = _collectEntries(pool)
  return html`
    <div class="mv-fx-chips">
      ${[...counts].map(([kind, n]) => html`
        <span class="mv-fx-chip" key=${kind}>${KIND_NAMES[kind] || kind.toUpperCase()} ×${n}</span>
      `)}
    </div>
    ${entries.map((e, i) => html`<${AudioCard} entry=${e} key=${i} />`)}
  `
}

export function AudioPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Active Sounds">
      <${AudioBody} />
    <//>
  `
}
