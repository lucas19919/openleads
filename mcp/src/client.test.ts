import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenLeadsClient } from './client'
import { tools } from './tools'
import { validateBaseUrl, validateApiKey, loadConfig } from './config'

// Offline unit tests: globalThis.fetch is mocked so no real network is hit. We
// assert the exact URL/method/headers/body the client produces, the error
// mappings, the config fail-closed behaviour, and the tool registry shape.

const BASE = 'https://leads.example.com'
const KEY = 'ol_abcd1234_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** Install a fetch stub that records the call and returns the given response. */
function stubFetch(
  status: number,
  payload: unknown,
): { captured: Captured | null; restore: () => void } {
  const original = globalThis.fetch
  const state: { captured: Captured | null } = { captured: null }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | undefined
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v
    state.captured = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'STATUS',
      json: async () => payload,
    } as Response
  }) as typeof fetch
  return {
    get captured() {
      return state.captured
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function newClient(): OpenLeadsClient {
  return new OpenLeadsClient({ baseUrl: BASE, apiKey: KEY })
}

test('getLead: GET /api/v1/leads/:id with bearer header, no body', async () => {
  const f = stubFetch(200, { data: { id: 7 } })
  try {
    const out = await newClient().getLead(7)
    assert.deepEqual(out, { data: { id: 7 } })
    const c = f.captured!
    assert.equal(c.url, `${BASE}/api/v1/leads/7`)
    assert.equal(c.method, 'GET')
    assert.equal(c.headers['authorization'], `Bearer ${KEY}`)
    assert.equal(c.headers['content-type'], undefined) // no body => no content-type
    assert.equal(c.body, undefined)
  } finally {
    f.restore()
  }
})

test('createLead: POST /api/v1/leads with json body + content-type', async () => {
  const f = stubFetch(201, { data: { id: 99 } })
  try {
    const out = await newClient().createLead({ name: 'Acme', email: 'a@b.de' })
    assert.deepEqual(out, { data: { id: 99 } })
    const c = f.captured!
    assert.equal(c.url, `${BASE}/api/v1/leads`)
    assert.equal(c.method, 'POST')
    assert.equal(c.headers['authorization'], `Bearer ${KEY}`)
    assert.equal(c.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(c.body!), { name: 'Acme', email: 'a@b.de' })
  } finally {
    f.restore()
  }
})

test('listDocuments: GET with encoded query params (kind/limit/cursor)', async () => {
  const f = stubFetch(200, { data: [], next_cursor: null })
  try {
    await newClient().listDocuments('rechnung', 25, 100)
    const c = f.captured!
    const u = new URL(c.url)
    assert.equal(u.pathname, '/api/v1/documents')
    assert.equal(u.searchParams.get('kind'), 'rechnung')
    assert.equal(u.searchParams.get('limit'), '25')
    assert.equal(u.searchParams.get('cursor'), '100')
    assert.equal(c.method, 'GET')
  } finally {
    f.restore()
  }
})

test('listDocuments: omits undefined query params', async () => {
  const f = stubFetch(200, { data: [], next_cursor: null })
  try {
    await newClient().listDocuments(undefined, undefined, undefined)
    const u = new URL(f.captured!.url)
    assert.equal(u.searchParams.has('kind'), false)
    assert.equal(u.searchParams.has('limit'), false)
    assert.equal(u.searchParams.has('cursor'), false)
  } finally {
    f.restore()
  }
})

test('recordPayment: POST /api/v1/documents/:id/payments with amount_cents', async () => {
  const f = stubFetch(201, { data: { ok: true } })
  try {
    await newClient().recordPayment(42, { amount_cents: 11900, method: 'ueberweisung' })
    const c = f.captured!
    assert.equal(c.url, `${BASE}/api/v1/documents/42/payments`)
    assert.equal(c.method, 'POST')
    assert.equal(c.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(c.body!), { amount_cents: 11900, method: 'ueberweisung' })
  } finally {
    f.restore()
  }
})

test('401 maps to German OpenLeads-Fehler with status + error body', async () => {
  const f = stubFetch(401, { error: 'Ungültiger oder fehlender API-Schlüssel.' })
  try {
    await assert.rejects(
      () => newClient().getLead(1),
      /OpenLeads-Fehler \(401\): Ungültiger oder fehlender API-Schlüssel\./,
    )
  } finally {
    f.restore()
  }
})

test('network reject maps to "OpenLeads ist nicht erreichbar."', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    await assert.rejects(() => newClient().getLead(1), /OpenLeads ist nicht erreichbar\./)
  } finally {
    globalThis.fetch = original
  }
})

// --- config fail-closed -----------------------------------------------------

test('validateApiKey: rejects missing and non-ol_ keys, accepts ol_', () => {
  assert.throws(() => validateApiKey(undefined), /nicht gesetzt/)
  assert.throws(() => validateApiKey(''), /nicht gesetzt/)
  assert.throws(() => validateApiKey('sk_live_123'), /ol_/)
  assert.equal(validateApiKey(KEY), KEY)
})

test('validateBaseUrl: requires http(s), https always ok, normalises trailing slash', () => {
  assert.throws(() => validateBaseUrl(undefined), /nicht gesetzt/)
  assert.throws(() => validateBaseUrl('ftp://x.de'), /http/)
  assert.throws(() => validateBaseUrl('not a url'), /gültige URL/)
  assert.equal(validateBaseUrl('https://x.de/'), 'https://x.de')
  assert.equal(validateBaseUrl('https://x.de/api/'), 'https://x.de/api')
})

test('validateBaseUrl: http only allowed for localhost', () => {
  assert.throws(() => validateBaseUrl('http://example.com'), /https/)
  assert.equal(validateBaseUrl('http://localhost:8787'), 'http://localhost:8787')
  assert.equal(validateBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
})

test('loadConfig: fails closed and succeeds on valid env', () => {
  assert.throws(() => loadConfig({ OPENLEADS_BASE_URL: BASE } as NodeJS.ProcessEnv), /API_KEY/)
  assert.throws(() => loadConfig({ OPENLEADS_API_KEY: KEY } as NodeJS.ProcessEnv), /BASE_URL/)
  const cfg = loadConfig({ OPENLEADS_BASE_URL: BASE + '/', OPENLEADS_API_KEY: KEY } as NodeJS.ProcessEnv)
  assert.deepEqual(cfg, { baseUrl: BASE, apiKey: KEY })
})

// --- tool registry ----------------------------------------------------------

test('tool registry has exactly 9 named tools each with a handler', () => {
  assert.equal(tools.length, 9)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'create_document',
    'create_lead',
    'get_document',
    'get_lead',
    'list_documents',
    'pipeline_stats',
    'record_payment',
    'search_leads',
    'update_lead',
  ])
  for (const t of tools) {
    assert.equal(typeof t.name, 'string')
    assert.equal(typeof t.description, 'string')
    assert.equal(typeof t.inputSchema, 'object')
    assert.equal(typeof t.handler, 'function')
  }
})

test('tool handler maps a thrown client error to isError text result', async () => {
  const failing = {
    getLead: async () => {
      throw new Error('OpenLeads-Fehler (404): not found')
    },
  } as unknown as OpenLeadsClient
  const getLead = tools.find((t) => t.name === 'get_lead')!
  const res = await getLead.handler({ id: 5 }, failing)
  assert.equal(res.isError, true)
  assert.equal(res.content[0].type, 'text')
  assert.match(res.content[0].text, /OpenLeads-Fehler \(404\): not found/)
})

test('tool handler wraps success as JSON text content', async () => {
  const okClient = {
    getLead: async () => ({ data: { id: 5 } }),
  } as unknown as OpenLeadsClient
  const getLead = tools.find((t) => t.name === 'get_lead')!
  const res = await getLead.handler({ id: 5 }, okClient)
  assert.equal(res.isError, undefined)
  assert.deepEqual(JSON.parse(res.content[0].text), { data: { id: 5 } })
})
