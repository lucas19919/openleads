import './env'

export const MODEL = 'claude-sonnet-4-6'
export const MIN_SCORE = Number(process.env.MIN_SCORE ?? 40)

export const CRM_API_URL = process.env.CRM_API_URL ?? 'http://127.0.0.1:8787'
export const CRM_SERVICE_TOKEN = process.env.CRM_SERVICE_TOKEN ?? ''

export interface RemoteScraperConfig {
  trades: string[]
  towns: string[]
  min_score: number
  max_pairs: number
  per_pair: number
}

/**
 * Pull the operator-edited config from the CRM (set in the Scraper settings
 * page). Returns null on any problem so the caller falls back to env/defaults.
 */
export async function fetchScraperConfig(): Promise<RemoteScraperConfig | null> {
  if (!CRM_SERVICE_TOKEN) return null
  try {
    const res = await fetch(`${CRM_API_URL}/api/scraper/config`, {
      headers: { Authorization: `Bearer ${CRM_SERVICE_TOKEN}` },
    })
    if (!res.ok) return null
    const c = (await res.json()) as Partial<RemoteScraperConfig>
    if (!Array.isArray(c.trades) || !Array.isArray(c.towns)) return null
    return {
      trades: c.trades,
      towns: c.towns,
      min_score: Number(c.min_score ?? MIN_SCORE),
      max_pairs: Number(c.max_pairs ?? 3),
      per_pair: Number(c.per_pair ?? 8),
    }
  } catch {
    return null
  }
}

// Browser-like UA so old sites serve their real markup (matches lead-gen workflow).
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// Munich-area trades worth a static rebuild.
export const TRADES = (process.env.SCRAPER_TRADES?.split(',').map((s) => s.trim())) ?? [
  'Schreiner',
  'Maler',
  'Dachdecker',
  'Elektro',
  'Sanitär Heizung',
  'Metallbau',
  'Glaser',
  'Bodenleger',
  'Raumausstatter',
  'GaLaBau',
]

// Munich Umland towns.
export const TOWNS = (process.env.SCRAPER_TOWNS?.split(',').map((s) => s.trim())) ?? [
  'Dachau',
  'Erding',
  'Freising',
  'Fürstenfeldbruck',
  'Starnberg',
  'Ebersberg',
  'Olching',
  'Germering',
  'Ottobrunn',
  'Unterschleißheim',
]

// Directories / portals to drop — we only want real individual business sites.
export const DIRECTORY_BLOCKLIST = [
  'gelbeseiten',
  '11880',
  'houzz',
  'muenchen.de',
  'dasoertliche',
  'das-telefonbuch',
  'my-hammer',
  'myhammer',
  'wlw.de',
  'cylex',
  'meinestadt',
  'yelp',
  'facebook',
  'instagram',
  'google',
  'schlosserei.net',
  'branchenbuch',
  '-portal.de',
]

// Outdatedness scoring weights (from the proven lead-gen heuristics).
export const SCORE_WEIGHTS = {
  noViewport: 45, // the killer signal — unusable on mobile
  flash: 25,
  oldDoctype: 18,
  httpOnly: 10,
  oldCopyright: 22, // copyright year <= 2017
  oldJquery: 8,
  tableHeavy: 12,
  builder: 8, // Jimdo / 1&1 / IONOS / FrontPage = low digital affinity
}

export function priorityFromScore(score: number): 'hoch' | 'mittel' | 'niedrig' {
  if (score >= 70) return 'hoch'
  if (score >= 45) return 'mittel'
  return 'niedrig'
}

export interface Candidate {
  company: string
  website: string
  city: string
  trade?: string
  /** Pre-supplied HTML for --dry-run (skips network fetch). */
  html?: string
}

// --dry-run fixtures: crafted outdated markup so scoring + posting can be
// verified offline (no Sonnet, no external network).
export const DRY_RUN_FIXTURES: Candidate[] = [
  {
    company: 'Schreinerei Mustermann (Test)',
    website: 'http://schreinerei-mustermann-test.example',
    city: 'Dachau',
    trade: 'Schreiner',
    html: `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">
<html><head><title>Schreinerei Mustermann</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<!-- gebaut mit Jimdo --></head>
<body><table><tr><td>Willkommen</td></tr></table>
<table><tr><td>Leistungen</td></tr></table>
<table><tr><td>Galerie</td></tr></table>
<table><tr><td>Kontakt</td></tr></table>
<p>Tel: 08131 / 12 34 56 &middot; info@schreinerei-mustermann-test.example</p>
<p>&copy; 2013 Schreinerei Mustermann</p></body></html>`,
  },
  {
    company: 'Maler Beispiel (Test)',
    website: 'http://maler-beispiel-test.example',
    city: 'Erding',
    trade: 'Maler',
    html: `<html><head><title>Maler Beispiel</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/js/jquery-1.7.2.min.js"></script>
<!-- IONOS MyWebsite --></head>
<body><h1>Maler Beispiel</h1>
<p>Kontakt: 08122 998877 &ndash; kontakt@maler-beispiel-test.example</p>
<p>Copyright 2016</p></body></html>`,
  },
]
