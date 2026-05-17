import { useState, useCallback } from 'react'
import type { ViewResult } from '../../api'
import BrokenPlaceholder from '../../components/BrokenAsset'
import { handleImgError } from '../../components/brokenAssetUtils'

interface GlyphInfo {
  char: number
  width: number
}

export default function FontContent({ data }: { data: ViewResult }) {
  const d = data as Record<string, unknown>
  const height = d.fntHeight as number | undefined
  const glyphCount = d.fntGlyphCount as number | undefined
  const sheetUrl = d.fntSheetUrl as string | undefined
  const previewUrl = d.fntPreviewUrl as string | undefined
  const glyphs = d.fntGlyphs as GlyphInfo[] | undefined
  const [previewText, setPreviewText] = useState('The quick brown fox jumps over the lazy dog. 0123456789')
  const [hoveredGlyph, setHoveredGlyph] = useState<GlyphInfo | null>(null)

  const onHover = useCallback((g: GlyphInfo) => setHoveredGlyph(g), [])
  const onLeave = useCallback(() => setHoveredGlyph(null), [])

  const scale = 3
  const previewSrc = previewUrl
    ? `${previewUrl}?text=${encodeURIComponent(previewText)}`
    : undefined

  // Compute sheet dimensions for proper sizing.
  const maxGlyphW = glyphs ? Math.max(...glyphs.map(g => g.width), 8) : 8
  const cellW = maxGlyphW + 2
  const cellH = (height || 10) + 2
  const sheetW = 16 * cellW
  const sheetH = 16 * cellH

  return (
    <div className="font-viewer">
      {/* Stats */}
      <div className="font-stats">
        {height != null && <span className="font-stat">Height: {height}px</span>}
        {glyphCount != null && <span className="font-stat">{glyphCount} glyphs</span>}
        {hoveredGlyph && (
          <span className="font-stat font-stat-hover">
            {hoveredGlyph.char >= 32 && hoveredGlyph.char < 127
              ? `'${String.fromCharCode(hoveredGlyph.char)}'`
              : `0x${hoveredGlyph.char.toString(16).padStart(2, '0').toUpperCase()}`
            }
            {' '}({hoveredGlyph.char}) — {hoveredGlyph.width}px wide
          </span>
        )}
      </div>

      {/* Text preview */}
      <div className="font-preview-section">
        <h3 className="section-heading">Preview</h3>
        <input
          type="text"
          className="font-preview-input"
          value={previewText}
          onChange={e => setPreviewText(e.target.value)}
          placeholder="Type to preview..."
        />
        {previewSrc && (
          <div className="font-preview-wrap">
            <img
              src={previewSrc}
              alt="Font preview"
              className="font-preview-img"
              style={{ height: (height || 10) * scale }}
              onError={handleImgError}
            />
            <BrokenPlaceholder label="Preview unavailable" style={{ width: 300, height: 40 }} />
          </div>
        )}
      </div>

      {/* Glyph sheet */}
      {sheetUrl && (
        <div className="font-sheet-section">
          <h3 className="section-heading">Glyph Sheet (16 × 16 grid)</h3>
          <div className="font-sheet-wrap">
            <img
              src={sheetUrl}
              alt="Glyph sheet"
              className="font-sheet-img"
              style={{ width: sheetW * scale, height: sheetH * scale }}
              onError={handleImgError}
            />
            <BrokenPlaceholder label="Sheet unavailable" style={{ width: 300, height: 300 }} />
          </div>
        </div>
      )}

      {/* Individual glyph grid */}
      {glyphs && glyphs.length > 0 && (
        <div className="font-glyphs-section">
          <h3 className="section-heading">Character Map</h3>
          <div className="font-glyph-grid">
            {glyphs.map(g => (
              <div
                key={g.char}
                className={`font-glyph-cell ${hoveredGlyph?.char === g.char ? 'active' : ''}`}
                onMouseEnter={() => onHover(g)}
                onMouseLeave={onLeave}
                title={`${g.char >= 32 && g.char < 127 ? String.fromCharCode(g.char) : '?'} (${g.char}) ${g.width}px`}
              >
                <span className="font-glyph-char">
                  {g.char >= 32 && g.char < 127 ? String.fromCharCode(g.char) : '·'}
                </span>
                <span className="font-glyph-code">{g.char}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
