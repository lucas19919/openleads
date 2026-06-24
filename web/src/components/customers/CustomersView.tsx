import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { Customer, CustomerOverview } from '../../types'
import type { Module } from '../SuiteNav'

const TYPE_LABEL: Record<string, string> = { geschaeft: 'Geschäft (B2B)', privat: 'Privat (B2C)' }

type Draft = Partial<Customer>

function blank(): Draft {
  return { name: '', client_type: 'geschaeft', active: 1 }
}

export function CustomersView({ onNavigate }: { onNavigate: (m: Module) => void }) {
  const [rows, setRows] = useState<Customer[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { customers } = await api.listCustomers()
    setRows(customers)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.')
  }

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const body: Partial<Customer> = {
        name: draft.name,
        contact_name: draft.contact_name,
        address: draft.address,
        zip: draft.zip,
        city: draft.city,
        email: draft.email,
        phone: draft.phone,
        vat_id: draft.vat_id,
        client_type: draft.client_type,
        payment_terms: draft.payment_terms ?? null,
        notes: draft.notes,
        active: draft.active,
      }
      if (draft.id) await api.updateCustomer(draft.id, body)
      else await api.createCustomer(body)
      setDraft(null)
      await refresh()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function remove(c: Customer) {
    if (!confirm(`Kunde „${c.name}" löschen? Bereits erstellte Belege bleiben erhalten (werden entkoppelt).`)) return
    try {
      await api.deleteCustomer(c.id)
      await refresh()
    } catch (e) {
      fail(e)
    }
  }

  async function quickInvoice(c: Customer, kind: 'rechnung' | 'angebot') {
    setBusy(true)
    setError(null)
    try {
      await api.createDocument({ kind, customer_id: c.id })
      setMsg(`${kind === 'rechnung' ? 'Rechnungs' : 'Angebots'}-Entwurf für ${c.name} angelegt.`)
      onNavigate('documents')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function quickContract(c: Customer) {
    setBusy(true)
    setError(null)
    try {
      await api.createContract({ customer_id: c.id, title: 'Vertrag' })
      setMsg(`Vertragsentwurf für ${c.name} angelegt.`)
      onNavigate('contracts')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  // --- editor ---
  if (draft) {
    const d = draft
    const setD = (patch: Partial<Draft>) => setDraft((cur) => (cur ? { ...cur, ...patch } : cur))
    return (
      <div className="content">
        <div className="doc-editor">
          <div className="doc-editor-head">
            <button className="ghost" onClick={() => { setDraft(null); setError(null) }}>Zurück</button>
            <strong>{d.id ? 'Kunde bearbeiten' : 'Neuer Kunde'}</strong>
            <div className="spacer" />
            {error && <span className="user-chip" style={{ color: 'var(--danger)' }}>{error}</span>}
            <button className="primary" onClick={save} disabled={busy || !(d.name ?? '').trim()}>
              {busy ? '…' : 'Speichern'}
            </button>
          </div>

          <fieldset className="doc-block">
            <legend>Stammdaten</legend>
            <div className="row2">
              <div className="field">
                <label>Name / Firma</label>
                <input value={d.name ?? ''} onChange={(e) => setD({ name: e.target.value })} />
              </div>
              <div className="field">
                <label>Ansprechpartner</label>
                <input value={d.contact_name ?? ''} onChange={(e) => setD({ contact_name: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Straße & Hausnr.</label>
              <input value={d.address ?? ''} onChange={(e) => setD({ address: e.target.value })} />
            </div>
            <div className="row2">
              <div className="field">
                <label>PLZ</label>
                <input value={d.zip ?? ''} onChange={(e) => setD({ zip: e.target.value })} />
              </div>
              <div className="field">
                <label>Ort</label>
                <input value={d.city ?? ''} onChange={(e) => setD({ city: e.target.value })} />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>E-Mail</label>
                <input value={d.email ?? ''} onChange={(e) => setD({ email: e.target.value })} />
              </div>
              <div className="field">
                <label>Telefon</label>
                <input value={d.phone ?? ''} onChange={(e) => setD({ phone: e.target.value })} />
              </div>
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Abrechnung</legend>
            <div className="row3">
              <div className="field">
                <label>Kundentyp</label>
                <select value={d.client_type} onChange={(e) => setD({ client_type: e.target.value })}>
                  <option value="geschaeft">{TYPE_LABEL.geschaeft}</option>
                  <option value="privat">{TYPE_LABEL.privat}</option>
                </select>
              </div>
              <div className="field">
                <label>USt-IdNr.</label>
                <input value={d.vat_id ?? ''} placeholder="DE…" onChange={(e) => setD({ vat_id: e.target.value })} />
              </div>
              <div className="field">
                <label>Zahlungsziel (Tage, optional)</label>
                <input
                  type="number"
                  value={d.payment_terms ?? ''}
                  placeholder="Standard"
                  onChange={(e) => setD({ payment_terms: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </div>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={d.active !== 0} onChange={(e) => setD({ active: e.target.checked ? 1 : 0 })} />
              Aktiv
            </label>
            <div className="field">
              <label>Notiz</label>
              <textarea rows={2} value={d.notes ?? ''} onChange={(e) => setD({ notes: e.target.value })} />
            </div>
          </fieldset>

          {d.id && <CustomerOverviewPanel customerId={d.id} onNavigate={onNavigate} />}
        </div>
      </div>
    )
  }

  // --- list ---
  return (
    <>
      <div className="toolbar">
        <span className="page-title">Kunden</span>
        <span className="user-chip">{rows.length} Kunden</span>
        <div className="spacer" />
        <button className="primary" onClick={() => { setDraft(blank()); setError(null); setMsg(null) }}>+ Neuer Kunde</button>
      </div>

      <div className="content">
        <p className="settings-hint">
          Pflege deine Kunden einmal — beim Erstellen von Angebot, Rechnung, Vertrag oder Serie werden die Daten
          übernommen. Die Belege behalten ihre eigene Kopie, spätere Änderungen hier wirken nur auf neue Belege.
        </p>
        {error && <div className="section-error">{error}</div>}
        {msg && <div className="section-info">{msg}</div>}

        {rows.length === 0 ? (
          <div className="center-muted">Noch keine Kunden. Lege einen an oder erstelle einen aus einem Lead.</div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ort</th>
                  <th>E-Mail</th>
                  <th>Typ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} onClick={() => { setDraft(c); setError(null); setMsg(null) }}>
                    <td data-label="Name" className="cell-primary">
                      {c.name}{c.active === 0 && <span className="user-chip" style={{ marginLeft: 6 }}>inaktiv</span>}
                    </td>
                    <td data-label="Ort">{c.city ?? '—'}</td>
                    <td data-label="E-Mail">{c.email ?? '—'}</td>
                    <td data-label="Typ">{TYPE_LABEL[c.client_type] ?? c.client_type}</td>
                    <td data-label="" onClick={(e) => e.stopPropagation()}>
                      <button className="ghost" disabled={busy} onClick={() => quickInvoice(c, 'rechnung')} title="Rechnungsentwurf anlegen">Rechnung</button>
                      <button className="ghost" disabled={busy} onClick={() => quickInvoice(c, 'angebot')} title="Angebotsentwurf anlegen">Angebot</button>
                      <button className="ghost" disabled={busy} onClick={() => quickContract(c)} title="Vertragsentwurf anlegen">Vertrag</button>
                      <button className="ghost" onClick={() => remove(c)}>Löschen</button>
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

const DOC_KIND_LABEL: Record<string, string> = { rechnung: 'Rechnung', angebot: 'Angebot' }

// Per-customer 360: revenue totals + linked documents/contracts/recurring, with
// jump-through to the relevant module. Read-only; loads on mount.
function CustomerOverviewPanel({ customerId, onNavigate }: { customerId: number; onNavigate: (m: Module) => void }) {
  const [ov, setOv] = useState<CustomerOverview | null>(null)
  useEffect(() => {
    let alive = true
    api.customerOverview(customerId).then(({ overview }) => alive && setOv(overview)).catch(() => {})
    return () => {
      alive = false
    }
  }, [customerId])

  if (!ov) return null
  const empty = ov.documents.length === 0 && ov.contracts.length === 0 && ov.recurring.length === 0
  return (
    <fieldset className="doc-block">
      <legend>Übersicht für diesen Kunden</legend>
      <div className="dash-cards" style={{ marginBottom: 12 }}>
        <div className="dash-card">
          <span className="dash-card-label">Berechnet</span>
          <span className="dash-card-value">{euro(ov.totals.invoiced_gross_cents)}</span>
          <span className="dash-card-sub">davon {euro(ov.totals.paid_cents)} bezahlt</span>
        </div>
        <div className="dash-card">
          <span className="dash-card-label">Offen</span>
          <span className="dash-card-value" style={{ color: ov.totals.open_cents ? 'var(--danger)' : 'var(--text)' }}>{euro(ov.totals.open_cents)}</span>
          <span className="dash-card-sub">{ov.totals.quotes} Angebot(e)</span>
        </div>
        <div className="dash-card">
          <span className="dash-card-label">Aktive Verträge</span>
          <span className="dash-card-value">{ov.totals.contracts_active}</span>
          <span className="dash-card-sub">{ov.contracts.length} insgesamt</span>
        </div>
      </div>

      {empty && <div className="center-muted">Noch keine Belege für diesen Kunden.</div>}

      {ov.documents.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table className="items-table">
            <thead><tr><th>Beleg</th><th>Status</th><th className="num">Brutto</th><th className="num">Offen</th><th /></tr></thead>
            <tbody>
              {ov.documents.map((d) => (
                <tr key={d.id}>
                  <td data-label="Beleg" className="cell-primary">{DOC_KIND_LABEL[d.kind] ?? d.kind} {d.number ?? '(Entwurf)'}</td>
                  <td data-label="Status"><span className={`doc-status doc-status-${d.status}`}>{d.status}</span></td>
                  <td data-label="Brutto" className="num">{euro(d.gross_cents)}</td>
                  <td data-label="Offen" className="num">{d.open_cents ? euro(d.open_cents) : '—'}</td>
                  <td data-label=""><button className="ghost" onClick={() => onNavigate('documents')}>öffnen</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ov.contracts.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table className="items-table">
            <thead><tr><th>Vertrag</th><th>Status</th><th className="num">Wert</th><th>Ende</th><th /></tr></thead>
            <tbody>
              {ov.contracts.map((k) => (
                <tr key={k.id}>
                  <td data-label="Vertrag" className="cell-primary">{k.number ?? '(Entwurf)'}</td>
                  <td data-label="Status"><span className={`doc-status doc-status-${k.status}`}>{k.status}</span></td>
                  <td data-label="Wert" className="num">{euro(k.value_cents)}</td>
                  <td data-label="Ende">{k.end_date ? fmtDate(k.end_date) : '—'}</td>
                  <td data-label=""><button className="ghost" onClick={() => onNavigate('contracts')}>öffnen</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ov.recurring.length > 0 && (
        <div className="table-wrap">
          <table className="items-table">
            <thead><tr><th>Serie</th><th>Turnus</th><th>Nächster Lauf</th><th /></tr></thead>
            <tbody>
              {ov.recurring.map((r) => (
                <tr key={r.id}>
                  <td data-label="Serie" className="cell-primary">{r.title ?? '—'}{r.active ? '' : ' (pausiert)'}</td>
                  <td data-label="Turnus">{r.cadence}</td>
                  <td data-label="Nächster Lauf">{fmtDate(r.next_run)}</td>
                  <td data-label=""><button className="ghost" onClick={() => onNavigate('recurring')}>öffnen</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </fieldset>
  )
}
