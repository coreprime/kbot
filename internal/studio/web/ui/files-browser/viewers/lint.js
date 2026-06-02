// lint.js
//
// The Lint tab for COB/BOS scripts: a severity summary with clickable
// filter badges, a per-rule breakdown, and a diagnostics table whose
// rows jump to the offending source line in the code view.

import { htm as html } from '@kbot/ui/htm-bind'
import { useState, useCallback, useMemo } from 'preact/hooks'

function severityIcon(s) {
  switch (s) { case 'error': return '❌'; case 'warning': return '⚠️'; case 'info': return 'ℹ️'; default: return '•' }
}

function SeverityBadge({ label, icon, count, active, onClick }) {
  if (count === 0) return null
  return html`
    <span class=${`fx-lint-badge fx-lint-badge-${label}` + (active ? ' active' : '')} onClick=${() => onClick(label)}>
      ${icon} ${count} ${label}${count !== 1 ? 's' : ''}
    </span>`
}

export function LintTab({ describe, format, onJumpToLine }) {
  const lintResults = describe.lintResults
  const lintError = describe.lintError
  const lintSummary = describe.lintSummary
  const [ruleFilter, setRuleFilter] = useState(null)
  const [severityFilter, setSeverityFilter] = useState(null)

  const toggleRule = useCallback((rule) => setRuleFilter((p) => (p === rule ? null : rule)), [])
  const toggleSeverity = useCallback((sev) => setSeverityFilter((p) => (p === sev ? null : sev)), [])

  const filtered = useMemo(() => {
    if (!lintResults) return []
    return lintResults.filter((d) => {
      if (ruleFilter && d.rule !== ruleFilter) return false
      if (severityFilter && d.severity !== severityFilter) return false
      return true
    })
  }, [lintResults, ruleFilter, severityFilter])

  if (lintError) return html`<div class="fx-lint-error"><div class="fx-lint-error-ico">⚠️</div><div>${lintError}</div></div>`
  if (!lintResults) return html`<div class="fx-empty">No lint data available.</div>`
  if (lintResults.length === 0) return html`<div class="fx-lint-clean"><div class="fx-lint-clean-ico">✅</div><div>No issues found</div></div>`

  const errors = lintResults.filter((d) => d.severity === 'error')
  const warnings = lintResults.filter((d) => d.severity === 'warning')
  const infos = lintResults.filter((d) => d.severity === 'info')
  const jumpTab = (format || '').toLowerCase().includes('cob') ? 'decompiled' : 'content'

  const handleRowClick = (d) => { if (d.line > 0 && onJumpToLine) onJumpToLine(d.line, jumpTab) }

  return html`
    <div class="fx-lint">
      <div class="fx-lint-summary">
        <span class="fx-lint-total">
          ${filtered.length === lintResults.length
            ? `${lintResults.length} issue${lintResults.length !== 1 ? 's' : ''}`
            : `${filtered.length} of ${lintResults.length} shown`}
        </span>
        <${SeverityBadge} label="error" icon="❌" count=${errors.length} active=${severityFilter === 'error'} onClick=${toggleSeverity} />
        <${SeverityBadge} label="warning" icon="⚠️" count=${warnings.length} active=${severityFilter === 'warning'} onClick=${toggleSeverity} />
        <${SeverityBadge} label="info" icon="ℹ️" count=${infos.length} active=${severityFilter === 'info'} onClick=${toggleSeverity} />
        ${(ruleFilter || severityFilter)
          ? html`<button type="button" class="fx-lint-clear" onClick=${() => { setRuleFilter(null); setSeverityFilter(null) }}>✕ Clear filters</button>`
          : null}
      </div>
      ${lintSummary && Object.keys(lintSummary).length
        ? html`<div class="fx-lint-rules">
            ${Object.entries(lintSummary).sort((a, b) => b[1] - a[1]).map(([rule, count]) => html`
              <span key=${rule} class=${'fx-lint-rule-chip' + (ruleFilter === rule ? ' active' : '')} onClick=${() => toggleRule(rule)}>${rule} <strong>${count}</strong></span>`)}
          </div>` : null}
      <div class="fx-lint-table-wrap">
        <table class="fx-lint-table">
          <thead><tr><th></th><th>Rule</th><th>Script</th><th>Line</th><th>Message</th></tr></thead>
          <tbody>
            ${filtered.map((d, i) => html`
              <tr key=${i} class=${`fx-lint-row fx-lint-row-${d.severity}` + (d.line > 0 && onJumpToLine ? ' clickable' : '')} onClick=${() => handleRowClick(d)}>
                <td class="fx-lint-sev">${severityIcon(d.severity)}</td>
                <td class="fx-lint-rule">${d.rule}</td>
                <td class="fx-lint-script">${d.script || '(file)'}</td>
                <td class="fx-lint-line">${d.line > 0 ? d.line : '—'}</td>
                <td class="fx-lint-msg">${d.message}</td>
              </tr>`)}
            ${filtered.length === 0 ? html`<tr><td colspan="5" class="fx-lint-nomatch">No issues match the current filter.</td></tr>` : null}
          </tbody>
        </table>
      </div>
    </div>
  `
}
