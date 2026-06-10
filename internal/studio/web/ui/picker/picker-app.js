// picker-app.js
//
// The workspace picker: lists recently-used workspaces and configured
// kbot contexts, filtered by game via the top tabs, opening each in its
// own browser tab under /workspaces/<id>/. On wide displays the two lists
// sit side by side; hovering a context draws curved arrows to the context
// it's based on and to the workspaces that use it, and hovering a
// workspace draws an arrow back to its base context.

import { useState, useRef, useEffect } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'
import { useAsync, Loading, ErrorMsg } from '@kbot/ui/async'
import { Tag } from '@kbot/ui/tag'
import { GameChip, GameIcon } from '@kbot/ui/game-icon'
import { confirmDialog } from '@kbot/ui/confirm-dialog'
import { CavedogIcon } from './icons.js'
import { NewWorkspaceDialog } from './new-workspace-dialog.js'

// Header brand logos. All three are stacked and cross-faded via CSS opacity as
// the game filter changes: the blended logo for All/Other, and the
// game-specific banner when the TA or TA:Kingdoms tab is selected.
const HEADER_LOGOS = [
  { id: 'general', src: '/branding/logos/kbot-header.png' },
  { id: 'totala', src: '/branding/logos/kbot-header-ta.png' },
  { id: 'takingdoms', src: '/branding/logos/kbot-header-tak.png' },
]

function activeLogoId(filter) {
  if (filter === 'totala' || filter === 'takingdoms') return filter
  return 'general'
}

const WIDE_QUERY = '(min-width: 1040px)'

async function getJSON(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
  return r.json()
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function openInTab(body) {
  const res = await post('/api/hub/open', body)
  window.open(res.url, '_blank')
}

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'totala', label: 'Total Annihilation' },
  { id: 'takingdoms', label: 'TA: Kingdoms' },
  { id: 'other', label: 'Other' },
]

function tabIcon(id) {
  if (id === 'all') return html`<${CavedogIcon} size=${16} />`
  if (id === 'other') return html`<${GameIcon} game="custom" size=${16} />`
  return html`<${GameIcon} game=${id} size=${16} />`
}

function gameMatches(filter, game) {
  if (filter === 'all') return true
  if (filter === 'other') return game !== 'totala' && game !== 'takingdoms'
  return game === filter
}

function attrEsc(s) {
  return String(s).replace(/(["\\])/g, '\\$1')
}

function edgePoint(rect, base, towardX, towardY) {
  const x0 = rect.left - base.left
  const y0 = rect.top - base.top
  const cx = x0 + rect.width / 2
  const cy = y0 + rect.height / 2
  if (Math.abs(towardX - cx) > Math.abs(towardY - cy)) {
    const right = towardX > cx
    return { x: right ? x0 + rect.width : x0, y: cy, dir: right ? 1 : -1, horiz: true }
  }
  const down = towardY > cy
  return { x: cx, y: down ? y0 + rect.height : y0, dir: down ? 1 : -1, horiz: false }
}

function arrowPath(base, fromRect, toRect, kind) {
  const sc = { x: fromRect.left - base.left + fromRect.width / 2, y: fromRect.top - base.top + fromRect.height / 2 }
  const tc = { x: toRect.left - base.left + toRect.width / 2, y: toRect.top - base.top + toRect.height / 2 }
  const s = edgePoint(fromRect, base, tc.x, tc.y)
  const e = edgePoint(toRect, base, sc.x, sc.y)
  const k = Math.max(36, Math.abs(e.x - s.x) * 0.4)
  const c1 = s.horiz ? { x: s.x + s.dir * k, y: s.y } : { x: s.x, y: s.y + s.dir * k }
  const c2 = e.horiz ? { x: e.x + e.dir * k, y: e.y } : { x: e.x, y: e.y + e.dir * k }
  return { d: `M ${s.x} ${s.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${e.x} ${e.y}`, kind }
}

export function PickerApp() {
  const [nonce, setNonce] = useState(0)
  const state = useAsync(() => Promise.all([
    getJSON('/api/hub/contexts'),
    getJSON('/api/hub/workspaces'),
    getJSON('/api/hub/defaults'),
  ]), [nonce])
  const reload = () => setNonce((n) => n + 1)

  const [dialogBase, setDialogBase] = useState(null)
  const [actionErr, setActionErr] = useState('')
  const [filter, setFilter] = useState('all')
  const [hover, setHover] = useState(null) // { type: 'ctx'|'ws', id }
  const [arrows, setArrows] = useState([])
  const [wide, setWide] = useState(false)
  const mainRef = useRef(null)

  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY)
    const sync = () => setWide(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  const activeLogo = activeLogoId(filter)
  const header = html`
    <header class="picker-header">
      <div class="picker-logo">
        ${HEADER_LOGOS.map((l) => html`
          <img key=${l.id} class=${'picker-logo-img' + (l.id === activeLogo ? ' active' : '')}
               src=${l.src} alt="KBot Studio" draggable="false" />`)}
      </div>
      <p class="picker-sub">Pick a context to browse, or a workspace to edit. Each opens in its own tab.</p>
      <nav class="picker-tabs">
        ${TABS.map((t) => html`
          <button key=${t.id} class=${'picker-tab' + (filter === t.id ? ' active' : '')}
                  onClick=${() => setFilter(t.id)}>
            ${tabIcon(t.id)}<span>${t.label}</span>
          </button>`)}
      </nav>
    </header>`

  if (state.loading) {
    return html`<div class="picker">${header}<main class="picker-main"><${Loading} label="Loading…" /></main></div>`
  }
  if (state.error) {
    return html`<div class="picker">${header}<main class="picker-main"><${ErrorMsg} message=${state.error} /></main></div>`
  }

  const [ctxResp, wsResp, defaults] = state.data
  const allContexts = ctxResp.contexts || []
  const contexts = allContexts.filter((c) => gameMatches(filter, c.game))
  const workspaces = (wsResp.workspaces || []).filter((w) => gameMatches(filter, w.game))
  const workspaceRoot = (defaults && defaults.workspaceRoot) || ''

  // Relationship highlight (any width); arrows only when wide.
  const hCtx = hover && hover.type === 'ctx' ? allContexts.find((c) => c.alias === hover.id) : null
  const hWs = hover && hover.type === 'ws' ? workspaces.find((w) => w.path === hover.id) : null
  const linkedParent = hCtx ? hCtx.parent : null
  const linkedCtxFromWs = hWs ? hWs.base : null
  const linkedWs = new Set(hCtx ? workspaces.filter((w) => w.base === hCtx.alias).map((w) => w.path) : [])

  const computeArrows = (type, id) => {
    if (!wide) { setArrows([]); return }
    const root = mainRef.current
    if (!root) return
    const base = root.getBoundingClientRect()
    const sel = type === 'ctx' ? `[data-ctx="${attrEsc(id)}"]` : `[data-ws="${attrEsc(id)}"]`
    const src = root.querySelector(sel)
    if (!src) { setArrows([]); return }
    const sr = src.getBoundingClientRect()
    const out = []
    if (type === 'ctx') {
      const ctx = allContexts.find((c) => c.alias === id)
      if (ctx && ctx.parent) {
        const pe = root.querySelector(`[data-ctx="${attrEsc(ctx.parent)}"]`)
        if (pe) out.push(arrowPath(base, sr, pe.getBoundingClientRect(), 'parent'))
      }
      for (const w of workspaces) {
        if (w.base !== id) continue
        const we = root.querySelector(`[data-ws="${attrEsc(w.path)}"]`)
        if (we) out.push(arrowPath(base, sr, we.getBoundingClientRect(), 'workspace'))
      }
    } else {
      // Always draw context → workspace, even when the workspace is hovered.
      const w = workspaces.find((x) => x.path === id)
      if (w && w.base) {
        const ce = root.querySelector(`[data-ctx="${attrEsc(w.base)}"]`)
        if (ce) out.push(arrowPath(base, ce.getBoundingClientRect(), sr, 'workspace'))
      }
    }
    setArrows(out)
  }
  const enter = (type, id) => { setHover({ type, id }); computeArrows(type, id) }
  const leave = () => { setHover(null); setArrows([]) }

  const open = async (body) => {
    setActionErr('')
    try { await openInTab(body) } catch (e) { setActionErr(e.message || String(e)) }
  }
  const remove = async (w) => {
    const ok = await confirmDialog({
      title: 'Remove workspace?',
      message: `Remove “${w.name}” from this list? Your files on disk are kept.`,
      okLabel: 'Remove',
    })
    if (!ok) return
    setActionErr('')
    try { await post('/api/hub/forget', { dir: w.path }); reload() } catch (e) { setActionErr(e.message || String(e)) }
  }

  const workspacesCol = html`
    <section class="picker-col">
      <h2 class="picker-section">Mods & Workspaces</h2>
      ${workspaces.length === 0
        ? html`<p class="picker-empty">No workspaces here — create one from a context.</p>`
        : workspaces.map((w) => html`
          <div class=${'picker-card'
                + (hover && hover.type === 'ws' && w.path === hover.id ? ' is-hovered' : '')
                + (linkedWs.has(w.path) ? ' is-linked' : '')}
               key=${w.path} data-ws=${w.path}
               onMouseEnter=${() => enter('ws', w.path)} onMouseLeave=${leave}>
            <div class="picker-card-meta">
              <div class="picker-card-name">${w.name}</div>
              <div class="picker-card-tags">${w.game ? html`<${GameChip} game=${w.game} />` : null}</div>
              <div class="picker-card-sub">
                <${Tag}>base: ${w.base}<//><span class="picker-path">${w.path}</span>
              </div>
            </div>
            <button class="btn" onClick=${() => window.open('/api/hub/export?dir=' + encodeURIComponent(w.path), '_blank')}>Export mod</button>
            <button class="btn" onClick=${() => remove(w)}>Remove</button>
            <button class="btn primary" onClick=${() => open({ kind: 'workspace', dir: w.path })}>Open</button>
          </div>`)}
    </section>`

  const contextsCol = html`
    <section class="picker-col">
      <h2 class="picker-section">Base Data Contexts</h2>
      ${contexts.length === 0
        ? html`<p class="picker-empty">No contexts for this filter.</p>`
        : contexts.map((c) => html`
          <div class=${'picker-card'
                + (hover && hover.type === 'ctx' && c.alias === hover.id ? ' is-hovered' : '')
                + (c.alias === linkedParent || c.alias === linkedCtxFromWs ? ' is-linked' : '')}
               key=${c.alias} data-ctx=${c.alias}
               onMouseEnter=${() => enter('ctx', c.alias)} onMouseLeave=${leave}>
            <div class="picker-card-meta">
              <div class="picker-card-name">
                ${c.alias}${c.current ? html` <${Tag} tone="accent">Default Context<//>` : null}
              </div>
              <div class="picker-card-tags">
                <${GameChip} game=${c.game} />
                ${c.version ? html`<${Tag} tone="version">v${c.version}<//>` : null}
                ${c.parent ? html`<${Tag}>parent: ${c.parent}<//>` : null}
              </div>
            </div>
            <button class="btn" onClick=${() => open({ kind: 'context', alias: c.alias })}>Browse</button>
            <button class="btn primary" onClick=${() => setDialogBase(c.alias)}>New workspace…</button>
          </div>`)}
    </section>`

  return html`
    <div class="picker">
      ${header}
      <main class="picker-main" ref=${mainRef}>
        ${actionErr ? html`<${ErrorMsg} message=${actionErr} />` : null}
        ${wide && arrows.length > 0 ? html`
          <svg class="picker-arrows" aria-hidden="true">
            <defs>
              <marker id="pk-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
              </marker>
            </defs>
            ${arrows.map((a, i) => html`<path key=${i} class=${'picker-arrow picker-arrow-' + a.kind}
                                              d=${a.d} marker-end="url(#pk-arrow)" />`)}
          </svg>` : null}
        <div class="picker-cols">
          ${contextsCol}
          ${workspacesCol}
        </div>
      </main>

      <${NewWorkspaceDialog}
        open=${dialogBase !== null}
        base=${dialogBase}
        contexts=${allContexts}
        workspaceRoot=${workspaceRoot}
        onCancel=${() => setDialogBase(null)}
        onCreate=${async (body) => { setDialogBase(null); await open(body); reload() }}
      />
    </div>
  `
}
