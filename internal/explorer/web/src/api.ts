// API client for KBot Explorer backend

export interface Stats {
  basePath: string
  archives: number
  totalFiles: number
  directories: number
  unpackedSize: number
  packedSize: number
  compressionRatio: number
}

export interface Breadcrumb {
  name: string
  path: string
}

export interface BrowseEntry {
  name: string
  path: string
  isDir: boolean
  size: string        // API returns human-readable string like "4.6 KB"
  dirFiles: number
  dirFolders: number
  dirSize: string     // API returns human-readable string
}

export interface BrowseResult {
  path: string
  dirName: string
  breadcrumbs: Breadcrumb[]
  entries: BrowseEntry[]
  fileCount: number
  subdirCount: number
  totalSize: string   // API returns human-readable string
}

export interface GafFrame {
  index: number
  width: number
  height: number
  originX: number
  originY: number
  transparency: number
  transparencyIndex: number
  duration: string
}

export interface GafSequence {
  index: number
  name: string
  pngUrl: string
  apngUrl: string
  gifUrl: string
  frames: GafFrame[]
}

export interface AIPlanWeight {
  UnitName: string
  Weight: number
}

export interface AIPlanLimit {
  UnitName: string
  Maximum: number
}

export interface AIPlan {
  Name: string
  Weights: AIPlanWeight[]
  Limits: AIPlanLimit[]
}

export interface SectionField {
  key: string
  value: string
}

export interface Section {
  name: string
  fields: SectionField[]
  children: Section[]
}

export interface DescribeResult {
  path: string
  size: string
  source: string
  format: string
  sections?: Section[]
  // GAF
  GAFSequences?: GafSequence[]
  // COB
  Version?: string
  ScriptCount?: number
  PieceCount?: number
  CodeLength?: number
  StaticVarCount?: number
  PieceNames?: string[]
  ScriptNames?: string[]
  // BOS
  Lines?: number
  CodeLines?: number
  CommentLines?: number
  Content?: string
  // PCX
  PCXUrl?: string
  Width?: number
  Height?: number
  BitsPerPixel?: number
  ColorType?: string
  [key: string]: unknown
}

export interface ViewLayer {
  // API may return PascalCase (Go default) or camelCase
  source?: string
  Source?: string
  size?: number
  Size?: number
  priority?: number
  Priority?: number
}

export interface ViewResult {
  fileName: string
  filePath: string
  size: number
  source: string
  breadcrumbs: Breadcrumb[]
  layers: ViewLayer[]
  format: string
  isText: boolean
  textContent: string
  hexDump: string
  hasContent: boolean
  // GAF
  gafSequences?: GafSequence[]
  // COB
  decompiled?: string
  disassembly?: string
  webDisassembly?: string
  cobVersion?: string
  cobScriptCount?: number
  cobPieceCount?: number
  cobCodeLength?: number
  cobStaticVarCount?: number
  cobPieceNames?: string[]
  cobScriptNames?: string[]
  // PCX
  width?: number
  height?: number
  bitsPerPixel?: number
  colorType?: string
  palettes?: string[]
  hasEmbeddedPalette?: boolean
  // Video
  videoWidth?: number
  videoHeight?: number
  videoFrames?: number
  videoFPS?: number
  videoDuration?: number
  // AI
  aiPlans?: AIPlan[]
  // TDF/FBI sections
  sections?: Section[]
  // Native browser-renderable image (.png/.jpg/.gif/...)
  imageUrl?: string
  // HTML doc served through the rewriting view handler
  htmlUrl?: string
  [key: string]: unknown
}

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export function getStats(): Promise<Stats> {
  return fetchJSON<Stats>('/api/stats')
}

export function browse(path: string): Promise<BrowseResult> {
  const clean = path.replace(/^\/+/, '')
  return fetchJSON<BrowseResult>(`/api/browse/${clean}`)
}

export function describe(path: string): Promise<DescribeResult> {
  const clean = path.replace(/^\/+/, '')
  return fetchJSON<DescribeResult>(`/api/describe/${clean}`)
}

export function view(path: string, source?: string): Promise<ViewResult> {
  const clean = path.replace(/^\/+/, '')
  const qs = source ? `?source=${encodeURIComponent(source)}` : ''
  return fetchJSON<ViewResult>(`/api/view/${clean}${qs}`)
}

export function rawURL(path: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/raw/${clean}`
}

export function gifURL(path: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/gif/${clean}`
}

function gafQuery(palette?: string, transparency?: string): string {
  const parts: string[] = []
  if (palette) parts.push(`palette=${encodeURIComponent(palette)}`)
  if (transparency) parts.push(`transparency=${encodeURIComponent(transparency)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export function pngURL(path: string, seq: number | string, frame?: number | string, palette?: string, transparency?: string): string {
  const clean = path.replace(/^\/+/, '')
  const base = frame !== undefined ? `/png/${clean}/${seq}/${frame}` : `/png/${clean}/${seq}`
  return base + gafQuery(palette, transparency)
}

export function apngURL(path: string, seq: number | string, palette?: string, transparency?: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/apng/${clean}/${seq}` + gafQuery(palette, transparency)
}

export function gifSeqURL(path: string, seq: number | string, palette?: string, transparency?: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/gif/${clean}/${seq}` + gafQuery(palette, transparency)
}

export interface PaletteCandidate {
  path: string
  label: string
  source: string
}

export async function fetchGAFPalettes(gafPath: string): Promise<PaletteCandidate[]> {
  const clean = gafPath.replace(/^\/+/, '')
  const res = await fetch(`/api/gaf-palettes/${clean}`)
  if (!res.ok) return []
  const body = await res.json() as { candidates?: PaletteCandidate[] }
  return body.candidates ?? []
}

export function pcxURL(path: string, palette?: string): string {
  const clean = path.replace(/^\/+/, '')
  if (palette) {
    return `/pcx/${clean}?palette=${encodeURIComponent(palette)}`
  }
  return `/pcx/${clean}`
}

export function videoURL(path: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/video/${clean}`
}

export function zrbThumbURL(path: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/zrb-thumb/${clean}`
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function tntMinimapURL(path: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/tnt-minimap/${clean}`
}

export function sctMinimapURL(path: string): string {
  const clean = path.replace(/^\/+/, '')
  return `/sct-minimap/${clean}`
}

export interface SearchResult {
  name: string
  path: string
  isDir: boolean
}

export async function search(query: string): Promise<SearchResult[]> {
  const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
  const data = await resp.json()
  return data.results || []
}

/** Lint diagnostic info attached to a source line. */
export interface LintLineInfo {
  rule: string
  severity: string
  message: string
}

/** Get the parent directory path from a file path */
export function parentDir(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}
