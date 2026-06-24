import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { CatalogItem, DocItem } from '../../types'

/** A line built from a catalog item (copied by value — later edits to the
 *  catalog never touch a document that already used it). */
export function catalogItemToLine(it: CatalogItem): DocItem {
  return {
    description: (it.description ?? '').trim() || it.name,
    quantity: 1,
    unit: it.unit ?? '',
    unit_price_cents: it.unit_price_cents,
  }
}

/**
 * A compact "+ Aus Katalog" dropdown. Loads the active catalog once and calls
 * onPick with the chosen item; resets itself so the same item can be added twice.
 * Renders nothing if the catalog is empty (keeps the editor uncluttered).
 */
export function CatalogPicker({ onPick }: { onPick: (item: CatalogItem) => void }) {
  const [items, setItems] = useState<CatalogItem[]>([])
  useEffect(() => {
    api.listCatalog(true).then(({ items }) => setItems(items)).catch(() => {})
  }, [])
  if (items.length === 0) return null
  return (
    <select
      value=""
      className="catalog-picker"
      title="Position aus dem Leistungskatalog übernehmen"
      onChange={(e) => {
        const it = items.find((x) => String(x.id) === e.target.value)
        if (it) onPick(it)
        e.currentTarget.value = ''
      }}
    >
      <option value="">+ Aus Katalog…</option>
      {items.map((it) => (
        <option key={it.id} value={it.id}>
          {it.name}
          {it.unit_price_cents ? ` — ${(it.unit_price_cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 })} €` : ''}
          {it.unit ? ` / ${it.unit}` : ''}
        </option>
      ))}
    </select>
  )
}
