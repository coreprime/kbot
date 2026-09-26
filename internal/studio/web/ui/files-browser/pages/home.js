// home.js
//
// The explorer dashboard: a hero with a prominent search + "Browse Files"
// action, a grid of headline statistics (archives, file/dir counts,
// packed vs unpacked size, compression), and a small facts panel.  All
// numbers come from the ?stats document in one request, as does the
// mount panel: the archives in lookup order and the archives the game
// would not mount, with the reason.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { getStats, formatSize } from '../api.js'
import { useAsync, Loading, ErrorMsg } from '@coreprime/kbot-ui/async'
import { discoveryText, mountRows, skippedRows } from '../mount-info.js'

function StatCard({ value, label, accent }) {
  return html`
    <div class=${'fx-stat-card' + (accent ? ' accent' : '')}>
      <div class="fx-stat-value">${value}</div>
      <div class="fx-stat-label">${label}</div>
    </div>
  `
}

export function HomePage({ onOpenDir }) {
  const { data: stats, loading, error } = useAsync(() => getStats(), [])

  if (loading) return html`<${Loading} label="Reading filesystem…" />`
  if (error) return html`<${ErrorMsg} message=${error} />`
  if (!stats) return null

  const num = (n) => Number(n || 0).toLocaleString()
  const ratio = typeof stats.compressionRatio === 'number' ? stats.compressionRatio : Number(stats.compressionRatio) || 0

  return html`
    <div class="fx-home">
      <section class="fx-hero">
        <h1>🗂 Game File Explorer</h1>
        <p>Browse the complete file-systems for Total Annihilation ${'&'} TA: Kingdoms, including any mod content — preview animations, maps, scripts, fonts, and more. Use the search box at the top right to jump to any file or folder.</p>
        <div class="fx-hero-actions">
          <button type="button" class="fx-btn-primary" onClick=${() => onOpenDir?.('')}>📁 Browse Files</button>
        </div>
      </section>

      <section class="fx-stat-grid">
        <${StatCard} value=${num(stats.archives)} label="Archives Loaded" accent=${true} />
        <${StatCard} value=${num(stats.totalFiles)} label="Total Files" />
        <${StatCard} value=${num(stats.archiveFiles)} label="Packed Files" />
        <${StatCard} value=${num(stats.physicalFiles)} label="Loose Files" />
        <${StatCard} value=${num(stats.directories)} label="Directories" />
        <${StatCard} value=${formatSize(stats.unpackedSize)} label="Unpacked Size" />
        <${StatCard} value=${formatSize(stats.packedSize)} label="Packed Size" />
        <${StatCard} value=${`${ratio.toFixed(1)}%`} label="Compression" accent=${true} />
      </section>

      <section class="fx-facts">
        <div class="fx-facts-row"><span class="fx-facts-key">Base Path</span><span class="fx-facts-val">${stats.basePath || '—'}</span></div>
        <div class="fx-facts-row"><span class="fx-facts-key">Archive Formats</span><span class="fx-facts-val">HPI · UFO · CCX · GP3</span></div>
        ${stats.discovery ? html`<div class="fx-facts-row"><span class="fx-facts-key">Archive Order</span><span class="fx-facts-val fx-facts-text">${discoveryText(stats.discovery)}</span></div>` : null}
      </section>

      <${MountPanel} stats=${stats} />
    </div>
  `
}

// MountPanel lists the mounted archives in lookup order and, when any were
// found but not mounted, those archives with the reason.
function MountPanel({ stats }) {
  const mounted = mountRows(stats)
  const skipped = skippedRows(stats)
  if (mounted.length === 0 && skipped.length === 0) return null
  return html`
    <section class="fx-facts fx-mount">
      ${skipped.length > 0 ? html`
        <details class="fx-mount-group" open>
          <summary>Not mounted by the game (${skipped.length})</summary>
          <ul class="fx-mount-list">
            ${skipped.map((s) => html`<li key=${s.name}><span class="fx-mount-name">${s.name}</span><span class="fx-mount-note">${s.reason}</span></li>`)}
          </ul>
        </details>` : null}
      <details class="fx-mount-group">
        <summary>Mount order (${mounted.length} archives, first wins)</summary>
        <ol class="fx-mount-list">
          ${mounted.map((m) => html`
            <li key=${m.position}>
              <span class="fx-mount-pos">${m.position}.</span>
              <span class="fx-mount-name">${m.name}</span>
              ${m.tag ? html`<span class="fx-mount-tag">${m.tag}</span>` : null}
              ${m.note ? html`<span class="fx-mount-note">${m.note}</span>` : null}
            </li>`)}
        </ol>
      </details>
    </section>
  `
}
