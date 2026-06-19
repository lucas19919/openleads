import { CRM_API_URL, CRM_SERVICE_TOKEN } from './config'

export interface LeadPayload {
  company: string
  trade?: string
  city: string
  website: string
  phone?: string
  email?: string
  mobile_friendly: boolean
  tech: string | null
  staleness_signal: string
  score: number
  priority: string
  why_lead: string
  source: 'scraper'
}

export interface PostResult {
  id?: number
  deduped?: boolean
}

export async function postLead(lead: LeadPayload): Promise<PostResult> {
  const res = await fetch(`${CRM_API_URL}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRM_SERVICE_TOKEN}`,
    },
    body: JSON.stringify(lead),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`POST /api/leads failed: ${res.status} ${body}`)
  }
  return res.json() as Promise<PostResult>
}
