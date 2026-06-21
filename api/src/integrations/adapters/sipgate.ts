import type {
  ConfigFieldSchema,
  IntegrationContext,
  ProbeResult,
  ProviderDefinition,
  ResolvedConnection,
  TelephonyProvider,
} from '../types'

// sipgate click-to-call adapter — fetch only, no SDK (dependency-light). The base
// URL is HARDCODED to api.sipgate.com/v2: the personal access token must never be
// sent to an operator-supplied host, so the base is not configurable.
//
// Verified against the official sipgate REST API + the sipgate-io reference
// examples (sipgateio-outgoingcall-node, sipgateio-personalaccesstoken-node):
//   - Auth: HTTP Basic over `${token_id}:${token}` (personal access token).
//   - POST /v2/sessions/calls with body { deviceId, caller, callee, callerId? }
//     returns { sessionId } (needs scope sessions:calls:write).
//   - GET /v2/account returns 200 with account info (needs scope account:read);
//     used as the probe.
//
// buildSipgateCallBody is PURE (no network): it normalises the callee to E.164 and
// throws a German error on a clearly invalid number, so it is unit-tested offline.

const SIPGATE_BASE = 'https://api.sipgate.com/v2'
const TIMEOUT_MS = 12_000

const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  // token_id (e.g. "token-XXXXXX") is the username half of the credential. It is
  // not highly sensitive on its own, so it lives in plaintext config — but it is
  // useless without the secret token below.
  { key: 'token_id', label: 'Token-ID (token-...)', type: 'string', required: true, placeholder: 'token-XXXXXX' },
  { key: 'token', label: 'Personal Access Token', type: 'string', secret: true, required: true, placeholder: '••••••••' },
  // The device/extension that establishes the connection, e.g. "e0" or a
  // phonelineId like "p0". sipgate uses this as both deviceId and caller.
  { key: 'device_id', label: 'Geräte-/Nebenstellen-ID (z. B. e0)', type: 'string', required: true, placeholder: 'e0' },
  { key: 'caller_id', label: 'Angezeigte Rufnummer (optional)', type: 'string', placeholder: '+49301234567' },
]

export interface SipgateCallBody {
  deviceId: string
  caller: string
  callee: string
  callerId?: string
}

export interface SipgateConfig {
  deviceId: string
  callerId?: string
}

/**
 * Normalise a German/international phone number to E.164 (e.g. "0049 30 12 34"
 * -> "+493012 34" -> "+4930123 4"). Strips spaces, dashes, slashes and parens,
 * maps a leading "00" international prefix to "+", and a leading single "0"
 * (national trunk) to the German country code "+49". Throws a German error on a
 * clearly invalid number. PURE — no network, offline-unit-testable.
 */
export function normalizeE164(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new Error('Ungültige Zielrufnummer.')
  // Keep a single leading '+', drop every other non-digit.
  const hasPlus = trimmed.startsWith('+')
  let digits = trimmed.replace(/[^\d]/g, '')
  let e164: string
  if (hasPlus) {
    e164 = `+${digits}`
  } else if (digits.startsWith('00')) {
    // International access code 00 -> +
    e164 = `+${digits.slice(2)}`
  } else if (digits.startsWith('0')) {
    // National trunk prefix -> German country code. ASSUMPTION: bare national
    // numbers are German (DE) since OpenLeads is a German product; international
    // callers should pass +CC or 00CC explicitly.
    e164 = `+49${digits.slice(1)}`
  } else {
    e164 = `+${digits}`
  }
  // After the leading '+', E.164 allows 8..15 digits (a couple shorter for some
  // short codes, but for a callee we require a plausible subscriber number).
  const bare = e164.slice(1)
  if (!/^\d{8,15}$/.test(bare)) throw new Error('Ungültige Zielrufnummer.')
  return e164
}

/**
 * Build the POST /sessions/calls request body. PURE: normalises `to` to E.164 and
 * throws the German error on an invalid number. `from` overrides the configured
 * device id (caller) when supplied; deviceId always tracks the connecting device.
 */
export function buildSipgateCallBody(
  input: { to: string; from?: string },
  cfg: SipgateConfig,
): SipgateCallBody {
  const deviceId = (cfg.deviceId ?? '').trim()
  if (!deviceId) throw new Error('sipgate: Geräte-/Nebenstellen-ID nicht konfiguriert.')
  const callee = normalizeE164(input.to)
  // caller identifies the device/extension that initiates the call. A `from`
  // override (e.g. a specific extension) is used verbatim if provided.
  const caller = (input.from ?? '').trim() || deviceId
  const body: SipgateCallBody = { deviceId, caller, callee }
  const callerId = (cfg.callerId ?? '').trim()
  if (callerId) body.callerId = callerId
  return body
}

class SipgateAdapter implements TelephonyProvider {
  readonly category = 'telephony' as const
  readonly provider = 'sipgate'
  private readonly tokenId: string
  private readonly token: string
  private readonly deviceId: string
  private readonly callerId: string

  constructor(conn: ResolvedConnection) {
    this.tokenId = String(conn.config.token_id ?? '')
    this.token = conn.secrets.token ?? ''
    this.deviceId = String(conn.config.device_id ?? '')
    this.callerId = String(conn.config.caller_id ?? '')
  }

  private authHeader(): string {
    // HTTP Basic over `${token_id}:${token}` (sipgate personal access token).
    const basic = Buffer.from(`${this.tokenId}:${this.token}`, 'utf8').toString('base64')
    return `Basic ${basic}`
  }

  private async call(path: string, body?: unknown): Promise<unknown> {
    if (!this.tokenId || !this.token) {
      throw new Error('sipgate: Zugangsdaten (Token-ID + Token) nicht konfiguriert.')
    }
    let res: Response
    try {
      res = await fetch(`${SIPGATE_BASE}${path}`, {
        method: body !== undefined ? 'POST' : 'GET',
        headers: {
          authorization: this.authHeader(),
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('sipgate ist nicht erreichbar.')
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('sipgate: Zugangsdaten ungültig oder Berechtigung fehlt.')
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { message?: string }
      throw new Error(`sipgate-Fehler: ${json?.message ?? res.status}`)
    }
    return res.json().catch(() => ({}))
  }

  async probe(): Promise<ProbeResult> {
    if (!this.tokenId || !this.token) {
      return { ok: false, detail: 'Zugangsdaten (Token-ID + Token) nicht konfiguriert.' }
    }
    try {
      await this.call('/account')
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  async startCall(
    input: { to: string; from?: string },
    _ctx: IntegrationContext,
  ): Promise<{ call_id: string }> {
    const body = buildSipgateCallBody(input, { deviceId: this.deviceId, callerId: this.callerId })
    const res = (await this.call('/sessions/calls', body)) as { sessionId?: string }
    if (!res?.sessionId) throw new Error('sipgate: Anruf konnte nicht gestartet werden.')
    return { call_id: res.sessionId }
  }
}

export const sipgateDefinition: ProviderDefinition<TelephonyProvider> = {
  category: 'telephony',
  provider: 'sipgate',
  label: 'sipgate (Click-to-Call)',
  configSchema: CONFIG_SCHEMA,
  build: (conn) => new SipgateAdapter(conn),
}
