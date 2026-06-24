import { db, type CatalogItemRow } from './db'

// Leistungskatalog (services/products catalog). Reusable line items that the
// invoice / quote / recurring / contract editors can drop into a document instead
// of retyping. Items are copied by value at insert time, so editing a catalog
// entry never changes a document that already used it.

export interface CatalogInput {
  name?: string | null
  description?: string | null
  unit?: string | null
  unit_price_cents?: number | null
  vat_rate?: number | null
  sku?: string | null
  category?: string | null
  active?: number | boolean | null
  sort?: number | null
  notes?: string | null
}

function bool(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt
  return v ? 1 : 0
}

export function listCatalog(activeOnly = false): CatalogItemRow[] {
  const where = activeOnly ? 'WHERE active = 1' : ''
  return db
    .prepare(`SELECT * FROM catalog_items ${where} ORDER BY sort, name, id`)
    .all() as unknown as CatalogItemRow[]
}

export function getCatalogItem(id: number): CatalogItemRow | null {
  return (
    (db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id) as unknown as
      | CatalogItemRow
      | undefined) ?? null
  )
}

export function createCatalogItem(input: CatalogInput): CatalogItemRow {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('Bezeichnung ist erforderlich.')
  const info = db
    .prepare(
      `INSERT INTO catalog_items
        (name, description, unit, unit_price_cents, vat_rate, sku, category, active, sort, notes)
       VALUES
        (@name, @description, @unit, @unit_price_cents, @vat_rate, @sku, @category, @active, @sort, @notes)`,
    )
    .run({
      name,
      description: input.description ?? null,
      unit: input.unit ?? null,
      unit_price_cents: Math.round(Number(input.unit_price_cents ?? 0)),
      vat_rate: Number(input.vat_rate ?? 19),
      sku: input.sku ?? null,
      category: input.category ?? null,
      active: bool(input.active, 1),
      sort: Number(input.sort ?? 0),
      notes: input.notes ?? null,
    })
  return getCatalogItem(Number(info.lastInsertRowid))!
}

const EDITABLE_COLS = new Set([
  'name', 'description', 'unit', 'unit_price_cents', 'vat_rate', 'sku', 'category', 'active', 'sort', 'notes',
])

export function updateCatalogItem(id: number, patch: CatalogInput): CatalogItemRow | null {
  if (!getCatalogItem(id)) return null
  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_COLS.has(key)) continue
    let v: string | number | null
    if (key === 'active') v = value ? 1 : 0
    else if (key === 'unit_price_cents') v = Math.round(Number(value ?? 0))
    else if (key === 'name') {
      const n = String(value ?? '').trim()
      if (!n) throw new Error('Bezeichnung ist erforderlich.')
      v = n
    } else if (typeof value === 'boolean') v = value ? 1 : 0
    else v = (value as string | number | null) ?? null
    sets.push(`${key} = @${key}`)
    params[key] = v
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE catalog_items SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return getCatalogItem(id)
}

export function deleteCatalogItem(id: number): boolean {
  // Hard delete is safe: documents hold their own copy of the line, not a FK.
  const r = db.prepare('DELETE FROM catalog_items WHERE id = ?').run(id)
  return r.changes > 0
}
