import { useState } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { BankApplyItem, BankPreview, BankPreviewEntry } from '../../types'

export function BankView() {
  const [preview, setPreview] = useState<BankPreview | null>(null)
  const [sel, setSel] = useState<Record<string, string>>({}) // ext_ref → invoice id | '' | 'ignore'
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onFile(file: File | null) {
    if (!file) return
    setBusy(true)
    setError(null)
    setMsg(null)
    setPreview(null)
    try {
      const { preview } = await api.bankPreview(file)
      setPreview(preview)
      // Default each new credit to its suggestion (if any).
      const init: Record<string, string> = {}
      for (const e of preview.entries) {
        if (e.direction === 'credit' && !e.already_seen) {
          init[e.ext_ref] = e.suggestion ? String(e.suggestion.document_id) : ''
        }
      }
      setSel(init)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import fehlgeschlagen.')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!preview) return
    const items: BankApplyItem[] = []
    for (const e of preview.entries) {
      if (e.already_seen || e.direction !== 'credit') continue
      const choice = sel[e.ext_ref] ?? ''
      if (choice === '') continue // left for later
      const base = { ext_ref: e.ext_ref, booked_on: e.booked_on, amount_cents: e.amount_cents, direction: e.direction, remittance: e.remittance, counterparty: e.counterparty }
      if (choice === 'ignore') items.push({ ...base, ignore: true })
      else items.push({ ...base, document_id: Number(choice) })
    }
    if (items.length === 0) {
      setError('Keine Buchung zugeordnet oder ignoriert.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { result } = await api.bankApply(items)
      setMsg(`${result.matched} Zahlung(en) verbucht, ${result.ignored} ignoriert${result.skipped ? `, ${result.skipped} übersprungen` : ''}.`)
      setPreview(null)
      setSel({})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Übernehmen fehlgeschlagen.')
    } finally {
      setBusy(false)
    }
  }

  const invOptions = preview?.open_invoices ?? []
  const actionable = preview ? preview.entries.filter((e) => e.direction === 'credit' && !e.already_seen).length : 0

  function row(e: BankPreviewEntry) {
    const disabled = e.already_seen || e.direction === 'debit'
    return (
      <tr key={e.ext_ref} style={disabled ? { opacity: 0.55 } : undefined}>
        <td data-label="Datum">{e.booked_on ? fmtDate(e.booked_on) : '—'}</td>
        <td data-label="Zahler/Empfänger">{e.counterparty ?? '—'}</td>
        <td data-label="Verwendungszweck" className="cell-primary">{e.remittance || '—'}</td>
        <td data-label="Betrag" className="num cell-total" style={{ color: e.direction === 'debit' ? 'var(--danger)' : 'var(--ok)' }}>
          {e.direction === 'debit' ? '−' : '+'}{euro(e.amount_cents)}
        </td>
        <td data-label="Zuordnung">
          {e.already_seen ? (
            <span className="doc-status">bereits importiert</span>
          ) : e.direction === 'debit' ? (
            <span className="doc-status">Ausgang</span>
          ) : (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={sel[e.ext_ref] ?? ''} onChange={(ev) => setSel((s) => ({ ...s, [e.ext_ref]: ev.target.value }))}>
                <option value="">— nicht zuordnen —</option>
                {invOptions.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.number ?? `#${inv.id}`} · {inv.client_name ?? '—'} ({euro(inv.outstanding_cents)})
                  </option>
                ))}
                <option value="ignore">ignorieren (nicht verbuchen)</option>
              </select>
              {e.suggestion && (
                <span className={`doc-status ${e.suggestion.amount_ok ? 'doc-status-bezahlt' : 'doc-status-versendet'}`} title={e.suggestion.reason === 'number' ? 'Rechnungsnummer im Verwendungszweck erkannt' : 'Eindeutiger Betrag'}>
                  Vorschlag: {e.suggestion.reason === 'number' ? 'Nr.' : 'Betrag'}{e.suggestion.amount_ok ? '' : ' (Betrag ≠)'}
                </span>
              )}
            </span>
          )}
        </td>
      </tr>
    )
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Bankabgleich</span>
        {preview && <span className="user-chip">{preview.credits} Eingänge · {actionable} offen</span>}
        <div className="spacer" />
        {preview && actionable > 0 && (
          <button className="primary" onClick={apply} disabled={busy}>Zuordnungen übernehmen</button>
        )}
      </div>

      <div className="content">
        <p className="settings-hint">
          Lade einen <strong>CAMT.053</strong>- (ISO-20022-XML) oder <strong>MT940</strong>-Kontoauszug hoch — beide
          exportiert fast jede Bank. Eingänge werden automatisch offenen Rechnungen zugeordnet — über die
          <strong> Rechnungsnummer</strong> im Verwendungszweck, sonst über einen eindeutigen Betrag. Du bestätigst
          jede Zuordnung; dann werden die Zahlungen verbucht. Bereits importierte Buchungen werden erkannt (keine
          Doppelbuchung).
        </p>
        {error && <div className="section-error">{error}</div>}
        {msg && <div className="section-info">{msg}</div>}

        <fieldset className="doc-block">
          <legend>Kontoauszug importieren</legend>
          <div className="field">
            <label>Kontoauszug (CAMT.053 .xml oder MT940 .sta/.txt)</label>
            <input
              type="file"
              accept=".xml,application/xml,text/xml,.sta,.txt,.940,text/plain"
              disabled={busy}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </fieldset>

        {preview && (
          preview.entries.length === 0 ? (
            <div className="center-muted">Keine Buchungen im Auszug gefunden.</div>
          ) : (
            <div className="table-wrap">
              <table className="leads">
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Zahler/Empfänger</th>
                    <th>Verwendungszweck</th>
                    <th className="num">Betrag</th>
                    <th>Zuordnung</th>
                  </tr>
                </thead>
                <tbody>{preview.entries.map(row)}</tbody>
              </table>
            </div>
          )
        )}
      </div>
    </>
  )
}
