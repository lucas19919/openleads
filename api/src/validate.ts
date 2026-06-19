import type { FullDocument } from './documents'
import type { SettingsRow } from './db'
import { buildFacturXXml } from './facturx'

// A pragmatic, dependency-free EN 16931 (Factur-X/ZUGFeRD) validator. It checks
// the business rules that actually bite in practice — presence of mandatory
// terms and arithmetic consistency — plus a few German specifics (§19, USt-Id).
// It is not a full Schematron run, but it catches the errors that make an
// invoice rejected by a buyer's e-invoicing portal before you ever send it.

export interface Finding {
  rule: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  profile: string
  checked_at: string
  errors: Finding[]
  warnings: Finding[]
}

const DE_VAT = /^DE\d{9}$/i

export function validateInvoice(doc: FullDocument, s: SettingsRow): ValidationResult {
  const errors: Finding[] = []
  const warnings: Finding[] = []
  const err = (rule: string, message: string) => errors.push({ rule, message })
  const warn = (rule: string, message: string) => warnings.push({ rule, message })

  if (doc.kind !== 'rechnung') {
    err('OL-KIND', 'Nur Rechnungen sind e-rechnungsfähig (kind muss „rechnung“ sein).')
  }

  // --- mandatory header terms (BR-01..BR-09) ---
  if (!doc.number) err('BR-02', 'Rechnungsnummer fehlt (Dokument ist nicht finalisiert).')
  if (!doc.issue_date) err('BR-03', 'Rechnungsdatum (issue date) fehlt.')
  if (!s.business_name) err('BR-06', 'Name des Verkäufers fehlt (Einstellungen → Firmenname).')
  if (!doc.client_name) err('BR-07', 'Name des Käufers fehlt.')

  // Seller postal address — BR-08 (address line), BR-09 (country implied DE).
  if (!s.address) err('BR-08', 'Anschrift des Verkäufers fehlt.')
  if (!s.city) err('BR-08', 'Ort des Verkäufers fehlt.')
  if (!s.zip) warn('BR-08', 'PLZ des Verkäufers fehlt.')

  // Buyer address is recommended for EN 16931; warn rather than block.
  if (!doc.client_address || !doc.client_city) {
    warn('BR-10', 'Anschrift des Käufers unvollständig (für EN 16931 empfohlen).')
  }

  // --- line items (BR-16) ---
  if (doc.items.length === 0) err('BR-16', 'Rechnung enthält keine Position.')
  doc.items.forEach((it, i) => {
    if (!it.description) warn('BR-25', `Position ${i + 1}: Beschreibung fehlt.`)
    if (!(it.quantity > 0)) warn('OL-QTY', `Position ${i + 1}: Menge sollte > 0 sein.`)
  })

  // --- arithmetic consistency (BR-CO-10..15) ---
  const recomputedNet = doc.items.reduce(
    (sum, it) => sum + Math.round(it.quantity * it.unit_price_cents),
    0,
  )
  if (recomputedNet !== doc.totals.net_cents) {
    err('BR-CO-10', `Summe der Positionen (${recomputedNet}) ≠ Nettobetrag (${doc.totals.net_cents}).`)
  }
  if (doc.totals.net_cents + doc.totals.vat_cents !== doc.totals.gross_cents) {
    err('BR-CO-15', 'Netto + USt ≠ Bruttobetrag (Gesamtsumme inkonsistent).')
  }

  // --- VAT category rules ---
  if (doc.small_business) {
    // Category E (exempt) — §19 UStG.
    if (doc.totals.vat_cents !== 0) {
      err('BR-E-08', 'Kleinunternehmer (§19): es darf keine USt ausgewiesen werden.')
    }
    // BR-E-10 wants an exemption reason — we emit one in the XML; note it here.
  } else {
    // Category S (standard rate).
    if (!(doc.vat_rate > 0)) err('BR-S-05', 'Standard-USt-Satz muss > 0 sein.')
    const expectedVat = Math.round((doc.totals.net_cents * doc.vat_rate) / 100)
    if (expectedVat !== doc.totals.vat_cents) {
      err('BR-S-08', `USt-Betrag inkonsistent: erwartet ${expectedVat}, ist ${doc.totals.vat_cents}.`)
    }
    // BR-CO-26: seller needs a VAT identifier when tax is charged.
    if (!s.tax_id) {
      err('BR-CO-26', 'Bei USt-Ausweis ist eine USt-IdNr./Steuernummer des Verkäufers erforderlich.')
    } else if (!DE_VAT.test(s.tax_id.replace(/\s/g, ''))) {
      warn('OL-VATID', 'Steuer-ID ist keine USt-IdNr. (DE + 9 Ziffern) — wird als Steuernummer geführt.')
    }
  }

  // --- payment terms / means (recommended) ---
  if (!s.iban) warn('BR-CO-25', 'Keine IBAN hinterlegt — Zahlungsempfänger-Konto fehlt im Datensatz.')
  if (doc.due_date && doc.issue_date && doc.due_date < doc.issue_date) {
    err('OL-DUE', 'Fälligkeitsdatum liegt vor dem Rechnungsdatum.')
  }

  // --- the XML must at least build ---
  try {
    const xml = buildFacturXXml(doc, s)
    if (!xml.includes('<rsm:CrossIndustryInvoice')) err('OL-XML', 'CII-XML konnte nicht erzeugt werden.')
  } catch (e) {
    err('OL-XML', `CII-XML-Erzeugung fehlgeschlagen: ${(e as Error).message}`)
  }

  return {
    valid: errors.length === 0,
    profile: 'EN 16931 (urn:cen.eu:en16931:2017)',
    checked_at: new Date().toISOString(),
    errors,
    warnings,
  }
}
