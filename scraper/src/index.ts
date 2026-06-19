import './env'
import {
  TRADES,
  TOWNS,
  MIN_SCORE,
  DRY_RUN_FIXTURES,
  CRM_SERVICE_TOKEN,
  fetchScraperConfig,
} from './config'
import { processCandidate, runPair } from './pipeline'

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`)

function pickPairs(trades: string[], towns: string[], max: number): [string, string][] {
  const all: [string, string][] = []
  for (const t of trades) for (const c of towns) all.push([t, c])
  // shuffle so repeated daily runs rotate coverage; DB dedupe handles overlap.
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[all[i], all[j]] = [all[j], all[i]]
  }
  return all.slice(0, max)
}

async function dryRun(): Promise<void> {
  console.log('DRY RUN — Fixtures bewerten und an die CRM-API senden (kein Sonnet, kein Web-Fetch)\n')
  let posted = 0
  let deduped = 0
  let skipped = 0
  for (const fixture of DRY_RUN_FIXTURES) {
    const r = await processCandidate(fixture)
    if (!r) {
      skipped++
      console.log(`· ${fixture.company}: unter Schwelle, übersprungen`)
    } else if (r.deduped) {
      deduped++
      console.log(`· ${fixture.company}: bereits vorhanden (Domain-Dedupe)`)
    } else {
      posted++
      console.log(`✓ ${fixture.company}: angelegt — Score ${r.score} (${r.priority})`)
    }
  }
  console.log(`\nFertig. Neu: ${posted}, Dedupe: ${deduped}, übersprungen: ${skipped}`)
}

async function liveRun(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY fehlt — in crm/scraper/.env eintragen (oder --dry-run nutzen).')
    process.exit(1)
  }
  // CLI args win; otherwise use the CRM-configured values; otherwise env/defaults.
  const remote = await fetchScraperConfig()
  if (remote) console.log('Konfiguration aus dem CRM geladen.')
  const trades = argValue('trade')?.split(',').map((s) => s.trim()) ?? remote?.trades ?? TRADES
  const towns = argValue('town')?.split(',').map((s) => s.trim()) ?? remote?.towns ?? TOWNS
  const maxPairs = Number(argValue('max-pairs') ?? remote?.max_pairs ?? 3)
  const perPair = Number(argValue('limit') ?? remote?.per_pair ?? 8)
  const minScore = Number(argValue('min-score') ?? remote?.min_score ?? MIN_SCORE)

  const pairs = pickPairs(trades, towns, maxPairs)
  console.log(`Scrape: ${pairs.length} Kombination(en) (Gewerk × Ort), Mindest-Score ${minScore}\n`)

  const total = { posted: 0, deduped: 0, skipped: 0 }
  for (const [trade, town] of pairs) {
    console.log(`→ ${trade} in ${town}`)
    const res = await runPair(trade, town, perPair, minScore)
    total.posted += res.posted
    total.deduped += res.deduped
    total.skipped += res.skipped
  }
  console.log(`\nFertig. Neu: ${total.posted}, Dedupe: ${total.deduped}, übersprungen: ${total.skipped}`)
}

async function main(): Promise<void> {
  if (!CRM_SERVICE_TOKEN) {
    console.error('CRM_SERVICE_TOKEN fehlt — in crm/scraper/.env eintragen.')
    process.exit(1)
  }
  if (hasFlag('dry-run')) await dryRun()
  else await liveRun()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
