// search-box.js
//
// Debounced global search over every VFS path, with a keyboard-navigable
// results dropdown.  Mirrors the standalone explorer's search: ⌘K / Ctrl+K
// focuses it, ↑/↓ walk results, Enter opens the highlighted hit (folders
// open in Browse, files in the viewer), Esc dismisses.

import { htm as html } from '/ui/common/htm-bind.js'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { search } from '../api.js'
import { fileIcon } from './icons.js'

// highlight splits a name around the first case-insensitive match so the
// matched run can be emphasised in the dropdown.
function highlight(text, query) {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return text
  return html`${text.slice(0, idx)}<strong class="fx-search-hl">${text.slice(idx, idx + query.length)}</strong>${text.slice(idx + query.length)}`
}

export function SearchBox({ onOpenDir, onOpenFile, autoFocus }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState(-1)
  const [open, setOpen] = useState(false)
  const debounce = useRef(null)
  const inputRef = useRef(null)
  const boxRef = useRef(null)

  useEffect(() => { if (autoFocus && inputRef.current) inputRef.current.focus() }, [autoFocus])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const run = useCallback((q) => {
    if (q.length < 2) { setResults([]); setOpen(false); return }
    setBusy(true)
    search(q).then((r) => { setResults(r); setOpen(true); setSel(-1); setBusy(false) }).catch(() => setBusy(false))
  }, [])

  const onChange = useCallback((e) => {
    const v = e.target.value
    setQuery(v)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => run(v), 200)
  }, [run])

  const choose = useCallback((r) => {
    setOpen(false); setQuery('')
    inputRef.current?.blur()
    if (r.isDir) onOpenDir?.(r.path); else onOpenFile?.(r.path)
  }, [onOpenDir, onOpenFile])

  const onKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && sel >= 0 && sel < results.length) { e.preventDefault(); choose(results[sel]) }
    else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
  }, [results, sel, choose])

  return html`
    <div class="fx-search" ref=${boxRef}>
      <div class="fx-search-box">
        <span class="fx-search-ico">🔍</span>
        <input ref=${inputRef} type="text" class="fx-search-input"
               placeholder="Search files and folders… (Ctrl+K)"
               value=${query} onInput=${onChange} onKeyDown=${onKeyDown}
               onFocus=${() => results.length > 0 && setOpen(true)} />
        ${busy ? html`<span class="fx-search-spin">⏳</span>` : null}
      </div>
      ${open && results.length > 0 ? html`
        <div class="fx-search-results">
          ${results.map((r, i) => html`
            <button type="button" key=${r.path}
                    class=${'fx-search-result' + (i === sel ? ' active' : '')}
                    onMouseEnter=${() => setSel(i)} onClick=${() => choose(r)}>
              <span class="fx-search-result-ico">${r.isDir ? '📁' : fileIcon(r.name)}</span>
              <span class="fx-search-result-info">
                <span class="fx-search-result-name">${highlight(r.name, query)}</span>
                <span class="fx-search-result-path">${r.path}</span>
              </span>
            </button>
          `)}
          ${results.length >= 50 ? html`<div class="fx-search-more">Showing first 50 — refine your search</div>` : null}
        </div>
      ` : null}
      ${open && query.length >= 2 && results.length === 0 && !busy ? html`
        <div class="fx-search-results"><div class="fx-search-empty">No results for “${query}”</div></div>
      ` : null}
    </div>
  `
}
