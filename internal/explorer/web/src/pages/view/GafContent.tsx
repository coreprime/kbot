import { useState } from 'react'
import { apngURL, pngURL, type ViewResult, type GafSequence } from '../../api'
import BrokenPlaceholder from '../../components/BrokenAsset'
import { handleImgError } from '../../components/brokenAssetUtils'

export default function GafContent({ data, filePath }: { data: ViewResult; filePath: string }) {
  const sequences: GafSequence[] = data.gafSequences || []

  if (sequences.length === 0) {
    return (
      <div className="empty-state">
        <div className="icon">🎨</div>
        <p>No sequences found in this GAF file.</p>
      </div>
    )
  }

  return (
    <div>
      <p className="gaf-summary">
        {sequences.length} sequence{sequences.length !== 1 ? 's' : ''},{' '}
        {sequences.reduce((n, s) => n + (s.frames?.length || 0), 0)} total frames
      </p>

      {sequences.map((seq, i) => (
        <SequenceAccordion key={i} seq={seq} index={i} filePath={filePath} />
      ))}
    </div>
  )
}

function SequenceAccordion({
  seq,
  index,
  filePath,
}: {
  seq: GafSequence
  index: number
  filePath: string
}) {
  const [open, setOpen] = useState(false)
  const frameCount = seq.frames?.length || 0

  return (
    <div className="gaf-accordion">
      <div className="gaf-accordion-header" onClick={() => setOpen(!open)}>
        <span className="gaf-accordion-toggle">{open ? '▾' : '▸'}</span>
        <img
          src={apngURL(filePath, index)}
          alt={seq.name}
          className="gaf-accordion-thumb"
          loading="lazy"
          onError={handleImgError}
        />
        <BrokenPlaceholder label="⚠️" style={{ width: 48, height: 48, fontSize: 9, padding: 2 }} />
        <div className="gaf-accordion-info">
          <span className="gaf-accordion-name">{seq.name}</span>
          <span className="gaf-accordion-meta">
            {frameCount} frame{frameCount !== 1 ? 's' : ''}
            {seq.frames?.[0] && ` · ${seq.frames[0].width}×${seq.frames[0].height}`}
          </span>
        </div>
        <div className="gaf-accordion-actions" onClick={(e) => e.stopPropagation()}>
          <a
            href={seq.gifUrl || `/gif/${filePath.replace(/^\/+/, '')}/${index}`}
            download
            className="gaf-dl-btn"
            title="Download GIF"
          >
            ⬇ GIF
          </a>
          <a
            href={apngURL(filePath, index)}
            download
            className="gaf-dl-btn"
            title="Download APNG"
          >
            ⬇ APNG
          </a>
        </div>
      </div>

      {open && (
        <div className="gaf-accordion-body">
          {/* Animated preview */}
          <div className="gaf-seq-preview">
            <img src={apngURL(filePath, index)} alt={seq.name} onError={handleImgError} />
            <BrokenPlaceholder label="Failed to render sequence" style={{ width: 128, height: 80 }} />
          </div>

          {/* Frame table */}
          {seq.frames && seq.frames.length > 0 && (
            <div className="frame-table-wrap">
              <table className="frame-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Size</th>
                    <th>Origin</th>
                    <th>Transparency</th>
                    <th>Duration</th>
                    <th>Preview</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {seq.frames.map((frame) => (
                    <tr key={frame.index}>
                      <td>{frame.index}</td>
                      <td>{frame.width}×{frame.height}</td>
                      <td>{frame.originX}, {frame.originY}</td>
                      <td>{frame.transparency ?? frame.transparencyIndex ?? '—'}</td>
                      <td>{frame.duration}</td>
                      <td>
                        <div className="frame-thumb-wrap">
                          <img
                            src={pngURL(filePath, index, frame.index)}
                            alt={`Frame ${frame.index}`}
                            className="frame-thumb"
                            loading="lazy"
                            onError={handleImgError}
                          />
                          <BrokenPlaceholder style={{ width: 48, height: 48 }} />
                          <div className="frame-hover-preview">
                            <img
                              src={pngURL(filePath, index, frame.index)}
                              alt={`Frame ${frame.index} (expanded)`}
                            />
                            <div className="frame-hover-label">
                              {frame.width}×{frame.height} — Frame {frame.index}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <a
                          href={pngURL(filePath, index, frame.index)}
                          download={`${seq.name}_frame${frame.index}.png`}
                          className="frame-dl"
                          title="Download frame PNG"
                        >
                          ⬇
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
