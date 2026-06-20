import { SCORE_WEIGHTS, staleCopyrightCutoff } from './config'

export interface ScoreResult {
  score: number
  signals: string[]
  mobileFriendly: boolean
  tech: string | null
  copyrightYear: number | null
}

function detectTech(h: string): string | null {
  if (h.includes('jimdo')) return 'Jimdo'
  if (h.includes('ionos')) return 'IONOS'
  if (h.includes('1and1') || h.includes('1&1')) return '1&1'
  if (h.includes('frontpage') || h.includes('_vti_')) return 'FrontPage'
  if (h.includes('wix.com')) return 'Wix'
  if (h.includes('squarespace')) return 'Squarespace'
  if (h.includes('wp-content') || h.includes('wordpress')) return 'WordPress'
  if (h.includes('typo3')) return 'TYPO3'
  if (h.includes('joomla')) return 'Joomla'
  return null
}

/** Score a homepage's outdatedness. Higher = stronger rebuild lead. */
export function scoreSite(html: string, finalUrl: string): ScoreResult {
  const h = html.toLowerCase()
  const signals: string[] = []
  let score = 0

  const hasViewport = /<meta[^>]+name=["']?viewport/i.test(html)
  if (!hasViewport) {
    score += SCORE_WEIGHTS.noViewport
    signals.push('kein Viewport (nicht mobil)')
  }

  if (/\.swf|shockwave-flash|application\/x-shockwave/.test(h)) {
    score += SCORE_WEIGHTS.flash
    signals.push('Flash')
  }

  if (/<frameset|html 4\.0|html 4\.01|xhtml 1\.|dtd html 4/.test(h)) {
    score += SCORE_WEIGHTS.oldDoctype
    signals.push('veraltetes HTML (Frameset/HTML4)')
  }

  if (finalUrl.startsWith('http://')) {
    score += SCORE_WEIGHTS.httpOnly
    signals.push('nur HTTP (kein SSL)')
  }

  let copyrightYear: number | null = null
  const cutoff = staleCopyrightCutoff()
  const years = [...h.matchAll(/(?:©|&copy;|copyright)\s*[^0-9]{0,8}((?:19|20)\d{2})/g)].map((m) =>
    Number(m[1]),
  )
  if (years.length) {
    copyrightYear = Math.max(...years)
    if (copyrightYear <= cutoff) {
      score += SCORE_WEIGHTS.oldCopyright
      signals.push(`Copyright ${copyrightYear}`)
    }
  }

  if (/jquery[/-]1\./.test(h)) {
    score += SCORE_WEIGHTS.oldJquery
    signals.push('jQuery 1.x')
  }

  const tableCount = (h.match(/<table/g) || []).length
  if (tableCount >= 4) {
    score += SCORE_WEIGHTS.tableHeavy
    signals.push('Tabellen-Layout')
  }

  // Presentational tags CSS retired ~15 years ago. A current build never emits
  // these, so even one is a strong tell.
  if (/<font[\s>]|<center[\s>]|<marquee|<blink/.test(h)) {
    score += SCORE_WEIGHTS.deprecatedTags
    signals.push('veraltete HTML-Tags (font/center)')
  }

  // Browser-war relics: "best viewed in…", fixed-resolution notes, named old
  // browsers. Nobody writes these on a site built this decade.
  if (/best viewed|optimiert für (?:den )?(?:internet explorer|ie\b)|1024\s?[x×]\s?768|800\s?[x×]\s?600|netscape/.test(h)) {
    score += SCORE_WEIGHTS.ieOptimized
    signals.push('für alten Browser optimiert')
  }

  // Body-level presentational attributes — the table-layout era's inline styling.
  if (/\sbgcolor=|\s[av]link=|\stext=["']?#/.test(h)) {
    score += SCORE_WEIGHTS.inlineStyling
    signals.push('Inline-Layout-Attribute')
  }

  // An end-of-life CMS version in the generator meta = years of skipped updates.
  const oldCms = /wordpress\s*[2-4]\.|joomla!?\s*[12]\./.exec(h)?.[0]
  if (oldCms) {
    score += SCORE_WEIGHTS.oldCms
    signals.push(`veraltetes CMS (${oldCms.trim()})`)
  }

  const tech = detectTech(h)
  if (tech && ['Jimdo', '1&1', 'IONOS', 'FrontPage'].includes(tech)) {
    score += SCORE_WEIGHTS.builder
    signals.push(`${tech}-Baukasten`)
  }

  return { score, signals, mobileFriendly: hasViewport, tech, copyrightYear }
}

/** German one-liner explaining why this is a lead. */
export function buildWhy(s: ScoreResult): string {
  const reasons: string[] = []
  if (!s.mobileFriendly) reasons.push('nicht mobiltauglich')
  if (s.copyrightYear && s.copyrightYear <= staleCopyrightCutoff())
    reasons.push(`Stand ~${s.copyrightYear}`)
  // Lift the most telling staleness signals into the headline so the sales view
  // explains the lead at a glance (e.g. "veraltetes CMS (wordpress 4.)").
  for (const sig of s.signals) {
    if (/veraltete HTML-Tags|alten Browser|veraltetes CMS/.test(sig)) reasons.push(sig)
  }
  if (s.tech) reasons.push(`Technik: ${s.tech}`)
  return reasons.join(', ') || 'veraltete Website'
}
