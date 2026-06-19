import { db, DOC_KINDS, type DocumentRow, type DocumentItemRow, type SettingsRow } from './db'

export interface DocItemInput {
  description?: string | null
  quantity?: number
  unit?: string | null
  unit_price_cents?: number
}

export interface DocTotals {
  net_cents: number
  vat_cents: number
  gross_cents: number
}

export interface FullDocument extends DocumentRow {
  items: DocumentItemRow[]
  totals: DocTotals
}

export function getSettings(): SettingsRow {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get() as unknown as SettingsRow
}

// node:sqlite has no .transaction() helper (unlike better-sqlite3) — wrap manually.
function tx<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Net/VAT/gross from line items. §19 (Kleinunternehmer) → no VAT line. */
export function computeTotals(
  items: Pick<DocumentItemRow, 'quantity' | 'unit_price_cents'>[],
  smallBusiness: boolean,
  vatRate: number,
): DocTotals {
  const net_cents = items.reduce(
    (sum, it) => sum + Math.round(it.quantity * it.unit_price_cents),
    0,
  )
  const vat_cents = smallBusiness ? 0 : Math.round((net_cents * vatRate) / 100)
  return { net_cents, vat_cents, gross_cents: net_cents + vat_cents }
}

/** Fetch a document with its sorted items and computed totals, or null. */
export function getDocument(id: number): FullDocument | null {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
    | DocumentRow
    | undefined
  if (!doc) return null
  const items = db
    .prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY sort, id')
    .all(id) as unknown as DocumentItemRow[]
  return {
    ...doc,
    items,
    totals: computeTotals(items, !!doc.small_business, doc.vat_rate),
  }
}

/** Replace all line items of a document in one transaction. */
export function replaceItems(documentId: number, items: DocItemInput[]): void {
  tx(() => {
    db.prepare('DELETE FROM document_items WHERE document_id = ?').run(documentId)
    const ins = db.prepare(
      `INSERT INTO document_items (document_id, description, quantity, unit, unit_price_cents, sort)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    items.forEach((it, i) => {
      ins.run(
        documentId,
        it.description ?? null,
        Number(it.quantity ?? 1),
        it.unit ?? null,
        Math.round(Number(it.unit_price_cents ?? 0)),
        i,
      )
    })
  })
}

/**
 * Assign the next gapless number for a kind and bump the counter, atomically.
 * Format: <PREFIX><YEAR>-<0001>. The counter only ever increases, so the
 * sequence stays gapless even across a year boundary.
 */
export function assignNumber(kind: (typeof DOC_KINDS)[number]): string {
  return tx(() => {
    const s = getSettings()
    const prefix = kind === 'rechnung' ? s.rechnung_prefix : s.angebot_prefix
    const next = kind === 'rechnung' ? s.rechnung_next : s.angebot_next
    const col = kind === 'rechnung' ? 'rechnung_next' : 'angebot_next'
    db.prepare(`UPDATE settings SET ${col} = ? WHERE id = 1`).run(next + 1)
    const year = new Date().getFullYear()
    return `${prefix}${year}-${String(next).padStart(4, '0')}`
  })
}
