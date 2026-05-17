import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import Home from './pages/Home'
import Browse from './pages/Browse'
import View from './pages/view'
import Describe from './pages/Describe'
import { getStoredTheme, setStoredTheme, applyTheme, type ThemeMode } from './theme'
import SearchBox from './components/SearchBox'
import CacheProgress from './components/CacheProgress'

const THEME_ICONS: Record<ThemeMode, string> = { light: '☀️', dark: '🌙', system: '💻' }
const THEME_CYCLE: ThemeMode[] = ['dark', 'light', 'system']

export default function App() {
  const location = useLocation()
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme)

  useEffect(() => {
    applyTheme(theme)
    // Listen for system theme changes when in system mode.
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => { if (theme === 'system') applyTheme('system') }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const cycleTheme = useCallback(() => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]
    setTheme(next)
    setStoredTheme(next)
  }, [theme])

  const isActive = (prefix: string) => {
    if (prefix === '/') return location.pathname === '/'
    return location.pathname.startsWith(prefix)
  }

  return (
    <>
      <header className="app-header">
        <NavLink to="/" className="logo">
          <span className="icon">🤖</span>
          <span>KBot Explorer</span>
        </NavLink>
        <nav>
          <NavLink to="/" className={isActive('/') ? 'active' : ''} end>
            Dashboard
          </NavLink>
          <NavLink to="/browse" className={isActive('/browse') ? 'active' : ''}>
            Browse
          </NavLink>
        </nav>
        <div className="header-right">
          <SearchBox compact />
          <button className="theme-toggle" onClick={cycleTheme} title={`Theme: ${theme}`}>
            {THEME_ICONS[theme]}
          </button>
        </div>
      </header>
      <main className="app-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/browse/*" element={<Browse />} />
          <Route path="/view/*" element={<View />} />
          <Route path="/describe/*" element={<Describe />} />
        </Routes>
      </main>
      <CacheProgress />
      <footer className="app-footer">
        KBot Tools &copy; {new Date().getFullYear()} Steve Gray
      </footer>
    </>
  )
}
