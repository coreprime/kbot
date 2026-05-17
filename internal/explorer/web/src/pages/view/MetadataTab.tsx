import { formatSize, type ViewResult } from '../../api'
import { useAsync } from '../../hooks'
import { Loading, ErrorMsg } from '../../components/Loading'
import MetadataTree from '../../components/MetadataTree'

export default function MetadataTab({ data, filePath }: { data: ViewResult; filePath: string }) {
  const { data: describeData, loading, error } = useAsync(async () => {
    const res = await fetch(`/api/describe/${filePath.replace(/^\/+/, '')}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json()
  }, [filePath])

  return (
    <div>
      {/* File info section */}
      <h3 className="section-heading">File Information</h3>
      <div className="info-grid" style={{ marginBottom: 24 }}>
        <span className="label">File Name</span>
        <span className="value">{data.fileName}</span>
        <span className="label">Path</span>
        <span className="value">{data.filePath}</span>
        <span className="label">Size</span>
        <span className="value">{formatSize(data.size)} ({data.size.toLocaleString()} bytes)</span>
        <span className="label">Format</span>
        <span className="value">{data.format || 'Unknown'}</span>
        <span className="label">Source</span>
        <span className="value">{data.source}</span>
        {data.layers && (
          <>
            <span className="label">Layers</span>
            <span className="value">{data.layers.length} source(s)</span>
          </>
        )}
      </div>

      {/* Parsed metadata */}
      <h3 className="section-heading">Parsed Metadata</h3>
      {loading && <Loading />}
      {error && <ErrorMsg message={error} />}
      {describeData && <MetadataTree data={describeData} defaultOpen={true} />}
    </div>
  )
}
