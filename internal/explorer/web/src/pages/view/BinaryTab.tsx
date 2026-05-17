import { rawURL, type ViewResult } from '../../api'

export default function BinaryTab({ data, filePath }: { data: ViewResult; filePath: string }) {
  if (data.hexDump) {
    return <pre className="code-block hex-dump">{data.hexDump}</pre>
  }

  return (
    <div className="empty-state">
      <p>No hex dump available.</p>
      <p style={{ marginTop: 8 }}>
        <a href={rawURL(filePath)} download>Download the raw file</a>
      </p>
    </div>
  )
}
