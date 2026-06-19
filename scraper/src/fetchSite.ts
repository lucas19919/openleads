import { USER_AGENT } from './config'

export interface Fetched {
  html: string
  finalUrl: string
}

export async function fetchHtml(url: string, timeoutMs = 12000): Promise<Fetched | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('html') && !ct.includes('text')) return null
    const html = await res.text()
    return { html, finalUrl: res.url || url }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
const PHONE_RE = /(?:\+49|0)[\d\s/().-]{6,}\d/g

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;|&nbsp;|&ndash;|&amp;/gi, ' ')
    .replace(/\s+/g, ' ')
}

export interface Contact {
  phone?: string
  email?: string
}

/** Pull a phone + email out of page text. */
export function extractContact(html: string): Contact {
  const text = stripTags(html)
  const out: Contact = {}

  const emailMatch = text.match(EMAIL_RE)
  if (emailMatch && !/sentry|wixpress|\.(png|jpg|gif)$/i.test(emailMatch[0])) {
    out.email = emailMatch[0]
  }

  for (const cand of text.match(PHONE_RE) ?? []) {
    const digits = cand.replace(/\D/g, '')
    if (digits.length >= 7 && digits.length <= 15) {
      out.phone = cand.replace(/\s+/g, ' ').trim()
      break
    }
  }
  return out
}

/** Fetch impressum/kontakt pages to find contact details. */
export async function enrichContact(baseUrl: string): Promise<Contact> {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return {}
  }
  const out: Contact = {}
  for (const path of ['', '/impressum', '/kontakt', '/impressum.html', '/kontakt.html']) {
    if (out.phone && out.email) break
    const r = await fetchHtml(origin + path)
    if (!r) continue
    const c = extractContact(r.html)
    out.email ??= c.email
    out.phone ??= c.phone
  }
  return out
}
