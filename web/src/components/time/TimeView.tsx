import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro, centsToInput, inputToCents } from '../../money'
import { fmtDate, todayISO } from '../../util'
import { CatalogPicker } from '../invoices/CatalogPicker'
import type { Config, Lead, TimeEntry, TimeSummary } from '../../types'

/** Parse a German decimal-hours input ("1,5") → whole minutes. */
function hoursToMinutes(s: string): number {
  const n = Number(s.trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0
}
function minutesToHours(min: number): string {
  return (min / 60).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function TimeView({ config }: { config: Config }) {
  void config
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [summary, setSummary] = useState<TimeSummary | null>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // New-entry form
  const [date, setDate] = useState(todayISO())
  const [desc, setDesc] = useState('')
  const [hours, setHours] = useState('')
  const [rate, setRate] = useState('')
  const [billable, setBillable] = useState(true)
  const [leadId, setLeadId] = useState<string>('')

  const leadName = useCallback(
    (id: number | null) => (id == null ? '—' : leads.find((l) => l.id === id)?.company ?? `Lead ${id}`),
    [leads],
  )

  const refresh = useCallback(async () => {
    const { entries, summary } = await api.listTime(onlyOpen ? { billable: '1', invoiced: '0' } : {})
    setEntries(entries)
    setSummary(summary)
  }, [onlyOpen])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    api.listLeads().then(({ leads }) => setLeads(leads)).catch(() => {})
    // Prefill the rate from the saved default hourly rate, if any.
    api.getSettings().then(({ settings }) => {
      const c = settings.default_hourly_rate_cents ?? 0
      if (c > 0) setRate(centsToInput(c))
    }).catch(() => {})
  }, [])

  async function add() {
    const minutes = hoursToMinutes(hours)
    if (minutes <= 0) {
      setError('Bitte eine Dauer in Stunden angeben (z. B. 1,5).')
      return
    }
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      await api.createTimeEntry({
        entry_date: date,
        description: desc || null,
        minutes,
        rate_cents: inputToCents(rate),
        billable: billable ? 1 : 0,
        lead_id: leadId ? Number(leadId) : null,
      })
      setDesc('')
      setHours('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(e: TimeEntry) {
    if (!confirm('Zeiteintrag löschen?')) return
    try {
      await api.deleteTimeEntry(e.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.')
    }
  }

  function toggleSelect(id: number) {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectable = entries.filter((e) => e.billable && !e.document_id)
  const selectedSum = entries
    .filter((e) => selected.has(e.id))
    .reduce((s, e) => s + e.amount_cents, 0)

  function selectAllOpen() {
    setSelected(new Set(selectable.map((e) => e.id)))
  }

  async function createInvoice() {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const { document } = await api.invoiceTime(ids)
      setSelected(new Set())
      await refresh()
      setMsg(`Rechnungsentwurf mit ${document.items.length} Position(en) erstellt — unter „Rechnungen" prüfen und festschreiben.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rechnung konnte nicht erstellt werden.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Zeiterfassung</span>
        {summary && (
          <span className="user-chip">
            {minutesToHours(summary.minutes)} h · offen abrechenbar {euro(summary.uninvoiced_amount_cents)}
          </span>
        )}
        <div className="spacer" />
        <label className="check-row">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
          Nur offene, abrechenbare
        </label>
      </div>

      <div className="content">
        <p className="settings-hint">
          Erfasse Arbeitszeit (abrechenbar oder nicht) und erzeuge daraus per Auswahl einen
          <strong> Rechnungsentwurf</strong> — jede Zeile ist Stunden × Stundensatz. Standard-Stundensatz und
          Katalogsätze kommen aus <strong>Einstellungen</strong> bzw. dem Leistungskatalog.
        </p>
        {error && <div className="section-error">{error}</div>}
        {msg && <div className="section-info">{msg}</div>}

        <fieldset className="doc-block">
          <legend>Zeit erfassen</legend>
          <div className="row3">
            <div className="field">
              <label>Datum</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field">
              <label>Dauer (Std.)</label>
              <input value={hours} placeholder="z. B. 1,5" onChange={(e) => setHours(e.target.value)} />
            </div>
            <div className="field">
              <label>Stundensatz netto (€)</label>
              <input value={rate} placeholder="95,00" onChange={(e) => setRate(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Tätigkeit</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input style={{ flex: 1, minWidth: 180 }} value={desc} placeholder="Was wurde gemacht?" onChange={(e) => setDesc(e.target.value)} />
              <CatalogPicker
                onPick={(it) => {
                  setDesc((it.description ?? '').trim() || it.name)
                  if (it.unit_price_cents) setRate(centsToInput(it.unit_price_cents))
                }}
              />
            </div>
          </div>
          <div className="row3">
            <div className="field">
              <label>Kunde / Lead (optional)</label>
              <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">— kein Lead —</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.company ?? `Lead ${l.id}`}</option>
                ))}
              </select>
            </div>
            <label className="check-row" style={{ alignSelf: 'end' }}>
              <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
              Abrechenbar
            </label>
            <div className="field" style={{ alignSelf: 'end' }}>
              <button className="primary" onClick={add} disabled={busy || hoursToMinutes(hours) <= 0}>Erfassen</button>
            </div>
          </div>
        </fieldset>

        {selected.size > 0 && (
          <div className="section-info" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{selected.size} ausgewählt · {euro(selectedSum)}</span>
            <button className="primary" onClick={createInvoice} disabled={busy}>Rechnung aus Auswahl erstellen</button>
            <button className="ghost" onClick={() => setSelected(new Set())}>Auswahl aufheben</button>
          </div>
        )}

        {entries.length === 0 ? (
          <div className="center-muted">Noch keine Zeiteinträge.</div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>
                    {selectable.length > 0 && (
                      <input
                        type="checkbox"
                        title="Alle offenen, abrechenbaren auswählen"
                        checked={selected.size > 0 && selectable.every((e) => selected.has(e.id))}
                        onChange={(e) => (e.target.checked ? selectAllOpen() : setSelected(new Set()))}
                      />
                    )}
                  </th>
                  <th>Datum</th>
                  <th>Kunde</th>
                  <th>Tätigkeit</th>
                  <th className="num">Std.</th>
                  <th className="num">Satz</th>
                  <th className="num">Betrag</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const open = e.billable && !e.document_id
                  return (
                    <tr key={e.id}>
                      <td data-label="">
                        {open && (
                          <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} />
                        )}
                      </td>
                      <td data-label="Datum">{fmtDate(e.entry_date)}</td>
                      <td data-label="Kunde">{leadName(e.lead_id)}</td>
                      <td data-label="Tätigkeit" className="cell-primary">{e.description ?? '—'}</td>
                      <td data-label="Std." className="num">{minutesToHours(e.minutes)}</td>
                      <td data-label="Satz" className="num">{e.billable ? euro(e.rate_cents) : '—'}</td>
                      <td data-label="Betrag" className="num cell-total">{e.billable ? euro(e.amount_cents) : '—'}</td>
                      <td data-label="Status">
                        {!e.billable ? (
                          <span className="doc-status">nicht abrechenbar</span>
                        ) : e.document_id ? (
                          <span className="doc-status doc-status-bezahlt">abgerechnet</span>
                        ) : (
                          <span className="doc-status doc-status-versendet">offen</span>
                        )}
                      </td>
                      <td data-label="">
                        {!e.document_id && <button className="ghost" onClick={() => remove(e)}>Löschen</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
