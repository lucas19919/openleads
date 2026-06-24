import { createHash } from 'node:crypto'
import { db, type BankTransactionRow, type DocumentRow } from './db'
import { getDocument, type FullDocument } from './documents'
import { addPayment } from './payments'

// Bankabgleich: import a bank statement — CAMT.053 (ISO 20022 XML) or MT940 (SWIFT
// fixed-format), auto-detected — match incoming credits to open invoices by the
// invoice number in the Verwendungszweck (or, as a fallback, a unique exact amount),
// and record the payments. Dependency-light: both formats are parsed by hand (the
// codebase ships no XML library, like facturx.ts which builds CII by hand).
// Re-importing the same statement is idempotent via ext_ref.

export interface BankEntry {
  ext_ref: string
  booked_on: string | null
  amount_cents: number
  direction: 'credit' | 'debit'
  remittance: string
  counterparty: string | null
}

export interface MatchSuggestion {
  document_id: number
  number: string | null
  client_name: string | null
  outstanding_cents: number
  reason: 'number' | 'amount'
  amount_ok: boolean // entry amount equals the invoice's open amount
}

export interface PreviewEntry extends BankEntry {
  already_seen: boolean
  suggestion: MatchSuggestion | null
}

// --- tiny XML helpers (namespace-prefix tolerant) ---------------------------

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .trim()
}

/** First inner text of <Tag>…</Tag> within `block` (optional ns prefix), or null. */
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'))
  return m ? decodeXml(m[1]) : null
}

/** All inner texts of repeated <Tag>…</Tag> within `block`. */
function tagAll(block: string, name: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) out.push(decodeXml(m[1]))
  return out
}

/** Parse an ISO 20022 decimal amount ("1234.56") into integer cents. */
function amountToCents(raw: string | null): number {
  if (!raw) return 0
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/**
 * Parse a CAMT.053 document into booked entries. Tolerant of namespace prefixes
 * and multiple TxDtls per entry. Unbooked (pending) entries are ignored.
 */
export function parseCamt053(xml: string): BankEntry[] {
  const entries: BankEntry[] = []
  const ntryRe = /<(?:\w+:)?Ntry(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Ntry>/gi
  let m: RegExpExecArray | null
  while ((m = ntryRe.exec(xml))) {
    const block = m[1]
    const status = tag(block, 'Sts') ?? ''
    // Skip non-booked entries (PDNG/INFO). Some banks nest <Sts><Cd>BOOK</Cd>.
    const statusText = (status.match(/[A-Z]{3,4}/)?.[0] ?? status).toUpperCase()
    if (statusText && statusText !== 'BOOK') continue

    const amount_cents = amountToCents(tag(block, 'Amt'))
    if (amount_cents <= 0) continue
    const cd = (tag(block, 'CdtDbtInd') ?? 'CRDT').toUpperCase()
    const direction: 'credit' | 'debit' = cd.startsWith('DBIT') ? 'debit' : 'credit'

    // Date: prefer booking date, fall back to value date.
    const bookg = block.match(/<(?:\w+:)?BookgDt(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?BookgDt>/i)?.[1]
    const valdt = block.match(/<(?:\w+:)?ValDt(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?ValDt>/i)?.[1]
    const booked_on = (bookg && tag(bookg, 'Dt')) || (valdt && tag(valdt, 'Dt')) || null

    const remittance = tagAll(block, 'Ustrd').join(' ').replace(/\s+/g, ' ').trim()

    // Counterparty: for a credit the payer is the Debtor; for a debit the Creditor.
    const partyTag = direction === 'credit' ? 'Dbtr' : 'Cdtr'
    const partyBlock = block.match(new RegExp(`<(?:\\w+:)?${partyTag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${partyTag}>`, 'i'))?.[1]
    const counterparty = partyBlock ? tag(partyBlock, 'Nm') : null

    const acctRef = tag(block, 'AcctSvcrRef') || tag(block, 'NtryRef')
    const ext_ref =
      acctRef ||
      'h:' + createHash('sha256').update(`${booked_on}|${amount_cents}|${direction}|${remittance}`).digest('hex').slice(0, 24)

    entries.push({ ext_ref, booked_on, amount_cents, direction, remittance, counterparty })
  }
  return entries
}

// --- MT940 (SWIFT fixed-format statement) -----------------------------------
// The older German bank-statement format. A booked transaction is a `:61:` line
// (value date, debit/credit mark, amount) followed by a `:86:` block (the
// Verwendungszweck + counterparty, often as ?NN subfields). Conservative on the
// credit/debit mark: only a plain `C` counts as an incoming credit, so reversals
// (RC/RD) never auto-create a payment.

function parse86(info: string): { remittance: string; counterparty: string } {
  if (info.includes('?')) {
    const fields: Record<string, string> = {}
    const re = /\?(\d{2})([^?]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(info))) fields[m[1]] = (fields[m[1]] ?? '') + m[2]
    const purpose: string[] = []
    for (let i = 20; i <= 29; i++) if (fields[String(i)]) purpose.push(fields[String(i)])
    for (let i = 60; i <= 63; i++) if (fields[String(i)]) purpose.push(fields[String(i)])
    const name = [fields['32'], fields['33']].filter(Boolean).join('')
    return { remittance: purpose.join(' ').replace(/\s+/g, ' ').trim(), counterparty: name.trim() || '' }
  }
  return { remittance: info.replace(/\s+/g, ' ').trim(), counterparty: '' }
}

function parse61(l61: string, info86: string): BankEntry | null {
  const m = l61.match(/^(\d{6})(\d{4})?(RC|RD|C|D)[A-Z]?([\d.,]+)/)
  if (!m) return null
  const vdate = m[1]
  const mark = m[3]
  const amount_cents = Math.round(Number(m[4].replace(/\./g, '').replace(',', '.')) * 100)
  if (!(amount_cents > 0)) return null
  const direction: 'credit' | 'debit' = mark === 'C' ? 'credit' : 'debit'
  const booked_on = `20${vdate.slice(0, 2)}-${vdate.slice(2, 4)}-${vdate.slice(4, 6)}`
  const { remittance, counterparty } = parse86(info86)
  const bankRef = l61.match(/\/\/(\S+)/)?.[1] ?? null
  const ext_ref =
    bankRef ||
    'm:' + createHash('sha256').update(`${booked_on}|${amount_cents}|${direction}|${remittance}`).digest('hex').slice(0, 24)
  return { ext_ref, booked_on, amount_cents, direction, remittance, counterparty: counterparty || null }
}

export function parseMt940(text: string): BankEntry[] {
  const entries: BankEntry[] = []
  let cur: { l61: string; l86: string[] } | null = null
  let inInfo = false
  const flush = () => {
    if (cur) {
      const e = parse61(cur.l61, cur.l86.join('\n'))
      if (e) entries.push(e)
    }
    cur = null
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^:61:/.test(line)) {
      flush()
      cur = { l61: line.slice(4).trim(), l86: [] }
      inInfo = false
    } else if (/^:86:/.test(line)) {
      if (cur) cur.l86.push(line.slice(4))
      inInfo = true
    } else if (/^:[0-9A-Z]{2,3}:/.test(line)) {
      inInfo = false // another field (e.g. :62F:) ends the :86: block
    } else if (inInfo && cur) {
      cur.l86.push(line) // continuation of :86:
    }
  }
  flush()
  return entries
}

/** Detect the statement format and parse to the common BankEntry shape. */
export function parseStatement(text: string): BankEntry[] {
  if (/<(?:\w+:)?Ntry[\s>]/i.test(text)) return parseCamt053(text)
  if (/(^|\n)\s*:61:/.test(text)) return parseMt940(text)
  return []
}

// --- matching ---------------------------------------------------------------

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

interface OpenInvoice {
  id: number
  number: string | null
  client_name: string | null
  outstanding_cents: number
}

/** Issued, non-storniert invoices that still owe money. */
export function openInvoices(): OpenInvoice[] {
  const rows = db
    .prepare(
      "SELECT id FROM documents WHERE kind = 'rechnung' AND number IS NOT NULL AND status != 'storniert'",
    )
    .all() as unknown as { id: number }[]
  const out: OpenInvoice[] = []
  for (const r of rows) {
    const doc = getDocument(r.id)
    if (!doc) continue
    const outstanding = doc.totals.gross_cents - doc.paid_cents
    if (outstanding > 0) out.push({ id: doc.id, number: doc.number, client_name: doc.client_name, outstanding_cents: outstanding })
  }
  return out
}

/** Suggest a match for a single credit entry against the open invoices. */
export function suggestMatch(entry: BankEntry, open: OpenInvoice[]): MatchSuggestion | null {
  if (entry.direction !== 'credit') return null
  const haystack = normalize(entry.remittance)
  // 1) Invoice number found in the Verwendungszweck — the strong signal.
  const byNumber = open.filter((inv) => inv.number && haystack.includes(normalize(inv.number)))
  if (byNumber.length === 1) {
    const inv = byNumber[0]
    return { document_id: inv.id, number: inv.number, client_name: inv.client_name, outstanding_cents: inv.outstanding_cents, reason: 'number', amount_ok: inv.outstanding_cents === entry.amount_cents }
  }
  if (byNumber.length > 1) {
    // Multiple invoice numbers referenced — prefer the one whose open amount matches.
    const exact = byNumber.find((inv) => inv.outstanding_cents === entry.amount_cents)
    if (exact) return { document_id: exact.id, number: exact.number, client_name: exact.client_name, outstanding_cents: exact.outstanding_cents, reason: 'number', amount_ok: true }
  }
  // 2) Fallback: a single open invoice whose open amount equals the credit exactly.
  const byAmount = open.filter((inv) => inv.outstanding_cents === entry.amount_cents)
  if (byAmount.length === 1) {
    const inv = byAmount[0]
    return { document_id: inv.id, number: inv.number, client_name: inv.client_name, outstanding_cents: inv.outstanding_cents, reason: 'amount', amount_ok: true }
  }
  return null
}

const seen = (ref: string): boolean =>
  !!(db.prepare('SELECT 1 FROM bank_transactions WHERE ext_ref = ?').get(ref) as unknown)

/** Parse (CAMT.053 or MT940, auto-detected) + dedupe + suggest. Writes nothing. */
export function previewStatement(text: string): {
  entries: PreviewEntry[]
  open_invoices: OpenInvoice[]
  total: number
  credits: number
  new_count: number
} {
  const parsed = parseStatement(text)
  const open = openInvoices()
  const entries: PreviewEntry[] = parsed.map((e) => ({
    ...e,
    already_seen: seen(e.ext_ref),
    suggestion: suggestMatch(e, open),
  }))
  return {
    entries,
    open_invoices: open,
    total: entries.length,
    credits: entries.filter((e) => e.direction === 'credit').length,
    new_count: entries.filter((e) => !e.already_seen).length,
  }
}

export interface ApplyItem {
  ext_ref: string
  booked_on?: string | null
  amount_cents: number
  direction?: string
  remittance?: string | null
  counterparty?: string | null
  document_id?: number | null // record a payment against this invoice
  ignore?: boolean // file the entry without a payment
}

export interface ApplyResult {
  applied: number
  matched: number
  ignored: number
  skipped: number // already imported (idempotent)
  payments: { ext_ref: string; document_id: number; payment_id: number }[]
}

/**
 * Persist confirmed entries. For a matched credit a payment is recorded against
 * the invoice (which reconciles its status); the bank row is inserted with the
 * link. Idempotent: an ext_ref already on file is skipped.
 */
export function applyMatches(items: ApplyItem[]): ApplyResult {
  const res: ApplyResult = { applied: 0, matched: 0, ignored: 0, skipped: 0, payments: [] }
  const ins = db.prepare(
    `INSERT INTO bank_transactions (ext_ref, booked_on, amount_cents, direction, remittance, counterparty, document_id, payment_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const it of items) {
    if (!it.ext_ref || seen(it.ext_ref)) {
      res.skipped++
      continue
    }
    let documentId: number | null = null
    let paymentId: number | null = null
    let status: 'matched' | 'unmatched' | 'ignored' = 'unmatched'

    if (it.document_id != null) {
      const doc = db.prepare('SELECT id, kind, number FROM documents WHERE id = ?').get(Number(it.document_id)) as unknown as
        | Pick<DocumentRow, 'id' | 'kind' | 'number'>
        | undefined
      if (doc && doc.kind === 'rechnung' && doc.number) {
        const payment = addPayment(doc.id, {
          amount_cents: it.amount_cents,
          paid_on: it.booked_on ?? null,
          method: 'Bank (CAMT)',
          note: (it.remittance ?? '').slice(0, 200) || null,
        })
        documentId = doc.id
        paymentId = payment.id
        status = 'matched'
        res.matched++
        res.payments.push({ ext_ref: it.ext_ref, document_id: doc.id, payment_id: payment.id })
      }
    } else if (it.ignore) {
      status = 'ignored'
      res.ignored++
    }

    ins.run(
      it.ext_ref,
      it.booked_on ?? null,
      Math.round(it.amount_cents),
      it.direction === 'debit' ? 'debit' : 'credit',
      it.remittance ?? null,
      it.counterparty ?? null,
      documentId,
      paymentId,
      status,
    )
    res.applied++
  }
  return res
}

export function listBankTransactions(limit = 100): BankTransactionRow[] {
  return db
    .prepare('SELECT * FROM bank_transactions ORDER BY booked_on DESC, id DESC LIMIT ?')
    .all(Math.min(limit, 500)) as unknown as BankTransactionRow[]
}
