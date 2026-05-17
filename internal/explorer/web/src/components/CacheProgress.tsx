import { useState, useEffect, useCallback } from 'react'

interface CacheEvent {
  type: 'worker-start' | 'worker-done' | 'progress' | 'done'
  worker: number
  file: string
  fileType: string
  total: number
  processed: number
  cached: number
  skipped: number
  workers: number
}

interface WorkerState {
  file: string
  fileType: string
  status: 'working' | 'idle'
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export default function CacheProgress() {
  const [workers, setWorkers] = useState<Map<number, WorkerState>>(new Map())
  const [total, setTotal] = useState(0)
  const [processed, setProcessed] = useState(0)
  const [cached, setCached] = useState(0)
  const [visible, setVisible] = useState(false)
  const [done, setDone] = useState(false)
  const [confetti, setConfetti] = useState(false)
  const [connState, setConnState] = useState<ConnectionState>('connecting')

  useEffect(() => {
    let mounted = true
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryDelay = 1000
    let hadConnection = false
    let errorCount = 0

    function handleEvent(evt: CacheEvent) {
      if (!mounted) return

      if (evt.type === 'worker-start') {
        setVisible(true)
        setDone(false)
        setConfetti(false)
        setTotal(evt.total)
        setProcessed(evt.processed)
        setWorkers(prev => {
          const next = new Map(prev)
          next.set(evt.worker, { file: evt.file, fileType: evt.fileType, status: 'working' })
          return next
        })
      } else if (evt.type === 'worker-done') {
        setTotal(evt.total)
        setProcessed(evt.processed)
        setCached(evt.cached)
        setWorkers(prev => {
          const next = new Map(prev)
          next.set(evt.worker, { file: evt.file, fileType: evt.fileType, status: 'idle' })
          return next
        })
      } else if (evt.type === 'done') {
        setTotal(evt.total)
        setProcessed(evt.processed)
        setCached(evt.cached)
        setDone(true)
        setConfetti(true)
        setWorkers(new Map())
        setTimeout(() => {
          if (mounted) { setVisible(false); setConfetti(false) }
        }, 4000)
      }
    }

    function connect() {
      if (!mounted) return
      if (es) { es.close(); es = null }

      setConnState('connecting')
      es = new EventSource('/api/events')

      es.onopen = () => {
        if (!mounted) return
        retryDelay = 1000
        errorCount = 0
        hadConnection = true
        setConnState('connected')
        // Reset for fresh session on reconnect.
        setWorkers(new Map())
        setDone(false)
      }

      es.onmessage = (msg) => {
        if (!mounted) return
        errorCount = 0 // got data, connection is alive
        try { handleEvent(JSON.parse(msg.data)) } catch { /* ignore */ }
      }

      es.onerror = () => {
        errorCount++
        if (es) { es.close(); es = null }
        if (!mounted) return

        // Only show disconnected state if we previously had a connection
        // or we've failed multiple times (server genuinely down).
        if (hadConnection || errorCount >= 3) {
          setConnState('disconnected')
          setVisible(true)
          setDone(false)
        }

        const delay = retryDelay
        retryDelay = Math.min(delay * 2, 10000)
        retryTimer = setTimeout(connect, delay)
      }
    }

    connect()
    return () => {
      mounted = false
      if (es) { es.close() }
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  const dismiss = useCallback(() => {
    if (connState !== 'disconnected') {
      setVisible(false)
      setConfetti(false)
    }
  }, [connState])

  if (!visible) return null

  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  const activeWorkers = Array.from(workers.entries())
    .filter(([, w]) => w.status === 'working')
    .sort(([a], [b]) => a - b)

  if (connState === 'disconnected') {
    return (
      <div className="cache-progress cache-progress-disconnected">
        <div className="cache-progress-body">
          <div className="cache-progress-icon">
            <div className="cache-progress-spinner cache-progress-spinner-warn" />
          </div>
          <div className="cache-progress-text">
            <div className="cache-progress-title">Server disconnected</div>
            <div className="cache-progress-detail">Reconnecting…</div>
          </div>
        </div>
      </div>
    )
  }

  if (connState === 'connecting' && !done && activeWorkers.length === 0) {
    return null
  }

  return (
    <div className={`cache-progress ${done ? 'cache-progress-done' : ''}`}>
      {confetti && <ConfettiEffect />}
      {done ? (
        <div className="cache-progress-body" onClick={dismiss}>
          <div className="cache-progress-icon">✅</div>
          <div className="cache-progress-text">
            <div className="cache-progress-title">Cache warming complete</div>
            <div className="cache-progress-detail">{cached} files cached</div>
          </div>
        </div>
      ) : (
        <>
          <div className="cache-progress-header" onClick={dismiss}>
            <div className="cache-progress-title">
              Cache Warming — {pct}%
            </div>
            <div className="cache-progress-bar-track">
              <div className="cache-progress-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="cache-progress-stats">
              {processed}/{total}
            </div>
          </div>
          <div className="cache-progress-workers">
            {activeWorkers.map(([id, w]) => (
              <div key={id} className="cache-worker-row">
                <span className="cache-worker-id">W{id}</span>
                <span className="cache-worker-type">{w.fileType.toUpperCase()}</span>
                <span className="cache-worker-file">{w.file.split('/').pop()}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ConfettiEffect() {
  const [particles] = useState(() =>
    Array.from({ length: 30 }, (_, i) => ({
      key: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      hue: Math.random() * 360,
      size: 4 + Math.random() * 6,
    }))
  )

  return (
    <div className="confetti-container">
      {particles.map(p => (
        <div
          key={p.key}
          className="confetti-particle"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            backgroundColor: `hsl(${p.hue}, 80%, 60%)`,
            width: p.size,
            height: p.size,
          }}
        />
      ))}
    </div>
  )
}
