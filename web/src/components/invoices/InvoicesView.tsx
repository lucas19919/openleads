import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { Config, Doc, Lead } from '../../types'
import { DocumentEditor } from './DocumentEditor'

const KIND_LABEL: Record<string, string> = { angebot: 'Angebot', rechnung: 'Rechnung' }

export function InvoicesView({
  config,
  prefillLead,
  onPrefillHandled,
}: {
  config: Config
  prefillLead: Lead | null
  onPrefillHandled: () => void
}) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [filter, setFilter] = useState<'all' | 'angebot' | 'rechnung'>('all')
  const [openId, setOpenId] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    const { documents } = await api.listDocuments()
    setDocs(documents)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // A lead was sent over from the CRM → spin up a draft Angebot and open it.
  useEffect(() => {
    if (!prefillLead) return
    let active = true
    api
      .createDocument({
        kind: 'angebot',
        lead_id: prefillLead.id,
        client_name: prefillLead.company,
        client_city: prefillLead.city,
        client_email: prefillLead.email,
      })
      .then(({ document }) => {
        if (!active) return
        refresh()
        setOpenId(document.id)
      })
      .finally(() => onPrefillHandled())
    return () => {
      active = false
    }
  }, [prefillLead, refresh, onPrefillHandled])

  async function createNew(kind: 'angebot' | 'rechnung') {
    const { document } = await api.createDocument({ kind })
    await refresh()
    setOpenId(document.id)
  }

  async function remove(id: number) {
    if (!confirm('Entwurf löschen?')) return
    try {
      await api.deleteDocument(id)
      refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Löschen fehlgeschlagen.')
    }
  }

  if (openId !== null) {
    return (
      <div className="content">
        <DocumentEditor
          id={openId}
          config={config}
          onClose={() => {
            setOpenId(null)
            refresh()
          }}
          onChanged={refresh}
        />
      </div>
    )
  }

  const visible = docs.filter((d) => filter === 'all' || d.kind === filter)

  return (
    <>
      <div className="toolbar">
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            Alle
          </button>
          <button className={filter === 'angebot' ? 'active' : ''} onClick={() => setFilter('angebot')}>
            Angebote
          </button>
          <button className={filter === 'rechnung' ? 'active' : ''} onClick={() => setFilter('rechnung')}>
            Rechnungen
          </button>
        </div>
        <span className="user-chip">{visible.length} Dokumente</span>
        <div className="spacer" />
        <button onClick={() => createNew('angebot')}>+ Angebot</button>
        <button className="primary" onClick={() => createNew('rechnung')}>
          + Rechnung
        </button>
      </div>

      <div className="content">
        {visible.length === 0 ? (
          <div className="center-muted">
            Noch keine Dokumente. Lege ein Angebot oder eine Rechnung an — oder starte aus einem Lead
            heraus („📄 Angebot / Rechnung erstellen").
          </div>
        ) : (
          <div className="table-wrap">
          <table className="leads">
            <thead>
              <tr>
                <th>Typ</th>
                <th>Nummer</th>
                <th>Empfänger</th>
                <th>Datum</th>
                <th>Status</th>
                <th className="num">Betrag</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr key={d.id} onClick={() => setOpenId(d.id)}>
                  <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                  <td className="no-x">{d.number ?? <em style={{ color: 'var(--muted)' }}>Entwurf</em>}</td>
                  <td>{d.client_name ?? '—'}</td>
                  <td>{d.issue_date ? fmtDate(d.issue_date) : '—'}</td>
                  <td>
                    <span className={`doc-status doc-status-${d.status}`}>{d.status}</span>
                  </td>
                  <td className="num">{euro(d.totals.gross_cents)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {!d.number && (
                      <button className="ghost" onClick={() => remove(d.id)} title="Entwurf löschen">
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </>
  )
}
