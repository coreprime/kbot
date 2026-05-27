// welcome-screen.js
//
// React-rendered Welcome screen body.  Owns the title, the workflow
// tab strip (Sandbox Mode / Map Creator / Unit Creator / Scripting /
// Other), and each tab's card content.  The host (studio.js) renders
// this component into the dialog card SLOT inside #welcome-dialog;
// the surrounding chrome (the glamour cross-fade layer, the NanoFX
// canvas, the buildup-audio cue) stays as static markup + leaf-level
// imperative wiring because none of it depends on tab switching.
//
// Tab state lives in a local signal so a tab click takes effect
// without a host round-trip.  Each card fires a host callback (passed
// via props) — onNewMap, onOpenMap, onOpenUnit, onOpenSandbox — so
// the screen doesn't reach into studio.js's globals to do its work.
// Cards with no live host wiring yet (Load Sandbox, New Unit, every
// Scripting card, the HPI/TNT upload button) are rendered `disabled`
// so the user sees the planned surface area without thinking the
// click did nothing.

import { useEffect, useRef } from 'preact/hooks'
import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'

// Module-scoped so the tab the user picked survives unmount/remount
// (e.g. opening + closing the dialog without losing the workflow
// context).  Defaults to 'sandbox' — sandbox is the first tab AND the
// fastest path to verify a unit in motion, so a fresh boot lands
// there.
const _activeTab = signal('sandbox')

// _TABS — single source of truth for the tab strip.  Each entry has
// the display label and an optional `disabled` flag.  Order here is
// the visual left-to-right order in the tab bar.  Scripting stays
// enabled (its sub-cards are all disabled stubs — clicking the tab
// lets the user see what's coming) while Other is a fully-disabled
// roadmap placeholder.
const _TABS = [
  { key: 'sandbox',   label: 'Sandbox Mode' },
  { key: 'mapping',   label: 'Map Creator' },
  { key: 'modelling', label: 'Unit Creator' },
  { key: 'scripting', label: 'Scripting' },
  { key: 'other',     label: 'Other', disabled: true,
    title: 'More workflows on the roadmap.' },
]

// _CARD — small helper that renders one welcome-card.  Centralising
// the markup keeps the disabled / placeholder treatment (extra class
// + click no-op + cursor flip) in one place; without it each card
// duplicated the ternary.  `onClick` is optional — disabled cards
// pass null + the helper skips the binding.
function _Card({ icon, title, sub, onClick, disabled = false, titleAttr = null }) {
  const cls = 'welcome-card' + (disabled ? ' welcome-card-disabled' : '')
  return html`
    <button class=${cls}
            disabled=${disabled || null}
            title=${titleAttr || (disabled ? 'Coming soon.' : null)}
            onClick=${disabled ? null : onClick}>
      <span class="welcome-card-ico">${icon}</span>
      <span class="welcome-card-title">${title}</span>
      <span class="welcome-card-sub">${sub}</span>
    </button>
  `
}

export function WelcomeScreen({
  onNewMap,
  onOpenMap,
  onOpenUnit,
  onOpenSandbox,
}) {
  const active = _activeTab.value
  // Keyboard nav — Arrow Left / Right walks the cards inside whichever
  // panel is active.  Same shape the legacy wireWelcomeKeyboard()
  // shipped; mounted on the card row so tab-press doesn't carry
  // through to the dialog.  The ref is re-bound each time `active`
  // changes (the rendered panel changes too), so all four tabs get
  // identical keyboard behaviour without per-tab duplication.
  const cardRowRef = useRef(null)
  useEffect(() => {
    if (!cardRowRef.current) return undefined
    const row = cardRowRef.current
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const cards = [...row.querySelectorAll('button:not([disabled])')]
      if (cards.length === 0) return
      const cur = cards.indexOf(document.activeElement)
      const next = e.key === 'ArrowLeft'
        ? (cur <= 0 ? cards.length - 1 : cur - 1)
        : (cur < 0 ? 0 : (cur + 1) % cards.length)
      cards[next].focus()
      e.preventDefault()
    }
    row.addEventListener('keydown', onKey)
    return () => row.removeEventListener('keydown', onKey)
  }, [active])
  return html`
    <h1 class="welcome-title">Welcome to KBot Studio</h1>
    <p class="welcome-tagline">
      <span>A web-based workbench for Total Annihilation and TA: Kingdoms.  Pick a workflow to begin.</span>
    </p>
    <div class="welcome-tabs" role="tablist" aria-label="Workflow">
      ${_TABS.map((t) => html`
        <button key=${t.key}
                class=${'welcome-tab' + (active === t.key ? ' active' : '')}
                role="tab"
                aria-selected=${active === t.key ? 'true' : 'false'}
                aria-disabled=${t.disabled ? 'true' : null}
                disabled=${t.disabled ? true : null}
                title=${t.title || null}
                onClick=${() => { if (!t.disabled) _activeTab.value = t.key }}>
          ${t.label}
        </button>
      `)}
    </div>
    ${active === 'sandbox' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="sandbox">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="🪖"
            title="New Sandbox"
            sub="Drop units on a blank battlefield and test them live."
            onClick=${() => onOpenSandbox && onOpenSandbox()} />
          <${_Card}
            icon="📂"
            title="Load Sandbox"
            sub="Reopen a saved sandbox from your workspace."
            disabled=${true} />
        </div>
      </div>
    ` : null}
    ${active === 'mapping' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="mapping">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="✨"
            title="New Map"
            sub="Start a fresh battlefield from a blank canvas."
            onClick=${() => onNewMap && onNewMap()} />
          <${_Card}
            icon="📂"
            title="Open Map"
            sub="Open an existing map from your workspace."
            onClick=${() => onOpenMap && onOpenMap()} />
          <${_Card}
            icon="⬆"
            title="Upload TNT / OTA"
            sub="Bring in a TNT + OTA pair from outside your workspace."
            disabled=${true} />
        </div>
      </div>
    ` : null}
    ${active === 'modelling' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="modelling">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="✨"
            title="New Unit"
            sub="Start a new unit from a COB script and 3DO model."
            disabled=${true} />
          <${_Card}
            icon="🛠"
            title="Open Unit"
            sub="Browse, test, and tune existing units in your workspace."
            onClick=${() => onOpenUnit && onOpenUnit()} />
        </div>
      </div>
    ` : null}
    ${active === 'scripting' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="scripting">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="✨"
            title="New Script"
            sub="Start a new BOS script for a unit or mission."
            disabled=${true} />
          <${_Card}
            icon="📂"
            title="Open Script"
            sub="Open an existing BOS file from your workspace."
            disabled=${true} />
          <${_Card}
            icon="↻"
            title="Decompile Script"
            sub="Recover BOS from a COB when source is missing."
            disabled=${true} />
        </div>
      </div>
    ` : null}
  `
}

// setWelcomeTab — host helper for surfacing a specific workflow
// programmatically (e.g. after a Modelling-context error the host
// might want to nudge the user back to the Mapping tab).
export function setWelcomeTab(key) {
  if (_TABS.find((t) => t.key === key && !t.disabled)) _activeTab.value = key
}
