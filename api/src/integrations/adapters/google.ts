import type {
  CalendarEvent,
  CalendarProvider,
  ConfigFieldSchema,
  IntegrationContext,
  MailProvider,
  ProbeResult,
  ProviderDefinition,
  ResolvedConnection,
} from '../types'
import { getAccessToken, isOAuthConnected } from '../oauth'

// Google adapters (Gmail send + Calendar) over OAuth2. Hosts are HARDCODED. The
// pure builders (buildGmailRaw, mapCalendarEvent) are offline-unit-testable; the
// live calls go through getAccessToken (auto-refresh). Ships as TWO connections
// (mail + calendar) because the registry resolves one adapter per category.

const GMAIL_BASE = 'https://gmail.googleapis.com'
const GCAL_BASE = 'https://www.googleapis.com'
const TIMEOUT = 12000

const OAUTH_FIELDS: ConfigFieldSchema[] = [
  { key: 'client_id', label: 'OAuth Client-ID', type: 'string', required: true },
  { key: 'client_secret', label: 'OAuth Client-Secret', type: 'string', secret: true, required: true },
  {
    key: 'redirect_uri',
    label: 'Redirect-URI (exakt wie in Google Cloud hinterlegt)',
    type: 'string',
    required: true,
    placeholder: 'https://crm.example.com/api/integrations/oauth/callback',
  },
]

function rfc2047(s: string): string {
  // Encode a header value as an RFC 2047 encoded-word only when it has non-ASCII.
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s
}

/** Build a base64url RFC-2822 message for the Gmail send API. Pure. */
export function buildGmailRaw(msg: { to: string; from?: string; subject: string; text: string }): string {
  const headers = [
    msg.from ? `From: ${msg.from}` : null,
    `To: ${msg.to}`,
    `Subject: ${rfc2047(msg.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean)
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + msg.text, 'utf8').toString('base64url')
}

/** Map a generic calendar event to the Google Calendar event body. Pure. */
export function mapCalendarEvent(input: {
  title: string
  start: string
  end: string
  description?: string
  attendees?: string[]
}) {
  return {
    summary: input.title,
    description: input.description ?? undefined,
    start: { dateTime: input.start },
    end: { dateTime: input.end },
    attendees: input.attendees?.map((e) => ({ email: e })),
  }
}

async function googleFetch(base: string, path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch {
    throw new Error('Google ist nicht erreichbar.')
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } }
  if (!res.ok) throw new Error(`Google-Fehler: ${json?.error?.message ?? res.status}`)
  return json
}

function connectedProbe(connId: number): ProbeResult {
  const s = isOAuthConnected(connId)
  return s.connected
    ? { ok: true, detail: s.account_email ? `Verbunden als ${s.account_email}` : 'Verbunden' }
    : { ok: false, detail: 'Konto nicht verbunden — bitte „Verbinden" klicken.' }
}

class GoogleMail implements MailProvider {
  readonly category = 'mail' as const
  readonly provider = 'google'
  private readonly connId: number
  constructor(conn: ResolvedConnection) {
    this.connId = conn.id
  }
  async probe(): Promise<ProbeResult> {
    return connectedProbe(this.connId)
  }
  async send(msg: { to: string; from: string; subject: string; text: string }, _ctx: IntegrationContext) {
    const token = await getAccessToken(this.connId)
    const r = await googleFetch(GMAIL_BASE, '/gmail/v1/users/me/messages/send', token, { raw: buildGmailRaw(msg) })
    return { messageId: String(r.id ?? '') }
  }
}

class GoogleCalendar implements CalendarProvider {
  readonly category = 'calendar' as const
  readonly provider = 'google'
  private readonly connId: number
  constructor(conn: ResolvedConnection) {
    this.connId = conn.id
  }
  async probe(): Promise<ProbeResult> {
    return connectedProbe(this.connId)
  }
  async createEvent(
    input: { title: string; start: string; end: string; description?: string; attendees?: string[] },
    _ctx: IntegrationContext,
  ): Promise<CalendarEvent> {
    const token = await getAccessToken(this.connId)
    const r = await googleFetch(GCAL_BASE, '/calendar/v3/calendars/primary/events', token, mapCalendarEvent(input))
    return { id: String(r.id ?? ''), title: input.title, start: input.start, end: input.end, url: (r.htmlLink as string) ?? null }
  }
}

export const googleMailDefinition: ProviderDefinition<MailProvider> = {
  category: 'mail',
  provider: 'google',
  label: 'Google (Gmail)',
  configSchema: OAUTH_FIELDS,
  build: (conn) => new GoogleMail(conn),
}

export const googleCalendarDefinition: ProviderDefinition<CalendarProvider> = {
  category: 'calendar',
  provider: 'google',
  label: 'Google Kalender',
  configSchema: OAUTH_FIELDS,
  build: (conn) => new GoogleCalendar(conn),
}
