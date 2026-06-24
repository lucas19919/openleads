import PDFDocument from 'pdfkit'
import { fileURLToPath } from 'node:url'
import type { FullDocument } from './documents'
import type { SettingsRow } from './db'
import { buildFacturXXml, FACTURX_XMP, FACTURX_FILENAME } from './facturx'

// Embedded TTFs (PDF/A forbids the non-embedded standard-14 fonts). DejaVu
// covers €, German umlauts and §. Shipped under api/assets so the image has them.
const FONT_REGULAR = fileURLToPath(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url))
const FONT_BOLD = fileURLToPath(new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url))

// German money/date formatting. Money is integer cents.
function euro(cents: number): string {
  const s = (cents / 100).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${s} €`
}

function qty(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 2 })
}

function date(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

const ACCENT = '#1f7a8c' // OpenLeads teal-blue
const MUTED = '#6b7785'
const TEXT = '#1c2733'
const LINE = '#e2e6ea'

/**
 * Render a document (Angebot/Rechnung) to a PDF/A-3 Buffer. A finalised
 * Rechnung also gets the embedded Factur-X/ZUGFeRD XML → a valid e-invoice.
 */
export function renderDocumentPdf(doc: FullDocument, s: SettingsRow): Promise<Buffer> {
  const isInvoice = doc.kind === 'rechnung'
  const heading = isInvoice ? 'Rechnung' : 'Angebot'
  // ZUGFeRD only applies to a finalised invoice (needs a number + issue date).
  const embedZugferd = isInvoice && !!doc.number

  const pdf = new PDFDocument({
    size: 'A4',
    margin: 50,
    pdfVersion: '1.7',
    subset: 'PDF/A-3b',
    tagged: true,
    lang: 'de-DE',
    info: {
      Title: `${heading} ${doc.number ?? ''}`.trim(),
      Author: s.business_name ?? 'OpenLeads',
      Creator: 'OpenLeads',
    },
  })
  pdf.registerFont('Body', FONT_REGULAR)
  pdf.registerFont('Bold', FONT_BOLD)
  pdf.font('Body')

  const chunks: Buffer[] = []
  pdf.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
  })

  const left = pdf.page.margins.left
  const right = pdf.page.width - pdf.page.margins.right
  const width = right - left

  // --- letterhead (sender, top-right) ---
  pdf.fontSize(16).fillColor(ACCENT).font('Bold')
  pdf.text(s.business_name || 'OpenLeads', left, 50, { width, align: 'right' })
  pdf.font('Body').fontSize(9).fillColor(MUTED)
  const senderLines = [
    s.owner,
    s.address ?? '',
    [s.zip, s.city].filter(Boolean).join(' '),
    s.email,
    s.phone,
    s.tax_id ? `Steuernr./USt-IdNr.: ${s.tax_id}` : null,
  ].filter(Boolean) as string[]
  pdf.text(senderLines.join('\n'), left, 72, { width, align: 'right' })

  // --- recipient block (left) ---
  let y = 150
  pdf.fontSize(8).fillColor(MUTED).font('Body')
  pdf.text(
    [s.business_name, s.address, [s.zip, s.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(' · '),
    left,
    y,
    { width: width * 0.6 },
  )
  y += 16
  pdf.fontSize(11).fillColor(TEXT).font('Body')
  const recipient = [
    doc.client_name,
    doc.client_address,
    [doc.client_zip, doc.client_city].filter(Boolean).join(' '),
  ].filter(Boolean) as string[]
  pdf.text(recipient.length ? recipient.join('\n') : '—', left, y, { width: width * 0.6 })

  // --- meta block (right): number + dates ---
  const metaTop = 150
  const metaRows: [string, string][] = [
    [`${heading}-Nr.`, doc.number ?? '(Entwurf)'],
    ['Datum', date(doc.issue_date) || date(new Date().toISOString().slice(0, 10))],
  ]
  if (isInvoice && doc.due_date) metaRows.push(['Fällig bis', date(doc.due_date)])
  pdf.fontSize(9)
  let my = metaTop
  for (const [k, v] of metaRows) {
    pdf.fillColor(MUTED).font('Body').text(k, right - 200, my, { width: 100, align: 'left' })
    pdf.fillColor(TEXT).font('Bold').text(v, right - 100, my, { width: 100, align: 'right' })
    my += 15
  }

  // --- title ---
  y = 240
  pdf.fontSize(18).fillColor(TEXT).font('Bold')
  pdf.text(doc.title || heading, left, y)
  y = pdf.y + 6

  // --- intro ---
  if (doc.intro) {
    pdf.fontSize(10).fillColor(TEXT).font('Body').text(doc.intro, left, y, { width })
    y = pdf.y + 14
  }

  // --- items table ---
  const cols = {
    pos: left,
    desc: left + 30,
    qty: left + width - 230,
    unit: left + width - 180,
    price: left + width - 130,
    total: left + width - 70,
  }
  function row(
    pos: string,
    desc: string,
    quantity: string,
    unit: string,
    price: string,
    total: string,
    opts: { head?: boolean } = {},
  ) {
    const font = opts.head ? 'Bold' : 'Body'
    const color = opts.head ? MUTED : TEXT
    pdf.font(font).fontSize(9).fillColor(color)
    const top = y
    pdf.text(pos, cols.pos, top, { width: 24 })
    pdf.text(desc, cols.desc, top, { width: cols.qty - cols.desc - 8 })
    const descBottom = pdf.y
    pdf.text(quantity, cols.qty, top, { width: 44, align: 'right' })
    pdf.text(unit, cols.unit, top, { width: 44, align: 'left' })
    pdf.text(price, cols.price, top, { width: 56, align: 'right' })
    pdf.text(total, cols.total, top, { width: 70, align: 'right' })
    y = Math.max(descBottom, top + 12) + 6
  }

  pdf.rect(left, y - 4, width, 0.5).fill(LINE)
  y += 4
  row('Pos', 'Beschreibung', 'Menge', 'Einh.', 'Einzel', 'Gesamt', { head: true })
  pdf.rect(left, y - 2, width, 0.5).fill(LINE)
  y += 4

  doc.items.forEach((it, i) => {
    row(
      String(i + 1),
      it.description ?? '',
      qty(it.quantity),
      it.unit ?? '',
      euro(it.unit_price_cents),
      euro(Math.round(it.quantity * it.unit_price_cents)),
    )
  })
  if (doc.items.length === 0) {
    pdf.font('Body').fontSize(9).fillColor(MUTED).text('(keine Positionen)', cols.desc, y)
    y += 18
  }

  pdf.rect(left, y, width, 0.5).fill(LINE)
  y += 10

  // --- totals (right-aligned) ---
  const tLabel = right - 230
  const tVal = right - 90
  function totalLine(label: string, value: string, opts: { bold?: boolean } = {}) {
    pdf.font(opts.bold ? 'Bold' : 'Body').fontSize(opts.bold ? 11 : 9)
    pdf.fillColor(opts.bold ? TEXT : MUTED).text(label, tLabel, y, { width: 130, align: 'right' })
    pdf.fillColor(TEXT).text(value, tVal, y, { width: 90, align: 'right' })
    y += opts.bold ? 18 : 14
  }
  if (doc.small_business) {
    totalLine('Gesamtbetrag', euro(doc.totals.gross_cents), { bold: true })
  } else {
    totalLine('Nettobetrag', euro(doc.totals.net_cents))
    totalLine(`zzgl. ${doc.vat_rate}% USt.`, euro(doc.totals.vat_cents))
    totalLine('Gesamtbetrag', euro(doc.totals.gross_cents), { bold: true })
  }
  y += 8

  // --- §19 notice ---
  if (doc.small_business) {
    pdf.font('Body').fontSize(9).fillColor(MUTED)
    pdf.text(
      'Gemäß § 19 UStG (Kleinunternehmerregelung) wird keine Umsatzsteuer berechnet.',
      left,
      y,
      { width },
    )
    y = pdf.y + 10
  }

  // --- notes / payment terms ---
  if (doc.notes) {
    pdf.font('Body').fontSize(9).fillColor(TEXT).text(doc.notes, left, y, { width })
    y = pdf.y + 8
  }
  if (isInvoice) {
    const pay = s.iban
      ? `Bitte überweise den Gesamtbetrag${doc.due_date ? ` bis zum ${date(doc.due_date)}` : ''} auf:\n` +
        [s.bank, s.iban ? `IBAN: ${s.iban}` : null, s.bic ? `BIC: ${s.bic}` : null]
          .filter(Boolean)
          .join('   ')
      : ''
    if (pay) {
      pdf.font('Body').fontSize(9).fillColor(MUTED).text(pay, left, y, { width })
    }
  } else {
    pdf.font('Body').fontSize(9).fillColor(MUTED)
    pdf.text('Wir freuen uns auf die Zusammenarbeit. Dieses Angebot ist 30 Tage gültig.', left, y, {
      width,
    })
  }

  // --- footer ---
  const footY = pdf.page.height - 70
  pdf.rect(left, footY - 8, width, 0.5).fill(LINE)
  pdf.font('Body').fontSize(8).fillColor(MUTED)
  const footerParts = [
    s.business_name,
    s.iban ? `IBAN ${s.iban}` : null,
    s.tax_id ? `St.-Nr. ${s.tax_id}` : null,
    s.website,
    embedZugferd ? 'ZUGFeRD / Factur-X (EN 16931)' : null,
  ].filter(Boolean) as string[]
  pdf.text(footerParts.join('  ·  '), left, footY, { width, align: 'center' })

  // --- AGB appendix (optional) ---
  // When enabled, the operator's terms travel with every offer/invoice as a final
  // page. Uses the embedded fonts, so it's fine under PDF/A-3, and is appended
  // AFTER the footer/body so the invoice page is untouched. The ZUGFeRD XML (added
  // below) is unaffected — it's a file attachment, not page content.
  if (s.agb_attach_documents && s.agb_text && s.agb_text.trim()) {
    pdf.addPage()
    pdf.font('Bold').fontSize(13).fillColor(TEXT).text('Allgemeine Geschäftsbedingungen', left, pdf.page.margins.top, { width })
    pdf.moveDown(0.5)
    pdf.font('Body').fontSize(9).fillColor(TEXT).text(s.agb_text.trim(), { width, align: 'left' })
  }

  // --- embed the Factur-X/ZUGFeRD XML + declare the hybrid in XMP ---
  if (embedZugferd) {
    const xml = buildFacturXXml(doc, s)
    const now = new Date()
    pdf.file(Buffer.from(xml, 'utf8'), {
      name: FACTURX_FILENAME,
      type: 'text/xml',
      description: 'Factur-X/ZUGFeRD EN 16931 invoice',
      creationDate: now,
      modifiedDate: now,
      // AFRelationship per the Factur-X spec; not in @types/pdfkit yet.
      relationship: 'Alternative',
    } as PDFKit.Mixins.PDFAttachmentOptions)
    pdf.appendXML(FACTURX_XMP)
  }

  pdf.end()
  return done
}

/** A filesystem-safe filename for download, e.g. "Rechnung_RE-2026-0007.pdf". */
export function pdfFilename(doc: FullDocument): string {
  const base = doc.kind === 'rechnung' ? 'Rechnung' : 'Angebot'
  const id = (doc.number ?? `Entwurf-${doc.id}`).replace(/[^\w-]/g, '_')
  return `${base}_${id}.pdf`
}
