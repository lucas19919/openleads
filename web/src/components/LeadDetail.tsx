import { useEffect, useState } from 'react'
import { api } from '../api'
import { addDaysISO } from '../util'
import type { Lead, LeadEvent } from '../types'

// Imported/scraped websites are often bare domains ("foo.de") with no scheme.
// Without a scheme the browser treats the link as relative — prepend https://.
function toHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

function describe(ev: LeadEvent): string {
  switch (ev.type) {
    case 'created':
      return 'Lead angelegt'
    case 'stage_change':
      return `Phase: ${ev.from_stage} → ${ev.to_stage}`
    case 'note':
      return `Notiz: ${ev.body ?? ''}`
    default:
      return ev.body ?? ev.type
  }
}

export function LeadDetail({
  id,
  stages,
  priorities,
  onClose,
  onChanged,
  onCreateInvoice,
}: {
  id: number
  stages: string[]
  priorities: string[]
  onClose: () => void
  onChanged: (l: Lead) => void
  onCreateInvoice: (l: Lead) => void
}) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [events, setEvents] = useState<LeadEvent[]>([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    api.getLead(id).then(({ lead, events }) => {
      if (!active) return
      setLead(lead)
      setEvents(events)
      setNotes(lead.notes ?? '')
    })
    return () => {
      active = false
    }
  }, [id])

  async function patch(p: Partial<Lead>) {
    const { lead } = await api.updateLead(id, p)
    setLead(lead)
    onChanged(lead)
    const fresh = await api.getLead(id)
    setEvents(fresh.events)
  }

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer">
        {!lead ? (
          <div className="drawer-body center-muted">Lädt…</div>
        ) : (
          <>
            <div className="drawer-head">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <strong style={{ fontSize: 16 }}>{lead.company ?? 'Lead'}</strong>
                <button className="ghost" onClick={onClose}>
                  ✕
                </button>
              </div>
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                {[lead.trade, lead.city].filter(Boolean).join(' · ') || '—'}
              </div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => onCreateInvoice(lead)}>
                  📄 Angebot / Rechnung erstellen
                </button>
              </div>
            </div>

            <div className="drawer-body">
              <div className="row2">
                <div className="field">
                  <label>Phase</label>
                  <select value={lead.stage} onChange={(e) => patch({ stage: e.target.value })}>
                    {stages.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Priorität</label>
                  <select
                    value={lead.priority}
                    onChange={(e) => patch({ priority: e.target.value })}
                  >
                    {priorities.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Wiedervorlage / Rückruf</label>
                <input
                  type="date"
                  value={lead.recontact_at ?? ''}
                  onChange={(e) => patch({ recontact_at: e.target.value || null })}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => patch({ recontact_at: addDaysISO(3) })}>+3 Tage</button>
                  <button onClick={() => patch({ recontact_at: addDaysISO(7) })}>+1 Woche</button>
                  <button onClick={() => patch({ recontact_at: addDaysISO(14) })}>+2 Wochen</button>
                  {lead.recontact_at && (
                    <button className="ghost" onClick={() => patch({ recontact_at: null })}>
                      Entfernen
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div className="kv">
                  <span className="k">Score</span>
                  <span>{lead.score}</span>
                </div>
                {lead.website && (
                  <div className="kv">
                    <span className="k">Website</span>
                    <a href={toHref(lead.website)} target="_blank" rel="noopener noreferrer">
                      {lead.website.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                )}
                {lead.phone && (
                  <div className="kv">
                    <span className="k">Telefon</span>
                    <a href={`tel:${lead.phone}`}>{lead.phone}</a>
                  </div>
                )}
                {lead.email && (
                  <div className="kv">
                    <span className="k">E-Mail</span>
                    <a href={`mailto:${lead.email}`}>{lead.email}</a>
                  </div>
                )}
                {lead.mobile_friendly !== null && (
                  <div className="kv">
                    <span className="k">Mobilfähig</span>
                    <span className={lead.mobile_friendly ? 'mobil-yes' : 'mobil-no'}>
                      {lead.mobile_friendly ? 'ja' : 'nein'}
                    </span>
                  </div>
                )}
                {lead.tech && (
                  <div className="kv">
                    <span className="k">Technik</span>
                    <span>{lead.tech}</span>
                  </div>
                )}
                {lead.staleness_signal && (
                  <div className="kv">
                    <span className="k">Signal</span>
                    <span>{lead.staleness_signal}</span>
                  </div>
                )}
              </div>

              {lead.why_lead && (
                <div className="field">
                  <label>Warum Lead</label>
                  <div>{lead.why_lead}</div>
                </div>
              )}

              <div className="field">
                <label>Notizen</label>
                <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    className="primary"
                    disabled={saving || notes === (lead.notes ?? '')}
                    onClick={async () => {
                      setSaving(true)
                      try {
                        await patch({ notes })
                      } finally {
                        setSaving(false)
                      }
                    }}
                  >
                    {saving ? '…' : 'Notiz speichern'}
                  </button>
                </div>
              </div>

              <div className="field">
                <label>Verlauf</label>
                <div className="timeline">
                  {events.map((ev) => (
                    <div className="event" key={ev.id}>
                      <div>{describe(ev)}</div>
                      <div className="when">
                        {ev.at}
                        {ev.actor ? ` · ${ev.actor}` : ''}
                      </div>
                    </div>
                  ))}
                  {events.length === 0 && (
                    <div className="center-muted">Noch keine Aktivität.</div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
