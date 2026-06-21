// Thin fetch wrapper around the OpenLeads public API (/api/v1). This is the ONLY
// place an HTTP client lives in the MCP workspace — tools call OpenLeadsClient,
// never fetch directly. No SDK: global fetch + AbortSignal.timeout only, matching
// the api/ dependency-light idiom.
//
// Error mapping mirrors the adapters in api/src/integrations: a non-2xx response
// becomes `OpenLeads-Fehler (<status>): <error>` (German), and a transport-level
// rejection (DNS/timeout/refused) becomes a single "nicht erreichbar" message so
// callers never see a raw fetch error.

const TIMEOUT_MS = 12_000

export interface ListResult<T> {
  data: T[]
  next_cursor: number | null
}

export interface SingleResult<T> {
  data: T
}

type Query = Record<string, string | number | undefined | null>

export class OpenLeadsClient {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(opts: { baseUrl: string; apiKey: string }) {
    // Defensive: strip a trailing slash even if a caller passed one.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
  }

  /** Build `${baseUrl}/api/v1<path>?<query>` with proper encoding. */
  private url(path: string, query?: Query): string {
    const u = new URL(`${this.baseUrl}/api/v1${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
      }
    }
    return u.toString()
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const hasBody = opts.body !== undefined
    let res: Response
    try {
      res = await fetch(this.url(path, opts.query), {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      // DNS failure, connection refused, timeout — anything before a response.
      throw new Error('OpenLeads ist nicht erreichbar.')
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
    if (!res.ok) {
      throw new Error(`OpenLeads-Fehler (${res.status}): ${json?.error ?? res.statusText}`)
    }
    return json as T
  }

  // --- leads -----------------------------------------------------------------

  /** Search/list leads. `q` full-text filter, cursor pagination. */
  searchLeads(q?: string, limit?: number, cursor?: number): Promise<ListResult<unknown>> {
    return this.request<ListResult<unknown>>('GET', '/leads', { query: { q, limit, cursor } })
  }

  getLead(id: number): Promise<SingleResult<unknown>> {
    return this.request<SingleResult<unknown>>('GET', `/leads/${id}`)
  }

  createLead(body: Record<string, unknown>): Promise<SingleResult<{ id: number }>> {
    return this.request<SingleResult<{ id: number }>>('POST', '/leads', { body })
  }

  updateLead(id: number, patch: Record<string, unknown>): Promise<SingleResult<unknown>> {
    return this.request<SingleResult<unknown>>('PATCH', `/leads/${id}`, { body: patch })
  }

  // --- documents -------------------------------------------------------------

  listDocuments(
    kind?: string,
    limit?: number,
    cursor?: number,
  ): Promise<ListResult<unknown>> {
    return this.request<ListResult<unknown>>('GET', '/documents', { query: { kind, limit, cursor } })
  }

  getDocument(id: number): Promise<SingleResult<unknown>> {
    return this.request<SingleResult<unknown>>('GET', `/documents/${id}`)
  }

  createDocument(body: Record<string, unknown>): Promise<SingleResult<unknown>> {
    return this.request<SingleResult<unknown>>('POST', '/documents', { body })
  }

  // --- payments --------------------------------------------------------------

  /** Record a payment (amount in integer CENTS) against a document. */
  recordPayment(
    id: number,
    body: { amount_cents: number; [k: string]: unknown },
  ): Promise<SingleResult<unknown>> {
    return this.request<SingleResult<unknown>>('POST', `/documents/${id}/payments`, { body })
  }

  // --- stats -----------------------------------------------------------------

  pipelineStats(): Promise<unknown> {
    return this.request<unknown>('GET', '/stats/pipeline')
  }
}
