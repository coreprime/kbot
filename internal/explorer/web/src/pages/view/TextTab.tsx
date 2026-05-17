import type { ViewResult } from '../../api'
import BOSHighlighter from '../../components/BOSHighlighter'

export default function TextTab({ data }: { data: ViewResult }) {
  if (!data.textContent) {
    return <div className="empty-state">No text content available.</div>
  }

  // Use BOS syntax highlighting for .bos and .h files
  const fmt = (data.format || '').toLowerCase()
  if (fmt.includes('bos') || fmt.includes('header')) {
    return <BOSHighlighter code={data.textContent} />
  }

  return <pre className="code-block">{data.textContent}</pre>
}
