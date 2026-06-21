// Runtime configuration for the OpenLeads MCP server. Read ONLY from env and
// validated FAIL-CLOSED: a missing/malformed API key or a non-http(s) base URL
// throws before any network call is attempted, so the server never starts with a
// credential it would silently misuse.
//
// The base URL is operator-supplied here (it is the operator's OWN OpenLeads
// instance, not a third-party host), but we still constrain the scheme: only
// https:// is accepted, except for localhost/127.0.0.1 where http:// is allowed
// for local development. This mirrors the codebase's "no plaintext credentials
// over untrusted transport" discipline.

export interface AppConfig {
  baseUrl: string // normalised, no trailing slash
  apiKey: string // ol_<prefix>_<secret>
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function isLocalHost(host: string): boolean {
  // strip a possible :port
  const h = host.replace(/:\d+$/, '')
  return LOCAL_HOSTS.has(h)
}

/**
 * Validate + normalise the base URL. https:// is required, except http:// is
 * permitted for localhost. Throws a German Error on anything else.
 */
export function validateBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) throw new Error('OPENLEADS_BASE_URL ist nicht gesetzt.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OPENLEADS_BASE_URL ist keine gültige URL.')
  }
  if (url.protocol === 'https:') {
    // always fine
  } else if (url.protocol === 'http:') {
    if (!isLocalHost(url.host)) {
      throw new Error('OPENLEADS_BASE_URL muss https sein (http nur für localhost erlaubt).')
    }
  } else {
    throw new Error('OPENLEADS_BASE_URL muss mit http(s):// beginnen.')
  }
  // Normalise: drop any trailing slash so we can append `/api/v1...` cleanly.
  return value.replace(/\/+$/, '')
}

/**
 * Validate the API key. Must be present and start with the `ol_` prefix that the
 * OpenLeads public API issues — anything else is rejected fail-closed.
 */
export function validateApiKey(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) throw new Error('OPENLEADS_API_KEY ist nicht gesetzt.')
  if (!value.startsWith('ol_')) {
    throw new Error('OPENLEADS_API_KEY ist ungültig (muss mit "ol_" beginnen).')
  }
  return value
}

/** Load + validate the full config from the environment. Throws (German) on any problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    baseUrl: validateBaseUrl(env.OPENLEADS_BASE_URL),
    apiKey: validateApiKey(env.OPENLEADS_API_KEY),
  }
}
