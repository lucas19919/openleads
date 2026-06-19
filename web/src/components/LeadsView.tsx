import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { isDue } from '../util'
import type { Config, Lead } from '../types'
import { Toolbar } from './Toolbar'
import { Board } from './Board'
import { Table } from './Table'
import { LeadDetail } from './LeadDetail'
import { NewLeadModal } from './NewLeadModal'

export function LeadsView({
  config,
  onCreateInvoice,
}: {
  config: Config
  onCreateInvoice: (lead: Lead) => void
}) {
  const [leads, setLeads] = useState<Lead[]>([])
  // Kanban drag-and-drop needs a mouse; default phones to the table view, whose
  // per-row Phase dropdown works with touch.
  const [view, setView] = useState<'board' | 'table'>(() =>
    typeof window !== 'undefined' && window.innerWidth <= 720 ? 'table' : 'board',
  )
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [importing, setImporting] = useState(false)
  const [recontactOnly, setRecontactOnly] = useState(false)

  const refresh = useCallback(async () => {
    const { leads } = await api.listLeads()
    setLeads(leads)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function onMove(id: number, stage: string) {
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, stage } : l)))
    try {
      await api.updateLead(id, { stage })
    } catch {
      refresh()
    }
  }

  function onChanged(updated: Lead) {
    setLeads((ls) => ls.map((l) => (l.id === updated.id ? updated : l)))
  }

  async function importFile(file: File) {
    setImporting(true)
    try {
      const r = await api.importLeads(file)
      await refresh()
      alert(
        `Import abgeschlossen: ${r.imported} neu, ${r.deduped} bereits vorhanden ` +
          `(von ${r.total} Zeilen).`,
      )
    } catch (e) {
      alert('Import fehlgeschlagen: ' + (e instanceof Error ? e.message : 'Unbekannter Fehler'))
    } finally {
      setImporting(false)
    }
  }

  const dueCount = leads.filter((l) => isDue(l.recontact_at)).length

  const q = search.trim().toLowerCase()
  let filtered = q
    ? leads.filter((l) =>
        [l.company, l.city, l.trade, l.website].some((v) => v?.toLowerCase().includes(q)),
      )
    : leads
  if (recontactOnly) {
    filtered = filtered
      .filter((l) => l.recontact_at)
      .sort((a, b) => (a.recontact_at ?? '').localeCompare(b.recontact_at ?? ''))
  }

  return (
    <>
      <Toolbar
        view={view}
        setView={setView}
        search={search}
        setSearch={setSearch}
        count={filtered.length}
        dueCount={dueCount}
        recontactOnly={recontactOnly}
        setRecontactOnly={setRecontactOnly}
        onNew={() => setShowNew(true)}
        onImportFile={importFile}
        importing={importing}
      />
      <div className="content">
        {leads.length === 0 ? (
          <div className="center-muted">
            Noch keine Leads. Der Scraper füllt sie automatisch — oder lege manuell
            einen an („+ Lead").
          </div>
        ) : view === 'board' ? (
          <Board stages={config.stages} leads={filtered} onOpen={setSelectedId} onMove={onMove} />
        ) : (
          <Table stages={config.stages} leads={filtered} onOpen={setSelectedId} onMove={onMove} />
        )}
      </div>

      {selectedId !== null && (
        <LeadDetail
          id={selectedId}
          stages={config.stages}
          priorities={config.priorities}
          onClose={() => setSelectedId(null)}
          onChanged={onChanged}
          onCreateInvoice={(lead) => {
            setSelectedId(null)
            onCreateInvoice(lead)
          }}
        />
      )}

      {showNew && (
        <NewLeadModal
          priorities={config.priorities}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false)
            refresh()
          }}
        />
      )}
    </>
  )
}
