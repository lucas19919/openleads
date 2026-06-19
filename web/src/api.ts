import type {
  Config,
  Doc,
  DocItem,
  Lead,
  LeadEvent,
  NewLead,
  ScraperConfig,
  ScraperStatus,
  Settings,
  User,
} from './types'

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  me: () => req<{ user: User }>('/me'),
  login: (username: string, password: string) =>
    req<{ user: User }>('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ ok: true }>('/logout', { method: 'POST' }),
  config: () => req<Config>('/config'),
  listLeads: (params: { stage?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.stage) qs.set('stage', params.stage)
    if (params.q) qs.set('q', params.q)
    const suffix = qs.toString() ? `?${qs}` : ''
    return req<{ leads: Lead[] }>(`/leads${suffix}`)
  },
  getLead: (id: number) => req<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}`),
  createLead: (lead: NewLead) =>
    req<{ id: number } | { deduped: true; id: number }>('/leads', {
      method: 'POST',
      body: JSON.stringify(lead),
    }),
  updateLead: (id: number, patch: Partial<Lead>) =>
    req<{ lead: Lead }>(`/leads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  importLeads: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    // No Content-Type header — the browser sets the multipart boundary.
    const res = await fetch('/api/leads/import', {
      method: 'POST',
      credentials: 'include',
      body: fd,
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const b = await res.json()
        if (b?.error) msg = b.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg)
    }
    return res.json() as Promise<{
      imported: number
      deduped: number
      total: number
      fields: string[]
    }>
  },

  // --- settings (business profile) ---
  getSettings: () => req<{ settings: Settings }>('/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    req<{ settings: Settings }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  // --- documents (Angebote + Rechnungen) ---
  listDocuments: (kind?: string) =>
    req<{ documents: Doc[] }>(`/documents${kind ? `?kind=${kind}` : ''}`),
  getDocument: (id: number) => req<{ document: Doc }>(`/documents/${id}`),
  createDocument: (body: {
    kind: string
    lead_id?: number | null
    client_name?: string | null
    client_city?: string | null
    client_email?: string | null
    items?: DocItem[]
  }) =>
    req<{ document: Doc }>('/documents', { method: 'POST', body: JSON.stringify(body) }),
  updateDocument: (id: number, patch: Partial<Doc> & { items?: DocItem[] }) =>
    req<{ document: Doc }>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  finalizeDocument: (id: number) =>
    req<{ document: Doc }>(`/documents/${id}/finalize`, { method: 'POST' }),
  convertDocument: (id: number) =>
    req<{ document: Doc }>(`/documents/${id}/convert`, { method: 'POST' }),
  deleteDocument: (id: number) =>
    req<{ ok: true }>(`/documents/${id}`, { method: 'DELETE' }),
  pdfUrl: (id: number) => `/api/documents/${id}/pdf`,

  // --- scraper ---
  scraperConfig: () => req<ScraperConfig>('/scraper/config'),
  scraperStatus: () => req<ScraperStatus>('/scraper/status'),
}

export { ApiError }
