import { rawURL, type ViewResult, type LintLineInfo } from '../../api'
import { isCOB, isGAF, isPCX, isVideo, isAI, isAudio, is3DO, isFont, isPalette, isColorTable, isSCT, isTNT, hasSections, isBOS, isImage, isHTML } from './helpers'
import GafContent from './GafContent'
import PcxContent from './PcxContent'
import VideoContent from './VideoContent'
import WavContent from './WavContent'
import TDOContent from './TDOContent'
import FontContent from './FontContent'
import PaletteContent from './PaletteContent'
import ColorTableContent from './ColorTableContent'
import { SCTTileMap } from './SCTContent'
import { TNTMapView } from './TNTContent'
import AIContent from './AIContent'
import CobContent from './CobContent'
import SectionsContent from './SectionsContent'
import ImageContent from './ImageContent'
import HtmlContent from './HtmlContent'
import BOSHighlighter from '../../components/BOSHighlighter'

export default function ContentTab({ data, filePath, lintLines, highlightLine }: {
  data: ViewResult; filePath: string;
  lintLines?: Map<number, LintLineInfo[]>; highlightLine?: number | null
}) {
  const fmt = (data.format || '').toLowerCase()

  if (isGAF(fmt)) return <GafContent data={data} filePath={filePath} />
  if (isPCX(fmt)) return <PcxContent data={data} filePath={filePath} />
  if (isImage(fmt)) return <ImageContent data={data} filePath={filePath} />
  if (isHTML(fmt)) return <HtmlContent data={data} filePath={filePath} />
  if (isVideo(fmt)) return <VideoContent data={data} filePath={filePath} />
  if (isAudio(fmt)) return <WavContent data={data} filePath={filePath} />
  if (is3DO(fmt)) return <TDOContent data={data} />
  if (isFont(fmt)) return <FontContent data={data} />
  if (isPalette(fmt)) return <PaletteContent data={data} />
  if (isColorTable(fmt)) return <ColorTableContent data={data} />
  if (isSCT(fmt)) return <SCTTileMap data={data} />
  if (isTNT(fmt)) return <TNTMapView data={data} />
  if (isAI(fmt) && data.aiPlans) return <AIContent data={data} />
  if (isCOB(fmt)) return <CobContent data={data} />
  if (hasSections(data)) return <SectionsContent sections={data.sections!} />

  if (data.isText && data.textContent) {
    if (isBOS(fmt)) {
      return <BOSHighlighter code={data.textContent} basePath={filePath} lintLines={lintLines} highlightLine={highlightLine} />
    }
    return <pre className="code-block">{data.textContent}</pre>
  }

  if (data.hexDump) {
    return <pre className="code-block hex-dump">{data.hexDump}</pre>
  }

  return (
    <div className="empty-state">
      <div className="icon">📭</div>
      <p>No preview available for this file format.</p>
      <p style={{ marginTop: 8 }}>
        <a href={rawURL(filePath)} download>Download the raw file</a>
      </p>
    </div>
  )
}
