import type { ViewResult, LintLineInfo } from '../../api'
import BOSHighlighter from '../../components/BOSHighlighter'
import COBAHighlighter from '../../components/COBAHighlighter'

export default function CobContent({ data }: { data: ViewResult }) {
  const version = data.cobVersion ?? (data as Record<string, unknown>).version
  const scriptCount = data.cobScriptCount ?? (data as Record<string, unknown>).scriptCount
  const pieceCount = data.cobPieceCount ?? (data as Record<string, unknown>).pieceCount
  const codeLength = data.cobCodeLength ?? (data as Record<string, unknown>).codeLength
  const staticVars = data.cobStaticVarCount ?? (data as Record<string, unknown>).staticVarCount
  const pieceNames = data.cobPieceNames ?? (data as Record<string, unknown>).pieceNames as string[] | undefined
  const scriptNames = data.cobScriptNames ?? (data as Record<string, unknown>).scriptNames as string[] | undefined

  return (
    <div>
      <div className="cob-stats-grid">
        {version != null && <StatCard value={String(version)} label="Version" />}
        {scriptCount != null && <StatCard value={String(scriptCount)} label="Scripts" />}
        {pieceCount != null && <StatCard value={String(pieceCount)} label="Pieces" />}
        {codeLength != null && <StatCard value={Number(codeLength).toLocaleString()} label="Code Length" />}
        {staticVars != null && <StatCard value={String(staticVars)} label="Static Vars" />}
      </div>

      {pieceNames && pieceNames.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="section-heading">Pieces ({pieceNames.length})</h3>
          <div className="name-chips">
            {pieceNames.slice(0, 30).map((name, i) => (
              <span key={i} className="name-chip">[{i}] {name}</span>
            ))}
            {pieceNames.length > 30 && (
              <span className="name-chip muted">…and {pieceNames.length - 30} more</span>
            )}
          </div>
        </div>
      )}

      {scriptNames && scriptNames.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="section-heading">Scripts ({scriptNames.filter(n => n).length})</h3>
          <div className="name-chips">
            {scriptNames.filter(n => n).slice(0, 30).map((name, i) => (
              <span key={i} className="name-chip">[{i}] {name}</span>
            ))}
            {scriptNames.filter(n => n).length > 30 && (
              <span className="name-chip muted">…and {scriptNames.filter(n => n).length - 30} more</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="cob-stat-card">
      <div className="cob-stat-value">{value}</div>
      <div className="cob-stat-label">{label}</div>
    </div>
  )
}

export function DecompiledTab({ data, lintLines, highlightLine }: {
  data: ViewResult; lintLines?: Map<number, LintLineInfo[]>; highlightLine?: number | null
}) {
  if (!data.decompiled) return <div className="empty-state">No decompiled source available.</div>
  return <BOSHighlighter code={data.decompiled} lintLines={lintLines} highlightLine={highlightLine} />
}

export function DisassemblyTab({ data }: { data: ViewResult }) {
  if (!data.disassembly) return <div className="empty-state">No disassembly available.</div>
  return <COBAHighlighter code={data.disassembly} />
}
