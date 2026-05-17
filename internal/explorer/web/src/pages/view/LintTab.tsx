import { useState, useCallback, useMemo } from 'react'
import type { ViewResult } from '../../api'

interface LintDiag {
  rule: string
  severity: string
  script: string
  message: string
  line: number
}

interface Props {
  data: ViewResult
  onJumpToLine?: (line: number, tab: string) => void
}

export default function LintTab({ data, onJumpToLine }: Props) {
  const lintResults = (data as Record<string, unknown>).lintResults as LintDiag[] | undefined
  const lintError = (data as Record<string, unknown>).lintError as string | undefined
  const lintSummary = (data as Record<string, unknown>).lintSummary as Record<string, number> | undefined

  const [ruleFilter, setRuleFilter] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState<string | null>(null)

  const toggleRule = useCallback((rule: string) => {
    setRuleFilter(prev => prev === rule ? null : rule)
  }, [])

  const toggleSeverity = useCallback((sev: string) => {
    setSeverityFilter(prev => prev === sev ? null : sev)
  }, [])

  const filtered = useMemo(() => {
    if (!lintResults) return []
    return lintResults.filter(d => {
      if (ruleFilter && d.rule !== ruleFilter) return false
      if (severityFilter && d.severity !== severityFilter) return false
      return true
    })
  }, [lintResults, ruleFilter, severityFilter])

  if (lintError) {
    return (
      <div className="lint-error">
        <div className="lint-error-icon">⚠️</div>
        <div className="lint-error-message">{lintError}</div>
      </div>
    )
  }

  if (!lintResults) {
    return <div className="empty-state">No lint data available.</div>
  }

  if (lintResults.length === 0) {
    return (
      <div className="lint-clean">
        <div className="lint-clean-icon">✅</div>
        <div className="lint-clean-message">No issues found</div>
      </div>
    )
  }

  const errors = lintResults.filter(d => d.severity === 'error')
  const warnings = lintResults.filter(d => d.severity === 'warning')
  const infos = lintResults.filter(d => d.severity === 'info')

  const isCOB = ((data.format || '').toLowerCase()).includes('cob')
  const jumpTab = isCOB ? 'decompiled' : 'content'

  const handleRowClick = (d: LintDiag) => {
    if (d.line > 0 && onJumpToLine) {
      onJumpToLine(d.line, jumpTab)
    }
  }

  return (
    <div className="lint-tab">
      {/* Summary bar */}
      <div className="lint-summary">
        <span className="lint-total">
          {filtered.length === lintResults.length
            ? `${lintResults.length} issue${lintResults.length !== 1 ? 's' : ''}`
            : `${filtered.length} of ${lintResults.length} shown`
          }
        </span>
        <SeverityBadge label="error" icon="❌" count={errors.length} active={severityFilter === 'error'} onClick={toggleSeverity} />
        <SeverityBadge label="warning" icon="⚠️" count={warnings.length} active={severityFilter === 'warning'} onClick={toggleSeverity} />
        <SeverityBadge label="info" icon="ℹ️" count={infos.length} active={severityFilter === 'info'} onClick={toggleSeverity} />
        {(ruleFilter || severityFilter) && (
          <button className="lint-clear-filter" onClick={() => { setRuleFilter(null); setSeverityFilter(null) }}>
            ✕ Clear filters
          </button>
        )}
      </div>

      {/* Rule breakdown */}
      {lintSummary && Object.keys(lintSummary).length > 0 && (
        <div className="lint-rule-summary">
          {Object.entries(lintSummary)
            .sort(([, a], [, b]) => b - a)
            .map(([rule, count]) => (
              <span
                key={rule}
                className={`lint-rule-chip ${ruleFilter === rule ? 'active' : ''}`}
                onClick={() => toggleRule(rule)}
              >
                {rule} <strong>{count}</strong>
              </span>
            ))}
        </div>
      )}

      {/* Diagnostics table */}
      <div className="lint-table-wrap">
        <table className="lint-table">
          <thead>
            <tr>
              <th></th>
              <th>Rule</th>
              <th>Script</th>
              <th>Line</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d, i) => (
              <tr
                key={i}
                className={`lint-row lint-row-${d.severity}${d.line > 0 && onJumpToLine ? ' lint-row-clickable' : ''}`}
                onClick={() => handleRowClick(d)}
              >
                <td className="lint-severity">{severityIcon(d.severity)}</td>
                <td className="lint-rule">{d.rule}</td>
                <td className="lint-script">{d.script || '(file)'}</td>
                <td className="lint-line">{d.line > 0 ? d.line : '—'}</td>
                <td className="lint-message">{d.message}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="lint-no-match">No issues match the current filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SeverityBadge({ label, icon, count, active, onClick }: {
  label: string; icon: string; count: number; active: boolean; onClick: (s: string) => void
}) {
  if (count === 0) return null
  return (
    <span
      className={`lint-badge lint-badge-${label} ${active ? 'lint-badge-active' : ''}`}
      onClick={() => onClick(label)}
    >
      {icon} {count} {label}{count !== 1 ? 's' : ''}
    </span>
  )
}

function severityIcon(s: string): string {
  switch (s) {
    case 'error': return '❌'
    case 'warning': return '⚠️'
    case 'info': return 'ℹ️'
    default: return '•'
  }
}
