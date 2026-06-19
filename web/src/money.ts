// Money is stored and passed around as integer cents to avoid float drift.

/** Cents → "1.234,56 €" (German). */
export function euro(cents: number): string {
  return (
    (cents / 100).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' €'
  )
}

/** Cents → "1234,56" for editing in an input (no thousands separator, comma decimal). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',')
}

/** Parse a German-style amount ("1.234,56" or "1234.56") → integer cents. */
export function inputToCents(s: string): number {
  const cleaned = s.trim().replace(/\s|€/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** Sum of a document's items in cents (matches the server's computeTotals). */
export function lineTotalCents(quantity: number, unitPriceCents: number): number {
  return Math.round(quantity * unitPriceCents)
}
