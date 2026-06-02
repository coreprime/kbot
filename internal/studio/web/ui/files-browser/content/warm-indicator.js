// warm-indicator.js
//
// A small footer in the Files tree pane that reflects the background
// cache-warmer's progress.  It subscribes to the /api/vfs/events
// websocket (the same stream the warmer publishes to) and shows a
// progress bar while warming is in flight, then collapses to a "ready"
// line when the "done" event arrives.

import { htm as html } from '@kbot/ui/htm-bind'
import { useEffect, useState } from 'preact/hooks'

// eventsURL builds the ws:// (or wss://) URL for the warm event stream
// from the current page origin so it works behind any host/port.
function eventsURL() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/vfs/events`
}

export function WarmIndicator() {
  const [evt, setEvt] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let ws
    let closed = false
    try {
      ws = new WebSocket(eventsURL())
      ws.onmessage = (m) => {
        try { setEvt(JSON.parse(m.data)) } catch { /* ignore malformed frame */ }
      }
    } catch { /* websocket unavailable — indicator stays idle */ }
    return () => { closed = true; if (ws) try { ws.close() } catch { /* ignore */ } void closed }
  }, [])

  const done = !!evt && (evt.type === 'done' || evt.processed >= evt.total)

  // Once warming finishes, show the "ready" line briefly then retire the
  // indicator so it doesn't linger over the explorer.
  useEffect(() => {
    if (!done) return undefined
    const t = setTimeout(() => setDismissed(true), 4000)
    return () => clearTimeout(t)
  }, [done])

  if (!evt || evt.total === 0 || dismissed) return null

  const pct = evt.total ? Math.round((evt.processed / evt.total) * 100) : 0

  return html`
    <div class=${`files-warm ${done ? 'done' : 'active'}`}>
      ${done
        ? html`<span class="files-warm-label">✓ Cache ready (${evt.cached} rendered)</span>`
        : html`
            <span class="files-warm-label">Warming ${evt.processed}/${evt.total}</span>
            <div class="files-warm-bar"><div class="files-warm-fill" style=${`width:${pct}%`}></div></div>
          `}
    </div>
  `
}
