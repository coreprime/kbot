// quality-checker.js
//
// Pre-save Quality Checker dialog.  Posts the current map payload to
// /api/studio/quality-check, renders the per-check rows with a paced
// "running" → final-severity reveal, and resolves with either an
// array of fix ids the caller should apply during the actual save or
// `null` when the user cancels.
//
// Two modes:
//   - 'save'  (default): the pre-save flow.  Auto-closes on a clean
//             first check (so a passing map sails through without
//             user input); a green "Save" button is presented once
//             the user has manually fixed something, so they get to
//             confirm what they've fixed.
//   - 'audit': opened from the Advanced menu for a standalone
//             inspection.  No Save button at any time; the user
//             dismisses with Cancel (relabelled "Close") when done.
//
// The per-check + overall-window minimums (constants imported from
// /ui/map-editor/constants.js) keep the dialog from flashing-and-
// disappearing on a fast machine — a sub-second check still feels
// deliberate.
//
// activeMap().appliedFixes carries already-approved fix ids forward
// so future saves don't re-prompt for fixes the user OK'd on this
// map; persisting that set is handled here.

import { setStatus, activeMap } from '../../host-context.js'
import { confirmDialog } from '../../dialogs/confirm.js'
import { QUALITY_CHECK_MIN_MS, QUALITY_WINDOW_MIN_MS } from '../constants.js'

export async function runQualityChecker(payload, { mode = 'save' } = {}) {
  const dlg = document.querySelector('#quality-dialog')
  const list = document.querySelector('#quality-list')
  const subtitle = document.querySelector('#quality-subtitle')
  const cancelBtn = document.querySelector('#quality-cancel')
  const fixAllBtn = document.querySelector('#quality-fix-all')
  const saveAnywayBtn = document.querySelector('#quality-save-anyway')
  if (!dlg || !list) return [] // no dialog present — skip checks
  const isAudit = mode === 'audit'
  return new Promise((resolve) => {
    // Seed from any fixes the user has previously accepted on this
    // map — they shouldn't have to re-click Fix every save.
    const m = activeMap()
    const fixes = new Set(m?.appliedFixes ?? [])
    let latestIssues = []
    let busy = false
    // Tracks whether the user has clicked Fix / Fix All this session.
    // Drives the save-button state machine: a clean first check
    // auto-closes the dialog (no user effort needed); once the user
    // has fixed something, we hold the dialog open with a green
    // "Save" button so they get to confirm what they fixed.
    let userInteracted = false
    // performance.now() at the moment the dialog became visible.  The
    // overall window minimum (QUALITY_WINDOW_MIN_MS) is measured from
    // here so a sub-second check still feels deliberate.
    const windowStart = performance.now()
    cancelBtn.textContent = isAudit ? 'Close' : 'Cancel'

    const rowSpec = (issue, severity, message) => ({
      check: issue.check,
      label: issue.label,
      severity,
      message: message ?? issue.message ?? '',
      canAutoFix: issue.canAutoFix,
      fix: issue.fix,
    })

    // renderRows patches the existing row DOM in place rather than
    // rebuilding it.  Each call previously did list.replaceChildren()
    // + createElement per row, which made every row re-trigger the
    // quality-row-in fade animation on every progress tick — the
    // dialog visibly flickered as checks completed sequentially.  By
    // creating each row once and updating only the parts that
    // changed (severity class, status glyph, message text, optional
    // progress bar and Fix button), the entrance animation plays
    // exactly once per row and the running spinner's infinite
    // animation keeps its current frame between ticks.
    const statusGlyph = { ok: '✓', warning: '!', error: '✗', running: '' }
    function renderRows(rows) {
      const wanted = new Set(rows.map((r) => r.check))
      for (const el of Array.from(list.querySelectorAll('.quality-row'))) {
        if (!wanted.has(el.dataset.check)) el.remove()
      }
      const existing = new Map()
      for (const el of list.querySelectorAll('.quality-row')) {
        existing.set(el.dataset.check, el)
      }
      let prev = null
      for (const r of rows) {
        let row = existing.get(r.check)
        if (!row) {
          row = document.createElement('div')
          row.dataset.check = r.check
          const status = document.createElement('div')
          const body = document.createElement('div')
          row.append(status, body)
          if (prev && prev.nextSibling) list.insertBefore(row, prev.nextSibling)
          else if (prev) list.appendChild(row)
          else if (list.firstChild) list.insertBefore(row, list.firstChild)
          else list.appendChild(row)
        } else {
          const expected = prev ? prev.nextSibling : list.firstChild
          if (row !== expected) list.insertBefore(row, expected)
        }
        const targetClass = `quality-row severity-${r.severity}`
        if (row.className !== targetClass) row.className = targetClass
        const status = row.children[0]
        const wantStatusClass = 'quality-status'
        if (status.className !== wantStatusClass) status.className = wantStatusClass
        const glyph = statusGlyph[r.severity] ?? ''
        if (status.textContent !== glyph) status.textContent = glyph
        const body = row.children[1]
        if (body.className !== 'quality-body') body.className = 'quality-body'
        let label = body.querySelector('.quality-label')
        if (!label) {
          label = document.createElement('div')
          label.className = 'quality-label'
          body.appendChild(label)
        }
        if (label.textContent !== r.label) label.textContent = r.label
        let msg = body.querySelector('.quality-message')
        if (!msg) {
          msg = document.createElement('div')
          msg.className = 'quality-message'
          body.appendChild(msg)
        }
        if (msg.textContent !== r.message) msg.textContent = r.message
        let prog = body.querySelector('.quality-progress')
        if (r.severity === 'running') {
          if (!prog) {
            prog = document.createElement('div')
            prog.className = 'quality-progress'
            prog.appendChild(document.createElement('span'))
            body.appendChild(prog)
          }
        } else if (prog) {
          prog.remove()
        }
        let fixBtn = row.querySelector('.btn')
        const wantFix = r.severity !== 'ok' && r.severity !== 'running' && r.canAutoFix && r.fix
        if (wantFix) {
          if (!fixBtn) {
            fixBtn = document.createElement('button')
            fixBtn.className = 'btn primary'
            fixBtn.textContent = 'Fix'
            fixBtn.addEventListener('click', () => applyFixes([r.fix]))
            row.appendChild(fixBtn)
          }
          fixBtn.disabled = busy
        } else if (fixBtn) {
          fixBtn.remove()
        }
        prev = row
      }
    }

    function refreshFooter() {
      const fixableLeft = latestIssues.some(
        (i) => i.severity !== 'ok' && i.canAutoFix && i.fix && !fixes.has(i.fix),
      )
      const anyIssue = latestIssues.some((i) => i.severity !== 'ok')
      fixAllBtn.classList.toggle('hidden', !fixableLeft)
      fixAllBtn.disabled = busy || !fixableLeft
      // The save button doubles as both "Save anyway" (red, when
      // issues remain) and "Save" (green, when the user has fixed
      // everything and we're holding the dialog open for their final
      // click).  We only hide it for the initial-clean-check case —
      // there the dialog auto-closes and the user never needs it.
      // Audit mode (Advanced › Quality Check…) hides the button at
      // all times — there's no save to advance to.
      const showSave = !isAudit && (anyIssue || userInteracted)
      saveAnywayBtn.classList.toggle('hidden', !showSave)
      saveAnywayBtn.disabled = busy
      if (anyIssue) {
        saveAnywayBtn.textContent = 'Save anyway'
        saveAnywayBtn.classList.remove('ready')
        saveAnywayBtn.classList.add('danger')
        saveAnywayBtn.title = 'Save the map with the current issues unresolved'
      } else {
        saveAnywayBtn.textContent = 'Save'
        saveAnywayBtn.classList.remove('danger')
        saveAnywayBtn.classList.add('ready')
        saveAnywayBtn.title = 'All checks passed — write the map to disk'
      }
      cancelBtn.disabled = busy
    }

    async function runChecks() {
      busy = true
      refreshFooter()
      // Seed every known check as "running" so the user sees motion
      // immediately, then patch in real results on response.
      const placeholders = latestIssues.length
        ? latestIssues.map((i) => rowSpec(i, 'running', 'Re-checking…'))
        : [rowSpec({ check: 'dedupTiles', label: 'Deduplicate Tiles', canAutoFix: false, fix: '' }, 'running', 'Inspecting tile pool…')]
      renderRows(placeholders)
      subtitle.textContent = isAudit
        ? 'Running quality checks…'
        : 'Running pre-save checks…'
      const checkStart = performance.now()
      let data, fetchErr
      try {
        const resp = await fetch('/api/studio/quality-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, fixes: Array.from(fixes) }),
        })
        if (!resp.ok) {
          const text = await resp.text()
          fetchErr = new Error(text || `HTTP ${resp.status}`)
        } else {
          data = await resp.json()
        }
      } catch (err) {
        fetchErr = err
      }
      if (fetchErr) {
        // Even the error path respects the per-check minimum — the
        // single error row needs at least QUALITY_CHECK_MIN_MS of
        // visible "running" before we flip it to the error state.
        const elapsed = performance.now() - checkStart
        if (elapsed < QUALITY_CHECK_MIN_MS) {
          await new Promise((r) => setTimeout(r, QUALITY_CHECK_MIN_MS - elapsed))
        }
        latestIssues = []
        busy = false
        renderRows([{
          check: 'fetch',
          label: 'Quality Checker',
          severity: 'error',
          message: `Could not reach the kbot server: ${fetchErr.message}`,
          canAutoFix: false,
          fix: '',
        }])
        subtitle.textContent = 'Check failed.'
        refreshFooter()
        return
      }
      const results = Array.isArray(data.issues) ? data.issues : []
      // Sequentially reveal each result — each check spends at least
      // QUALITY_CHECK_MIN_MS in the "running" state before its row
      // transitions to its final colour.  Without this, the dialog
      // feels like a placebo on a fast machine.
      for (let i = 0; i < results.length; i++) {
        const targetMs = (i + 1) * QUALITY_CHECK_MIN_MS
        const wait = targetMs - (performance.now() - checkStart)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        const rows = results.map((iss, j) => {
          if (j <= i) return rowSpec(iss, iss.severity, iss.message)
          const ph = placeholders[j]
          return rowSpec(iss, 'running', ph?.message ?? 'Inspecting…')
        })
        renderRows(rows)
      }
      latestIssues = results
      // Clear busy *before* the final renderRows so per-row Fix
      // buttons are interactive (button.disabled is sampled at
      // row-creation time, not via refreshFooter).
      busy = false
      renderRows(results.map((i) => rowSpec(i, i.severity, i.message)))
      refreshFooter()
      const total = results.length
      const passed = results.filter((i) => i.severity === 'ok').length
      const summary = `${passed} of ${total} checks passed`
      if (data.allOk) {
        if (!userInteracted && !isAudit) {
          // Clean first check on the save path — sail through, but
          // wait for the overall window minimum so the dialog stays
          // visible long enough to register.
          subtitle.textContent = `${summary} — saving…`
          const elapsed = performance.now() - windowStart
          const wait = Math.max(0, QUALITY_WINDOW_MIN_MS - elapsed)
          setTimeout(() => finish(Array.from(fixes)), wait)
          return
        }
        // Hold the dialog open — either the user fixed something
        // (save mode: green Save) or this is an audit (Close button).
        subtitle.textContent = isAudit
          ? `${summary}.`
          : `${summary} — click Save to write the map.`
        return
      }
      subtitle.textContent = isAudit
        ? `${summary} — review the warnings below.`
        : `${summary} — review before saving.`
    }

    async function applyFixes(ids) {
      userInteracted = true
      for (const id of ids) {
        fixes.add(id)
        // Persist into the active map so future saves don't re-prompt
        // for fixes the user has already approved.
        if (m) m.appliedFixes.add(id)
      }
      await runChecks()
    }

    function finish(result) {
      dlg.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onDocKey, true)
      cancelBtn.removeEventListener('click', onCancel)
      fixAllBtn.removeEventListener('click', onFixAll)
      saveAnywayBtn.removeEventListener('click', onSaveAnyway)
      dlg.classList.add('hidden')
      resolve(result)
    }

    function onCancel() {
      if (busy) return
      setStatus(isAudit ? 'Quality check closed.' : 'Save cancelled.')
      finish(null)
    }

    async function onFixAll() {
      if (busy) return
      const ids = latestIssues
        .filter((i) => i.severity !== 'ok' && i.canAutoFix && i.fix && !fixes.has(i.fix))
        .map((i) => i.fix)
      if (ids.length === 0) return
      await applyFixes(ids)
    }

    async function onSaveAnyway() {
      if (busy) return
      const anyIssue = latestIssues.some((i) => i.severity !== 'ok')
      // Green-Save path (no remaining issues) — skip the confirm
      // prompt since there's nothing dangerous to confirm.  The red
      // Save-anyway path still gates the save behind the
      // confirmation.
      if (!anyIssue) {
        finish(Array.from(fixes))
        return
      }
      const ok = await confirmDialog({
        title: 'Save with unresolved issues?',
        message: 'There are issues with this map. The TNT will still be written, but the unresolved warnings remain in the saved file.',
        okLabel: 'Save anyway',
        okDanger: true,
      })
      if (!ok) return
      finish(Array.from(fixes))
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
    }
    // The Escape global handler closes the OTA / Resize / Settings
    // dialogs — wire the same convention here.  Using capture so we
    // beat the global handler's `closest('input')` guard.
    function onDocKey(e) {
      if (dlg.classList.contains('hidden')) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); onCancel()
      }
    }

    cancelBtn.addEventListener('click', onCancel)
    fixAllBtn.addEventListener('click', onFixAll)
    saveAnywayBtn.addEventListener('click', onSaveAnyway)
    dlg.addEventListener('keydown', onKey)
    document.addEventListener('keydown', onDocKey, true)
    dlg.classList.remove('hidden')
    runChecks()
  })
}
