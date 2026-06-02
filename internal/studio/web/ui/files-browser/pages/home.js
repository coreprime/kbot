// home.js
//
// The explorer dashboard: a hero with a prominent search + "Browse Files"
// action, a grid of headline statistics (archives, file/dir counts,
// packed vs unpacked size, compression), and a small facts panel.  All
// numbers come from the ?stats document in one request.

import { htm as html } from '@kbot/ui/htm-bind'
import { getStats, formatSize } from '../api.js'
import { useAsync, Loading, ErrorMsg } from '@kbot/ui/async'

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
      </section>
    </div>
  `
}
