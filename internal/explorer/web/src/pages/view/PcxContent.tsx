import { useState } from 'react'
import { pcxURL, type ViewResult } from '../../api'
import BrokenPlaceholder from '../../components/BrokenAsset'
import { handleImgError } from '../../components/brokenAssetUtils'

export default function PcxContent({ data, filePath }: { data: ViewResult; filePath: string }) {
  const [palette, setPalette] = useState<string | undefined>(undefined)
  const width = data.width ?? (data as Record<string, unknown>).Width as number | undefined
  const height = data.height ?? (data as Record<string, unknown>).Height as number | undefined
  const bpp = data.bitsPerPixel ?? (data as Record<string, unknown>).BitsPerPixel as number | undefined
  const colorType = data.colorType ?? (data as Record<string, unknown>).ColorType as string | undefined

  return (
    <div>
      {data.palettes && data.palettes.length > 0 && !data.hasEmbeddedPalette && (
        <div className="palette-selector">
          <label>Palette: </label>
          <select value={palette || ''} onChange={(e) => setPalette(e.target.value || undefined)}>
            <option value="">Default (TA)</option>
            {data.palettes.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      )}

      <div className="image-preview">
        <img src={pcxURL(filePath, palette)} alt={data.fileName} onError={handleImgError} />
        <BrokenPlaceholder label="Failed to decode PCX image" style={{ width: 200, height: 120 }} />
      </div>

      {(width || height || bpp || colorType) && (
        <div className="pcx-props card" style={{ marginTop: 16 }}>
          <div className="info-grid">
            {width != null && height != null && (
              <>
                <span className="label">Resolution</span>
                <span className="value">{width} × {height}</span>
              </>
            )}
            {bpp != null && (
              <>
                <span className="label">Bit Depth</span>
                <span className="value">{bpp}-bit</span>
              </>
            )}
            {colorType && (
              <>
                <span className="label">Color Type</span>
                <span className="value">{colorType}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
