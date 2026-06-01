// browser.js
//
// The Files tab's top-level component: a full-page VFS explorer modelled
// on the standalone `kbot mount` web UI.  It is a small single-screen
// app with three views — a stats dashboard (Home), a full-page directory
// browser (Browse), and a tabbed file viewer (View) — switched by local
// route state rather than the URL (the studio owns the address bar).
//
// Navigation flows downward through callbacks: a folder row in Browse
// calls onOpenDir, a file row calls onOpenFile, breadcrumbs and the Home
// button reset the route.  State is intentionally shallow (one object)
// so a back/forward stack can be layered on later without restructuring.

import { htm as html } from '/ui/common/htm-bind.js'
import { useCallback, useState } from 'preact/hooks'
import { WarmIndicator } from './content/warm-indicator.js'
import { SearchBox } from './components/search-box.js'
import { HomePage } from './pages/home.js'
import { BrowsePage } from './pages/browse.js'
import { ViewPage } from './pages/view.js'

export function FilesBrowser() {
  // route: { kind: 'home' | 'browse' | 'view', path, source }
  const [route, setRoute] = useState({ kind: 'home', path: '', source: '' })

  const goHome = useCallback(() => setRoute({ kind: 'home', path: '', source: '' }), [])
  const openDir = useCallback((path) => setRoute({ kind: 'browse', path: path || '', source: '' }), [])
  const openFile = useCallback((path, source) => setRoute({ kind: 'view', path, source: source || '' }), [])

  return html`
    <div class="fx" data-theme="dark">
      <header class="fx-header">
        <button type="button" class="fx-logo" onClick=${goHome} title="Dashboard">
          <span class="fx-logo-ico">🗂</span>
          <span class="fx-logo-text">File Explorer</span>
        </button>
        <nav class="fx-nav">
          <button type="button" class=${'fx-nav-link' + (route.kind === 'home' ? ' active' : '')}
                  onClick=${goHome}>Dashboard</button>
          <button type="button" class=${'fx-nav-link' + (route.kind !== 'home' ? ' active' : '')}
                  onClick=${() => openDir('')}>Browse</button>
        </nav>
        <div class="fx-header-right">
          <${SearchBox} onOpenDir=${openDir} onOpenFile=${openFile} />
        </div>
      </header>
      <main class="fx-content">
        ${route.kind === 'home'
          ? html`<${HomePage} onOpenDir=${openDir} onSearch=${openDir} />`
          : null}
        ${route.kind === 'browse'
          ? html`<${BrowsePage} dir=${route.path} onOpenDir=${openDir} onOpenFile=${openFile} key=${route.path} />`
          : null}
        ${route.kind === 'view'
          ? html`<${ViewPage} path=${route.path} source=${route.source}
                              onOpenDir=${openDir} onOpenFile=${openFile} key=${route.path + '|' + route.source} />`
          : null}
      </main>
      <${WarmIndicator} />
    </div>
  `
}
