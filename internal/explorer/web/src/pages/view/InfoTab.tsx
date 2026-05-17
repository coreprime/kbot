import { formatSize, type ViewResult } from '../../api'

export default function InfoTab({ data }: { data: ViewResult }) {
  return (
    <div className="info-grid">
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
  )
}
