import ExcelJS from 'exceljs'

// Match a spreadsheet header cell to a lead field. Order matters — first hit wins.
const FIELD_RULES: [RegExp, string][] = [
  [/firma|company|firmenname/, 'company'],
  [/gewerk|branche|trade/, 'trade'],
  [/\bort\b|stadt|city|standort/, 'city'],
  [/website|webseite|homepage|url/, 'website'],
  [/telefon|\btel\b|phone|\bfon\b/, 'phone'],
  [/mail/, 'email'],
  [/score/, 'score'],
  [/prio/, 'priority'],
  [/mobil/, 'mobile_friendly'],
  [/technik|plattform|platform|\bcms\b|\btech\b/, 'tech'],
  [/signal|veraltung/, 'staleness_signal'],
  [/warum|grund|pitch/, 'why_lead'],
]

function norm(s: string): string {
  return s.toLowerCase().replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function mapHeader(raw: string): string | null {
  const n = norm(raw)
  if (!n) return null
  for (const [re, field] of FIELD_RULES) if (re.test(n)) return field
  return null
}

function cellStr(value: ExcelJS.CellValue): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    const v = value as { text?: string; hyperlink?: string; result?: unknown }
    if (typeof v.text === 'string') return v.text.trim()
    if (typeof v.hyperlink === 'string') return v.hyperlink.trim()
    if (v.result != null) return String(v.result).trim()
    return ''
  }
  return String(value).trim()
}

function parsePriority(v: string): string | undefined {
  const s = v.toLowerCase()
  if (s.startsWith('hoch') || s === 'high') return 'hoch'
  if (s.startsWith('mittel') || s === 'medium') return 'mittel'
  if (s.startsWith('niedrig') || s === 'low') return 'niedrig'
  return undefined
}

function parseBool(v: string): boolean | undefined {
  const s = v.toLowerCase()
  if (['ja', 'yes', 'true', '1', 'responsive'].includes(s)) return true
  if (['nein', 'no', 'false', '0'].includes(s)) return false
  return undefined
}

export interface ParseResult {
  leads: Record<string, unknown>[]
  headerRow: number
  mapped: string[]
}

/**
 * Parse a worksheet into lead objects. Auto-detects the header row (handles
 * title/subtitle banner rows) by picking the row that maps the most columns.
 */
export function parseWorksheet(ws: ExcelJS.Worksheet): ParseResult {
  let headerRow = 0
  let bestCount = 0
  let colField: Record<number, string> = {}

  const scanTo = Math.min(20, ws.rowCount)
  for (let r = 1; r <= scanTo; r++) {
    const map: Record<number, string> = {}
    let count = 0
    ws.getRow(r).eachCell((cell, col) => {
      const f = mapHeader(cellStr(cell.value))
      if (f && !Object.values(map).includes(f)) {
        map[col] = f
        count++
      }
    })
    if (count > bestCount) {
      bestCount = count
      headerRow = r
      colField = map
    }
  }

  if (headerRow === 0 || bestCount < 2) return { leads: [], headerRow: 0, mapped: [] }

  const leads: Record<string, unknown>[] = []
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const lead: Record<string, unknown> = { source: 'import' }
    for (const [colStr, field] of Object.entries(colField)) {
      const raw = cellStr(row.getCell(Number(colStr)).value)
      if (!raw) continue
      if (field === 'score') lead.score = Number(raw.replace(/[^0-9.-]/g, '')) || 0
      else if (field === 'priority') lead.priority = parsePriority(raw) ?? 'mittel'
      else if (field === 'mobile_friendly') lead.mobile_friendly = parseBool(raw)
      else lead[field] = raw
    }
    if (lead.company || lead.website) leads.push(lead)
  }
  return { leads, headerRow, mapped: [...new Set(Object.values(colField))] }
}

export async function parseWorkbookBuffer(buf: Buffer | ArrayBuffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // @types/node's generic Buffer doesn't match exceljs's Buffer param type.
  await wb.xlsx.load(buf as any)
  const ws = wb.worksheets[0]
  if (!ws) return { leads: [], headerRow: 0, mapped: [] }
  return parseWorksheet(ws)
}
