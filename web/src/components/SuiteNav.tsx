import type { User } from '../types'

export type Module = 'leads' | 'documents' | 'scraper' | 'settings'

const TABS: { id: Module; label: string }[] = [
  { id: 'leads', label: 'Leads' },
  { id: 'documents', label: 'Rechnungen' },
  { id: 'scraper', label: 'Scraper' },
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
  return (
    <div className="suite-nav">
      <div className="brand">
        Open<span>Leads</span>
      </div>
      <nav className="suite-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={module === t.id ? 'active' : ''}
            onClick={() => setModule(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <span className="user-chip">{user.username}</span>
      <button className="ghost" onClick={onLogout}>
        Abmelden
      </button>
    </div>
  )
}
