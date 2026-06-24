import PDFDocument from 'pdfkit'
import { fileURLToPath } from 'node:url'
import { CONTRACT_TYPES, type SettingsRow } from './db'
import type { FullContract } from './contracts'

// Reuse the invoice letterhead/footer look. Fonts shipped under api/assets so €,
// German umlauts and § render (no standard-14 fonts).
const FONT_REGULAR = fileURLToPath(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url))
const FONT_BOLD = fileURLToPath(new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url))

function euro(cents: number): string {
  const s = (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${s} €`
}

function date(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

const ACCENT = '#1f7a8c'
const MUTED = '#6b7785'
const TEXT = '#1c2733'
const LINE = '#e2e6ea'

function typeLabel(type: string): string {
  return CONTRACT_TYPES.find((t) => t.id === type)?.label ?? 'Vertrag'
}

/**
 * Render a contract to a PDF Buffer, mirroring the invoice design. Contracts can
 * run long (the AGB are appended in full), so text flows and paginates; the
 * footer + page numbers are stamped onto every page at the end via buffered pages.
 */
export function renderContractPdf(contract: FullContract, s: SettingsRow): Promise<Buffer> {
  const heading = typeLabel(contract.type)

  const pdf = new PDFDocument({
    size: 'A4',
    margin: 50,
    bufferPages: true, // stamp the footer onto every page at the end
    info: {
      Title: `${heading} ${contract.number ?? ''}`.trim(),
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
  const bottom = pdf.page.height - pdf.page.margins.bottom - 24 // leave room for the footer

  // Start a fresh section heading on a new page if too little space remains.
  function ensureSpace(needed: number) {
    if (pdf.y + needed > bottom) pdf.addPage()
  }
  function heuristicHeading(text: string) {
    ensureSpace(40)
    pdf.font('Bold').fontSize(11).fillColor(TEXT).text(text, left, pdf.y, { width })
    pdf.moveDown(0.3)
  }
  function para(text: string, opts: { color?: string; size?: number } = {}) {
    pdf.font('Body').fontSize(opts.size ?? 10).fillColor(opts.color ?? TEXT).text(text, left, pdf.y, {
      width,
      align: 'left',
    })
    pdf.moveDown(0.6)
  }

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
    [s.business_name, s.address, [s.zip, s.city].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
    left,
    y,
    { width: width * 0.6 },
  )
  y += 16
  pdf.fontSize(11).fillColor(TEXT).font('Body')
  const recipient = [
    contract.client_name,
    contract.client_address,
    [contract.client_zip, contract.client_city].filter(Boolean).join(' '),
  ].filter(Boolean) as string[]
  pdf.text(recipient.length ? recipient.join('\n') : '—', left, y, { width: width * 0.6 })

  // --- meta block (right): number + date ---
  const metaRows: [string, string][] = [
    ['Vertrags-Nr.', contract.number ?? '(Entwurf)'],
    ['Datum', date(contract.issue_date) || date(new Date().toISOString().slice(0, 10))],
  ]
  pdf.fontSize(9)
  let my = 150
  for (const [k, v] of metaRows) {
    pdf.fillColor(MUTED).font('Body').text(k, right - 200, my, { width: 100, align: 'left' })
    pdf.fillColor(TEXT).font('Bold').text(v, right - 100, my, { width: 100, align: 'right' })
    my += 15
  }

  // --- title ---
  y = 250
  pdf.fontSize(18).fillColor(TEXT).font('Bold')
  pdf.text(contract.title || heading, left, y, { width })
  pdf.moveDown(0.5)

  // --- parties ---
  const businessLine = [
    s.business_name,
    s.owner ? `vertreten durch ${s.owner}` : null,
    s.address,
    [s.zip, s.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ')
  const clientLine =
    [
      contract.client_name,
      contract.client_address,
      [contract.client_zip, contract.client_city].filter(Boolean).join(' '),
    ]
      .filter(Boolean)
      .join(', ') || '—'
  para('Zwischen', { color: MUTED, size: 9 })
  para(`${businessLine || '—'}\n– nachfolgend „Auftragnehmer" –`)
  para('und', { color: MUTED, size: 9 })
  para(`${clientLine}\n– nachfolgend „Auftraggeber" –`)
  para(`wird der folgende ${heading} geschlossen:`)

  // --- numbered sections (only those with content) ---
  let n = 0
  if (contract.intro && contract.intro.trim()) {
    heuristicHeading(`§ ${++n} Präambel`)
    para(contract.intro.trim())
  }
  if (contract.body && contract.body.trim()) {
    heuristicHeading(`§ ${++n} Vertragsgegenstand`)
    para(contract.body.trim())
  }
  // Vergütung — always shown when a value or terms exist.
  if (contract.value_cents > 0 || (contract.payment_terms && contract.payment_terms.trim())) {
    heuristicHeading(`§ ${++n} Vergütung`)
    if (contract.value_cents > 0) {
      if (contract.small_business) {
        para(`Die Vergütung beträgt ${euro(contract.totals.net_cents)}. Gemäß § 19 UStG (Kleinunternehmerregelung) wird keine Umsatzsteuer berechnet.`)
      } else {
        para(
          `Die Vergütung beträgt ${euro(contract.totals.net_cents)} netto zzgl. ${contract.vat_rate}% USt. ` +
            `(${euro(contract.totals.vat_cents)}), insgesamt ${euro(contract.totals.gross_cents)} brutto.`,
        )
      }
    }
    if (contract.payment_terms && contract.payment_terms.trim()) para(contract.payment_terms.trim())
  }
  // Laufzeit.
  if (contract.start_date || contract.end_date || (contract.notice_period && contract.notice_period.trim())) {
    heuristicHeading(`§ ${++n} Laufzeit & Kündigung`)
    const parts: string[] = []
    if (contract.start_date && contract.end_date) {
      parts.push(`Der Vertrag läuft vom ${date(contract.start_date)} bis zum ${date(contract.end_date)}.`)
    } else if (contract.start_date) {
      parts.push(`Der Vertrag beginnt am ${date(contract.start_date)} und läuft auf unbestimmte Zeit.`)
    } else if (contract.end_date) {
      parts.push(`Der Vertrag endet am ${date(contract.end_date)}.`)
    }
    if (contract.notice_period && contract.notice_period.trim()) {
      parts.push(`Kündigungsfrist: ${contract.notice_period.trim()}.`)
    }
    para(parts.join(' '))
  }

  // --- AGB (incorporated terms) ---
  const agb = contract.agb_text ?? s.agb_text
  if (agb && agb.trim()) {
    heuristicHeading(`§ ${++n} Allgemeine Geschäftsbedingungen`)
    para(
      'Es gelten die nachfolgenden Allgemeinen Geschäftsbedingungen (AGB). Mit der Unterzeichnung ' +
        'erkennt der Auftraggeber diese als verbindlichen Vertragsbestandteil an.',
      { color: MUTED, size: 9 },
    )
    para(agb.trim(), { size: 9 })
  }

  // --- signature block (keep together on one page) ---
  ensureSpace(120)
  pdf.moveDown(1)
  const sigY = pdf.y
  const colW = (width - 30) / 2
  const placeDate = (city: string | null, when: string | null) =>
    `${city ? city + ', ' : ''}${when ? date(when) : 'den ____________'}`
  // Auftraggeber (client)
  pdf.font('Body').fontSize(9).fillColor(TEXT)
  pdf.text(placeDate(contract.client_city, contract.signed_at), left, sigY, { width: colW })
  pdf.moveTo(left, sigY + 34).lineTo(left + colW, sigY + 34).strokeColor(LINE).stroke()
  pdf.fillColor(MUTED).fontSize(8).text(
    `Auftraggeber${contract.signed_by ? ` — ${contract.signed_by}` : ''}\n${contract.client_name ?? ''}`,
    left,
    sigY + 38,
    { width: colW },
  )
  // Auftragnehmer (business)
  const rx = left + colW + 30
  pdf.font('Body').fontSize(9).fillColor(TEXT)
  pdf.text(placeDate(s.city, contract.issue_date), rx, sigY, { width: colW })
  pdf.moveTo(rx, sigY + 34).lineTo(rx + colW, sigY + 34).strokeColor(LINE).stroke()
  pdf.fillColor(MUTED).fontSize(8).text(
    `Auftragnehmer\n${s.owner || s.business_name || ''}`,
    rx,
    sigY + 38,
    { width: colW },
  )

  // --- footer + page numbers on every page (buffered) ---
  const footerParts = [
    s.business_name,
    s.iban ? `IBAN ${s.iban}` : null,
    s.tax_id ? `St.-Nr. ${s.tax_id}` : null,
    s.website,
  ].filter(Boolean) as string[]
  const range = pdf.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i)
    const footY = pdf.page.height - 60
    pdf.rect(left, footY - 8, width, 0.5).fill(LINE)
    pdf.font('Body').fontSize(8).fillColor(MUTED)
    pdf.text(footerParts.join('  ·  '), left, footY, { width, align: 'center' })
    pdf.text(`Seite ${i - range.start + 1} / ${range.count}`, left, footY + 11, { width, align: 'center' })
  }

  pdf.end()
  return done
}

/** A filesystem-safe filename, e.g. "Vertrag_V-2026-0007.pdf". */
export function contractPdfFilename(contract: FullContract): string {
  const id = (contract.number ?? `Entwurf-${contract.id}`).replace(/[^\w-]/g, '_')
  return `Vertrag_${id}.pdf`
}
