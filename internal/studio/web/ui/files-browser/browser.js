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
import { useCallback, useEffect, useState } from 'preact/hooks'
import { WarmIndicator } from './content/warm-indicator.js'
import { SearchBox } from './components/search-box.js'
import { Breadcrumbs } from './components/breadcrumbs.js'
import { HomePage } from './pages/home.js'
import { BrowsePage } from './pages/browse.js'
import { ViewPage } from './pages/view.js'
import { parentDir, baseName } from './api.js'
import { setFilesTabTitle } from './tab.js'

// routeTitle derives the strip label shown on the Files tab from the
// current route: the file/folder name when navigated, "Files" at home.
function routeTitle(route) {
  if (route.kind === 'home') return 'Files'
  const name = baseName(route.path)
  return name || 'Files'
}

// crumbsFromPath turns a VFS path into accumulating breadcrumb segments
// ([{name, path}]), always rooted at "" so the first crumb is the root.
function crumbsFromPath(path) {
  const parts = String(path || '').split('/').filter(Boolean)
  const crumbs = [{ name: 'Root', path: '' }]
  let acc = ''
  for (const p of parts) { acc = acc ? `${acc}/${p}` : p; crumbs.push({ name: p, path: acc }) }
  return crumbs
}

export function FilesBrowser() {
  // route: { kind: 'home' | 'browse' | 'view', path, source }
  const [route, setRoute] = useState({ kind: 'home', path: '', source: '' })

  const goHome = useCallback(() => setRoute({ kind: 'home', path: '', source: '' }), [])
  const openDir = useCallback((path) => setRoute({ kind: 'browse', path: path || '', source: '' }), [])
  const openFile = useCallback((path, source) => setRoute({ kind: 'view', path, source: source || '' }), [])

  // Mirror the current location onto the host tab's strip label.
  useEffect(() => { setFilesTabTitle(routeTitle(route)) }, [route])

  return html`
    <div class="fx" data-theme="dark">
      <header class="fx-header">
        <div class="fx-header-crumbs">
          ${route.kind === 'home'
            ? html`<nav class="fx-crumbs"><span class="fx-crumb current">File System</span></nav>`
            : route.kind === 'browse'
              ? html`<${Breadcrumbs} crumbs=${crumbsFromPath(route.path)} onOpenDir=${openDir} onGoHome=${goHome} />`
              : html`<${Breadcrumbs} crumbs=${crumbsFromPath(parentDir(route.path))} trailing=${baseName(route.path)} onOpenDir=${openDir} onGoHome=${goHome} />`}
        </div>
        <div class="fx-header-right">
          <${SearchBox} onOpenDir=${openDir} onOpenFile=${openFile} autoFocus=${true} />
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
