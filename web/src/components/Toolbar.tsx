import { useRef } from 'react'

export function Toolbar({
  view,
  setView,
  search,
  setSearch,
  count,
  dueCount,
  recontactOnly,
  setRecontactOnly,
  onNew,
  onImportFile,
  importing,
}: {
  view: 'board' | 'table'
  setView: (v: 'board' | 'table') => void
  search: string
  setSearch: (v: string) => void
  count: number
  dueCount: number
  recontactOnly: boolean
  setRecontactOnly: (v: boolean) => void
  onNew: () => void
  onImportFile: (file: File) => void
  importing: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="toolbar">
      <div className="seg">
        <button
          className={view === 'board' ? 'active' : ''}
          onClick={() => setView('board')}
        >
          Board
        </button>
        <button
          className={view === 'table' ? 'active' : ''}
          onClick={() => setView('table')}
        >
          Tabelle
        </button>
      </div>
      <input
        className="search"
        placeholder="Suche Firma, Ort, Gewerk…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <button
        className={`recontact-toggle${recontactOnly ? ' active' : ''}${dueCount > 0 ? ' has-due' : ''}`}
        onClick={() => setRecontactOnly(!recontactOnly)}
        title="Nur Leads mit Wiedervorlage / Rückruf anzeigen"
      >
        📞 Wiedervorlage{dueCount > 0 ? ` · ${dueCount} fällig` : ''}
      </button>
      <span className="user-chip">{count} Leads</span>
      <div className="spacer" />
      <button onClick={() => fileRef.current?.click()} disabled={importing}>
        {importing ? 'Importiere…' : 'Import xlsx'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onImportFile(f)
          e.target.value = ''
        }}
      />
      <button onClick={onNew}>+ Lead</button>
    </div>
  )
}
