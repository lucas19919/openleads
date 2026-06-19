import { useEffect, useState } from 'react'
import { api } from '../../api'
import { fmtDate } from '../../util'
import type { ScraperConfig, ScraperStatus, Settings } from '../../types'

// "2026-06-18 23:13:15" → "18.06.2026"
function dateOnly(ts: string | null): string {
  if (!ts) return '—'
  return fmtDate(ts.slice(0, 10))
}

export function ScraperView() {
  const [s, setS] = useState<Settings | null>(null)
  const [config, setConfig] = useState<ScraperConfig | null>(null)
  const [status, setStatus] = useState<ScraperStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function reload() {
    const [{ settings }, config, status] = await Promise.all([
      api.getSettings(),
      api.scraperConfig(),
      api.scraperStatus(),
    ])
    setS(settings)
    setConfig(config)
    setStatus(status)
  }

  useEffect(() => {
    reload()
  }, [])

  if (!s || !config || !status) return <div className="content center-muted">Lädt…</div>

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS((cur) => (cur ? { ...cur, [k]: v } : cur))
    setSaved(false)
  }

  // Empty number field → null (fall back to the default).
  function setNum(k: keyof Settings, raw: string) {
    set(k, (raw.trim() === '' ? null : Number(raw)) as Settings[keyof Settings])
  }

  async function save() {
    if (!s) return
    setSaving(true)
    try {
      await api.updateSettings({
        scraper_trades: s.scraper_trades?.trim() ? s.scraper_trades : null,
        scraper_towns: s.scraper_towns?.trim() ? s.scraper_towns : null,
        scraper_min_score: s.scraper_min_score,
        scraper_max_pairs: s.scraper_max_pairs,
        scraper_per_pair: s.scraper_per_pair,
      })
      await reload()
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const effective = config
  const runsPerDay = `bis zu ${effective.max_pairs} Kombination(en) × ${effective.per_pair} Treffer = max. ${
    effective.max_pairs * effective.per_pair
  } Kandidaten pro Lauf`

  return (
    <>
      <div className="toolbar">
        <strong style={{ paddingLeft: 4 }}>Sonnet Scraper</strong>
        <div className="spacer" />
        {saved && <span className="user-chip">Gespeichert ✓</span>}
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? '…' : 'Speichern'}
        </button>
      </div>

      <div className="content">
        <div className="scraper-page">
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-num">{status.scraped}</div>
              <div className="stat-label">Scraper-Leads gesamt</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{status.today}</div>
              <div className="stat-label">Heute gefunden</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{dateOnly(status.last)}</div>
              <div className="stat-label">Letzter Fund</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{status.total}</div>
              <div className="stat-label">Leads im System</div>
            </div>
          </div>

          <div className="schedule-note">
            Der Scraper läuft <strong>täglich automatisch</strong> (GitHub Actions) und legt neue
            Leads über den Service-Token an. Domains, die schon im System sind, werden übersprungen.
            Manuell starten:{' '}
            <code>docker compose --profile tools run --rm scraper</code>
          </div>

          <fieldset className="doc-block">
            <legend>Suchraster</legend>
            <div className="row2">
              <div className="field">
                <label>
                  Gewerke {config.using_defaults.trades && <em>(Standardliste aktiv)</em>}
                </label>
                <textarea
                  rows={8}
                  placeholder={'Ein Gewerk pro Zeile, z.B.\nSchreiner\nMaler\nDachdecker'}
                  value={s.scraper_trades ?? ''}
                  onChange={(e) => set('scraper_trades', e.target.value)}
                />
                {config.using_defaults.trades && (
                  <button
                    className="ghost"
                    style={{ marginTop: 6 }}
                    onClick={() => set('scraper_trades', config.trades.join('\n'))}
                  >
                    Standardliste einfügen ({config.trades.length})
                  </button>
                )}
              </div>
              <div className="field">
                <label>Orte {config.using_defaults.towns && <em>(Standardliste aktiv)</em>}</label>
                <textarea
                  rows={8}
                  placeholder={'Ein Ort pro Zeile, z.B.\nDachau\nErding\nFreising'}
                  value={s.scraper_towns ?? ''}
                  onChange={(e) => set('scraper_towns', e.target.value)}
                />
                {config.using_defaults.towns && (
                  <button
                    className="ghost"
                    style={{ marginTop: 6 }}
                    onClick={() => set('scraper_towns', config.towns.join('\n'))}
                  >
                    Standardliste einfügen ({config.towns.length})
                  </button>
                )}
              </div>
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Lauf-Parameter</legend>
            <div className="row2">
              <div className="field">
                <label>Mindest-Score (Schwelle für „veraltet")</label>
                <input
                  type="number"
                  placeholder={`Standard: ${effective.min_score}`}
                  value={s.scraper_min_score ?? ''}
                  onChange={(e) => setNum('scraper_min_score', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Kombinationen pro Lauf (Gewerk × Ort)</label>
                <input
                  type="number"
                  placeholder={`Standard: ${effective.max_pairs}`}
                  value={s.scraper_max_pairs ?? ''}
                  onChange={(e) => setNum('scraper_max_pairs', e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label>Treffer pro Kombination</label>
              <input
                type="number"
                placeholder={`Standard: ${effective.per_pair}`}
                value={s.scraper_per_pair ?? ''}
                onChange={(e) => setNum('scraper_per_pair', e.target.value)}
              />
            </div>
            <div className="center-muted" style={{ textAlign: 'left', padding: '4px 0' }}>
              Aktuell: {runsPerDay}.
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Zuletzt gefundene Leads</legend>
            {status.recent.length === 0 ? (
              <div className="center-muted">Noch keine Scraper-Leads.</div>
            ) : (
              <div className="table-wrap">
                <table className="leads">
                  <thead>
                    <tr>
                      <th>Firma</th>
                      <th>Gewerk</th>
                      <th>Ort</th>
                      <th className="num">Score</th>
                      <th>Gefunden</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.recent.map((l) => (
                      <tr key={l.id}>
                        <td>{l.company ?? '—'}</td>
                        <td>{l.trade ?? '—'}</td>
                        <td>{l.city ?? '—'}</td>
                        <td className="num">{l.score}</td>
                        <td>{dateOnly(l.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </fieldset>
        </div>
      </div>
    </>
  )
}
