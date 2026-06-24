import { db, type TimeEntryRow, type LeadRow } from './db'
import { getSettings, getDocument, tx, type FullDocument } from './documents'

// Zeiterfassung (time tracking). Billable time logged against a lead/client, kept
// in whole minutes. Entries can be pulled into a draft Rechnung — each becomes a
// line (hours × net hourly rate) and is stamped invoiced so it can't be billed
// twice. Same in-the-loop posture: only a *draft* is created; a human finalises.

export interface TimeEntryInput {
  lead_id?: number | null
  catalog_item_id?: number | null
  entry_date?: string | null
  description?: string | null
  minutes?: number | null
  rate_cents?: number | null
  billable?: number | boolean | null
}

export interface TimeFilter {
  from?: string
  to?: string
  lead_id?: number
  billable?: boolean
  invoiced?: boolean
}

export interface TimeEntry extends TimeEntryRow {
  /** minutes/60 × rate_cents, rounded to the cent (0 when non-billable). */
  amount_cents: number
}

export interface TimeSummary {
  count: number
  minutes: number
  billable_minutes: number
  amount_cents: number // billable, total
  uninvoiced_amount_cents: number // billable & not yet invoiced
}

function bool(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt
  return v ? 1 : 0
}

/** Billable amount of an entry in cents (0 when non-billable). */
export function entryAmountCents(minutes: number, rate_cents: number, billable: number): number {
  if (!billable) return 0
  return Math.round((minutes / 60) * rate_cents)
}

function withAmount(row: TimeEntryRow): TimeEntry {
  return { ...row, amount_cents: entryAmountCents(row.minutes, row.rate_cents, row.billable) }
}

function buildWhere(f: TimeFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (f.from) {
    clauses.push('entry_date >= ?')
    params.push(f.from)
  }
  if (f.to) {
    clauses.push('entry_date <= ?')
    params.push(f.to)
  }
  if (f.lead_id != null) {
    clauses.push('lead_id = ?')
    params.push(f.lead_id)
  }
  if (f.billable !== undefined) {
    clauses.push('billable = ?')
    params.push(f.billable ? 1 : 0)
  }
  if (f.invoiced !== undefined) {
    clauses.push(f.invoiced ? 'document_id IS NOT NULL' : 'document_id IS NULL')
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function listTime(filter: TimeFilter = {}): TimeEntry[] {
  const { sql, params } = buildWhere(filter)
  const rows = db
    .prepare(`SELECT * FROM time_entries ${sql} ORDER BY entry_date DESC, id DESC`)
    .all(...params) as unknown as TimeEntryRow[]
  return rows.map(withAmount)
}

export function timeSummary(filter: TimeFilter = {}): TimeSummary {
  const entries = listTime(filter)
  let minutes = 0
  let billable_minutes = 0
  let amount_cents = 0
  let uninvoiced_amount_cents = 0
  for (const e of entries) {
    minutes += e.minutes
    if (e.billable) {
      billable_minutes += e.minutes
      amount_cents += e.amount_cents
      if (!e.document_id) uninvoiced_amount_cents += e.amount_cents
    }
  }
  return { count: entries.length, minutes, billable_minutes, amount_cents, uninvoiced_amount_cents }
}

export function getTimeEntry(id: number): TimeEntry | null {
  const row = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as unknown as
    | TimeEntryRow
    | undefined
  return row ? withAmount(row) : null
}

export function createTimeEntry(input: TimeEntryInput, createdBy?: string | null): TimeEntry {
  const minutes = Math.max(0, Math.round(Number(input.minutes ?? 0)))
  const info = db
    .prepare(
      `INSERT INTO time_entries
        (lead_id, catalog_item_id, entry_date, description, minutes, rate_cents, billable, created_by)
       VALUES
        (@lead_id, @catalog_item_id, @entry_date, @description, @minutes, @rate_cents, @billable, @created_by)`,
    )
    .run({
      lead_id: input.lead_id != null ? Number(input.lead_id) : null,
      catalog_item_id: input.catalog_item_id != null ? Number(input.catalog_item_id) : null,
      entry_date: input.entry_date || new Date().toISOString().slice(0, 10),
      description: input.description ?? null,
      minutes,
      rate_cents: Math.round(Number(input.rate_cents ?? 0)),
      billable: bool(input.billable, 1),
      created_by: createdBy ?? null,
    })
  return getTimeEntry(Number(info.lastInsertRowid))!
}

const EDITABLE_COLS = new Set([
  'lead_id', 'catalog_item_id', 'entry_date', 'description', 'minutes', 'rate_cents', 'billable',
])

export function updateTimeEntry(id: number, patch: TimeEntryInput): TimeEntry | null {
  const cur = getTimeEntry(id)
  if (!cur) return null
  // An already-invoiced entry is locked (it's part of a document's totals).
  if (cur.document_id) throw new Error('Abgerechnete Zeiteinträge können nicht mehr geändert werden.')
  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_COLS.has(key)) continue
    let v: string | number | null
    if (key === 'billable') v = value ? 1 : 0
    else if (key === 'minutes') v = Math.max(0, Math.round(Number(value ?? 0)))
    else if (key === 'rate_cents') v = Math.round(Number(value ?? 0))
    else if (typeof value === 'boolean') v = value ? 1 : 0
    else v = (value as string | number | null) ?? null
    sets.push(`${key} = @${key}`)
    params[key] = v
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE time_entries SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return getTimeEntry(id)
}

export function deleteTimeEntry(id: number): { ok: boolean; reason?: string } {
  const cur = getTimeEntry(id)
  if (!cur) return { ok: false, reason: 'not found' }
  if (cur.document_id) return { ok: false, reason: 'invoiced' }
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(id)
  return { ok: true }
}

/** German date for the invoice line, DD.MM.YYYY. */
function deDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

/**
 * Pull a set of billable, not-yet-invoiced entries into a new *draft* Rechnung —
 * one line per entry (hours × rate). Stamps each entry with the new document_id +
 * invoiced_at so it cannot be billed again. All-or-nothing in one transaction.
 * Returns the draft, or throws when no eligible entries are given.
 */
export function invoiceTimeEntries(entryIds: number[]): FullDocument {
  return tx(() => {
    const ids = [...new Set(entryIds.map(Number).filter((n) => Number.isFinite(n)))]
    if (ids.length === 0) throw new Error('Keine Zeiteinträge ausgewählt.')
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT * FROM time_entries
          WHERE id IN (${placeholders}) AND billable = 1 AND document_id IS NULL
          ORDER BY entry_date, id`,
      )
      .all(...ids) as unknown as TimeEntryRow[]
    if (rows.length === 0) throw new Error('Keine abrechenbaren, offenen Zeiteinträge gefunden.')

    const s = getSettings()
    // Prefill the client from the lead when every entry shares the same one.
    const leadIds = new Set(rows.map((r) => r.lead_id).filter((x): x is number => x != null))
    let lead: LeadRow | undefined
    if (leadIds.size === 1) {
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get([...leadIds][0]) as unknown as LeadRow | undefined
    }

    const info = db
      .prepare(
        `INSERT INTO documents
          (kind, lead_id, client_name, client_city, client_email, client_type, title, intro,
           small_business, vat_rate)
         VALUES
          ('rechnung', @lead_id, @client_name, @client_city, @client_email, 'geschaeft', @title, @intro,
           @small_business, @vat_rate)`,
      )
      .run({
        lead_id: lead?.id ?? null,
        client_name: lead?.company ?? null,
        client_city: lead?.city ?? null,
        client_email: lead?.email ?? null,
        title: 'Rechnung (Zeitaufwand)',
        intro: 'Abrechnung der erbrachten Leistungen nach Zeitaufwand:',
        small_business: s.small_business,
        vat_rate: s.vat_rate,
      })
    const docId = Number(info.lastInsertRowid)

    // Insert line items inline (not via replaceItems) so the whole operation stays
    // in this single transaction — a nested BEGIN would error.
    const ins = db.prepare(
      `INSERT INTO document_items (document_id, description, quantity, unit, unit_price_cents, sort)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    rows.forEach((r, i) => {
      ins.run(
        docId,
        `${r.description ?? 'Leistung'} (${deDate(r.entry_date)})`,
        Math.round((r.minutes / 60) * 100) / 100, // hours, 2 decimals
        'Std',
        r.rate_cents,
        i,
      )
    })

    const stamp = db.prepare(
      "UPDATE time_entries SET document_id = ?, invoiced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    )
    for (const r of rows) stamp.run(docId, r.id)

    return getDocument(docId)!
  })
}
