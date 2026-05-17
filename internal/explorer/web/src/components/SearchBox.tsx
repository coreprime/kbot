import { useState, useCallback, useRef, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { search, type SearchResult } from '../api'

interface Props {
  /** Auto-focus the input on mount. */
  autoFocus?: boolean
  /** Compact mode for the header bar. */
  compact?: boolean
  /** Placeholder override. */
  placeholder?: string
}

export default function SearchBox({ autoFocus, compact, placeholder }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [showResults, setShowResults] = useState(false)
  const navigate = useNavigate()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Expose the input ref for external focus.
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoFocus])

  // Global hotkey: Ctrl+K or Cmd+K to focus.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    if (compact) {
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }
  }, [compact])

  const doSearch = useCallback((q: string) => {
    if (q.length < 2) {
      setResults([])
      setShowResults(false)
      return
    }
    setSearching(true)
    search(q).then(r => {
      setResults(r)
      setShowResults(true)
      setSelectedIdx(-1)
      setSearching(false)
    }).catch(() => setSearching(false))
  }, [])

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(v), 200)
  }, [doSearch])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && selectedIdx >= 0 && selectedIdx < results.length) {
      e.preventDefault()
      const r = results[selectedIdx]
      navigate(r.isDir ? `/browse/${r.path}` : `/view/${r.path}`)
      setShowResults(false)
      setQuery('')
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      setShowResults(false)
      inputRef.current?.blur()
    }
  }, [results, selectedIdx, navigate])

  // Close results when clicking outside.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
  const hotkey = isMac ? '⌘K' : 'Ctrl+K'
  const defaultPlaceholder = compact ? `Search... (${hotkey})` : 'Search files and folders...'

  return (
    <div ref={containerRef} className={`search-container ${compact ? 'search-compact' : ''}`}>
      <div className="search-box">
        <span className="search-icon">🔍</span>
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder={placeholder || defaultPlaceholder}
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setShowResults(true)}
        />
        {searching && <span className="search-spinner">⏳</span>}
        {compact && !searching && <span className="search-hotkey">{hotkey}</span>}
      </div>

      {showResults && results.length > 0 && (
        <div className="search-results">
          {results.map((r, i) => (
            <Link
              key={r.path}
              to={r.isDir ? `/browse/${r.path}` : `/view/${r.path}`}
              className={`search-result ${i === selectedIdx ? 'search-result-active' : ''}`}
              onClick={() => { setShowResults(false); setQuery('') }}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className="search-result-icon">{r.isDir ? '📁' : fileIcon(r.name)}</span>
              <span className="search-result-info">
                <span className="search-result-name">{highlightMatch(r.name, query)}</span>
                <span className="search-result-path">{r.path}</span>
              </span>
            </Link>
          ))}
          {results.length >= 50 && (
            <div className="search-more">Showing first 50 results — refine your search</div>
          )}
        </div>
      )}

      {showResults && query.length >= 2 && results.length === 0 && !searching && (
        <div className="search-results">
          <div className="search-empty">No results for &ldquo;{query}&rdquo;</div>
        </div>
      )}
    </div>
  )
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'gaf': return '🎨'
    case 'pcx': return '🖼️'
    case 'wav': return '🔊'
    case 'mp3': return '🎵'
    case 'smk': case 'zrb': return '🎬'
    case 'cob': return '⚙️'
    case 'bos': case 'h': return '📝'
    case 'tdf': case 'fbi': case 'gui': case 'ota': return '📋'
    case 'tnt': case 'sct': return '🗺️'
    case 'fnt': return '🔤'
    case 'pal': return '🎨'
    default: return '📄'
  }
}

function highlightMatch(text: string, query: string) {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <strong className="search-highlight">{text.slice(idx, idx + query.length)}</strong>
      {text.slice(idx + query.length)}
    </>
  )
}
