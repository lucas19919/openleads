import type {
  AccountingProvider,
  IntegrationContext,
  ProbeResult,
  ProviderDefinition,
  VatValidation,
} from '../types'

// VIES EU VAT-id validation — the EU Commission's free, auth-free service. A
// great reference adapter: no credentials, a real endpoint, and the parsing is a
// pure function so it is unit-tested offline with canned JSON (the live fetch is
// behind validateVatId and not exercised in node:test, mirroring mailer's
// compose/send split). Base host is hardcoded — no operator-supplied URL.

const VIES_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api'
const TIMEOUT_MS = 8000

/** Split a full VAT id like "DE123456789" into its country + number parts. */
export function splitVatId(full: string): { country: string; number: string } {
  const s = full.replace(/\s+/g, '').toUpperCase()
  const m = s.match(/^([A-Z]{2})(.+)$/)
  return m ? { country: m[1], number: m[2] } : { country: '', number: s }
}

/** Pure mapper from a VIES REST response to our VatValidation shape. */
export function mapViesResponse(
  json: Record<string, unknown>,
  country: string,
  number: string,
): VatValidation {
  return {
    valid: !!(json.isValid ?? json.valid),
    country_code: (json.countryCode as string) ?? country,
    vat_number: (json.vatNumber as string) ?? number,
    name: (json.name as string) || null,
    address: (json.address as string) || null,
  }
}

class ViesAdapter implements AccountingProvider {
  readonly category = 'accounting' as const
  readonly provider = 'vies'

  async probe(): Promise<ProbeResult> {
    // Auth-free service: nothing to verify locally beyond "the adapter is wired".
    return { ok: true, detail: 'Bereit (keine Zugangsdaten nötig).' }
  }

  async validateVatId(
    countryCode: string,
    vatNumber: string,
    _ctx: IntegrationContext,
  ): Promise<VatValidation> {
    const country = (countryCode || '').replace(/\s+/g, '').toUpperCase()
    const number = (vatNumber || '').replace(/\s+/g, '').toUpperCase()
    if (!/^[A-Z]{2}$/.test(country) || !number) {
      throw new Error('Ungültige USt-IdNr. (Ländercode + Nummer erwartet).')
    }
    let res: Response
    try {
      res = await fetch(`${VIES_BASE}/check-vat-number`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ countryCode: country, vatNumber: number }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('USt-IdNr.-Prüfung (VIES) nicht erreichbar.')
    }
    if (!res.ok) throw new Error(`VIES-Fehler: ${res.status}`)
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return mapViesResponse(json, country, number)
  }
}

export const viesDefinition: ProviderDefinition<AccountingProvider> = {
  category: 'accounting',
  provider: 'vies',
  label: 'VIES (EU USt-IdNr.-Prüfung)',
  configSchema: [],
  build: () => new ViesAdapter(),
}
