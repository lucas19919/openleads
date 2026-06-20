import { db, type IntegrationConnectionRow } from '../db'
import { encryptSecret, decryptSecret } from '../secrets'
import { audit } from '../audit'
import type {
  AnyAdapter,
  IntegrationCategory,
  ProviderDefinition,
  ResolvedConnection,
} from './types'

// In-memory definition table. Adapters self-register at import time (a
// side-effect import from integrations/index.ts), exactly like the AI tool set.
const DEFS = new Map<string, ProviderDefinition>() // key = `${category}:${provider}`

const keyOf = (category: string, provider: string) => `${category}:${provider}`

/** Register a provider definition. Idempotent; later wins. */
export function register(def: ProviderDefinition): void {
  DEFS.set(keyOf(def.category, def.provider), def)
}

/** All advertised providers (optionally for one category), schema only. */
export function available(category?: IntegrationCategory): ProviderDefinition[] {
  const all = [...DEFS.values()]
  return category ? all.filter((d) => d.category === category) : all
}

export function getDefinition(category: string, provider: string): ProviderDefinition | null {
  return DEFS.get(keyOf(category, provider)) ?? null
}

/** Decrypt + parse a stored connection row into a ResolvedConnection. */
function resolveRow(r: IntegrationConnectionRow): ResolvedConnection {
  let config: Record<string, unknown> = {}
  let secrets: Record<string, string> = {}
  try {
    config = JSON.parse(r.config)
  } catch {
    /* keep {} */
  }
  const dec = decryptSecret(r.credentials_enc)
  if (dec) {
    try {
      secrets = JSON.parse(dec)
    } catch {
      /* keep {} */
    }
  }
  return { id: r.id, category: r.category as IntegrationCategory, provider: r.provider, label: r.label, config, secrets }
}

/**
 * Resolve the ACTIVE adapter for a category (or null). Builds a fresh adapter
 * per call (cheap) so a Settings change is picked up without a restart — the
 * same getter-based live-config posture as the SMTP mailer.
 */
export function resolve(category: IntegrationCategory): AnyAdapter | null {
  const row = db
    .prepare(
      `SELECT * FROM integration_connections WHERE category = ? AND active = 1 LIMIT 1`,
    )
    .get(category) as unknown as IntegrationConnectionRow | undefined
  if (!row) return null
  const def = getDefinition(row.category, row.provider)
  if (!def) return null
  return def.build(resolveRow(row))
}

/** Build the adapter for a specific connection id (used by the probe route). */
export function adapterById(id: number): AnyAdapter | null {
  const row = getConnection(id)
  if (!row) return null
  const def = getDefinition(row.category, row.provider)
  if (!def) return null
  return def.build(resolveRow(row))
}

/** Resolve the active adapter for a provider id (used by the inbound receiver). */
export function resolveActiveByProvider(
  provider: string,
): { adapter: AnyAdapter; connection: IntegrationConnectionRow } | null {
  const row = db
    .prepare('SELECT * FROM integration_connections WHERE provider = ? AND active = 1 LIMIT 1')
    .get(provider) as unknown as IntegrationConnectionRow | undefined
  if (!row) return null
  const def = getDefinition(row.category, row.provider)
  if (!def) return null
  return { adapter: def.build(resolveRow(row)), connection: row }
}

export function listConnections(): IntegrationConnectionRow[] {
  return db
    .prepare('SELECT * FROM integration_connections ORDER BY category, provider')
    .all() as unknown as IntegrationConnectionRow[]
}

export function getConnection(id: number): IntegrationConnectionRow | null {
  return (
    (db.prepare('SELECT * FROM integration_connections WHERE id = ?').get(id) as unknown as
      | IntegrationConnectionRow
      | undefined) ?? null
  )
}

/**
 * Persist/replace a connection. `secrets` is JSON-stringified then AES-256-GCM
 * encrypted (may throw the German SETTINGS_KEY error in prod — let it propagate).
 * Omitting `secrets` on an update keeps the stored credentials (COALESCE).
 */
export function saveConnection(input: {
  category: IntegrationCategory
  provider: string
  label?: string | null
  config: Record<string, unknown>
  secrets?: Record<string, string>
  actor: string | null
}): number {
  const def = getDefinition(input.category, input.provider)
  if (!def) throw new Error('Unbekannter Anbieter.')
  const enc =
    input.secrets && Object.keys(input.secrets).length
      ? encryptSecret(JSON.stringify(input.secrets))
      : null
  const info = db
    .prepare(
      `INSERT INTO integration_connections (category, provider, label, config, credentials_enc, status)
       VALUES (@category, @provider, @label, @config, @credentials_enc, 'unconfigured')
       ON CONFLICT(category, provider) DO UPDATE SET
         label = excluded.label,
         config = excluded.config,
         credentials_enc = COALESCE(excluded.credentials_enc, integration_connections.credentials_enc),
         updated_at = datetime('now')`,
    )
    .run({
      category: input.category,
      provider: input.provider,
      label: input.label ?? def.label,
      config: JSON.stringify(input.config ?? {}),
      credentials_enc: enc,
    })
  // ON CONFLICT updates don't return a useful lastInsertRowid; look the id up.
  const row = db
    .prepare('SELECT id FROM integration_connections WHERE category = ? AND provider = ?')
    .get(input.category, input.provider) as { id: number } | undefined
  const id = row?.id ?? Number(info.lastInsertRowid)
  audit({ actor: input.actor, action: 'integration.save', entity: 'integration', entityId: id, detail: { category: input.category, provider: input.provider } })
  return id
}

/** Make one connection the active adapter for its category (deactivates siblings). */
export function activate(id: number, actor: string | null): boolean {
  const row = db.prepare('SELECT category FROM integration_connections WHERE id = ?').get(id) as
    | { category: string }
    | undefined
  if (!row) return false
  db.prepare('UPDATE integration_connections SET active = 0 WHERE category = ?').run(row.category)
  db.prepare("UPDATE integration_connections SET active = 1, updated_at = datetime('now') WHERE id = ?").run(id)
  audit({ actor, action: 'integration.activate', entity: 'integration', entityId: id, detail: { category: row.category } })
  return true
}

export function deleteConnection(id: number, actor: string | null): boolean {
  const info = db.prepare('DELETE FROM integration_connections WHERE id = ?').run(id)
  if (!info.changes) return false
  audit({ actor, action: 'integration.delete', entity: 'integration', entityId: id })
  return true
}

export function setStatus(id: number, status: 'ok' | 'error' | 'unconfigured', detail: string | null): void {
  db.prepare(
    "UPDATE integration_connections SET status = ?, status_detail = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(status, detail, id)
}
