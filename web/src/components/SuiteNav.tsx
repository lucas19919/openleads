import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AiStatus, User } from '../types'
import { AiBadge } from './ai/CopilotView'

export type Module =
  | 'dashboard'
  | 'copilot'
  | 'leads'
  | 'scraper'
  | 'documents'
  | 'recurring'
  | 'mahnungen'
  | 'settings'

const TABS: { id: Module; label: string }[] = [
  { id: 'dashboard', label: 'Übersicht' },
  { id: 'copilot', label: 'Chat' },
  { id: 'leads', label: 'Leads' },
  { id: 'scraper', label: 'Scraper' },
  { id: 'documents', label: 'Rechnungen' },
  { id: 'recurring', label: 'Serien' },
  { id: 'mahnungen', label: 'Mahnungen' },
  { id: 'settings', label: 'Einstellungen' },
]

export function SuiteNav({
  module,
  setModule,
  user,
  onLogout,
}: {
  module: Module
  setModule: (m: Module) => void
  user: User
  onLogout: () => void
}) {
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => api.aiStatus().then((s) => alive && setAiStatus(s)).catch(() => {})
    load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  const activeLabel = TABS.find((t) => t.id === module)?.label ?? ''
  return (
    <div className={`suite-nav${menuOpen ? ' menu-open' : ''}`}>
      <div className="brand">
        Open<span>Leads</span>
      </div>
      <button
        className="burger"
        aria-label="Menü"
        aria-expanded={menuOpen}
        aria-controls="suite-tabs"
        onClick={() => setMenuOpen((o) => !o)}
      >
        <span className="burger-lines" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="burger-label">{activeLabel}</span>
      </button>
      <nav className="suite-tabs" id="suite-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={module === t.id ? 'active' : ''}
            onClick={() => {
              setModule(t.id)
              setMenuOpen(false)
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <AiBadge status={aiStatus} />
      <span className="user-chip">{user.username}</span>
      <button className="ghost" onClick={onLogout}>
        Abmelden
      </button>
    </div>
  )
}
