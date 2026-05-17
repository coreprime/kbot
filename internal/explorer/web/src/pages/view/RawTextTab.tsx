import { useState, useCallback } from 'react'
import type { ViewResult } from '../../api'

export default function RawTextTab({ data }: { data: ViewResult }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (!data.textContent) return
    navigator.clipboard.writeText(data.textContent).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [data.textContent])

  if (!data.textContent) {
    return <div className="empty-state">No text content available.</div>
  }

  return (
    <div className="raw-text-tab">
      <button className="copy-btn" onClick={handleCopy} title="Copy to clipboard">
        {copied ? '✓ Copied' : '📋 Copy'}
      </button>
      <pre className="code-block">{data.textContent}</pre>
    </div>
  )
}
