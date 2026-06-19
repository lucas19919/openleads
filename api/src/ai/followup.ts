import { db, type LeadRow } from '../db'
import { audit } from '../audit'
import { chatJSON, AI } from './provider'

// Follow-up scheduling. A deterministic cadence per pipeline stage gives every
// lead a sensible next-contact date even with the model offline; when the model
// is available it refines the reason/wording. Terminal stages get no follow-up.

const CADENCE_DAYS: Record<string, number> = {
  neu: 2,
  qualifiziert: 3,
  kontaktiert: 5,
  interessiert: 3,
  angebot: 4,
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface FollowupSuggestion {
  recontact_at: string | null
  days: number | null
  reason: string
}

/** Deterministic suggestion from stage + last activity. Null for terminal stages. */
export function suggestFollowup(
  stage: string,
  lastActivityIso: string,
  today: string = new Date().toISOString().slice(0, 10),
): FollowupSuggestion {
  const days = CADENCE_DAYS[stage]
  if (days == null) {
    return { recontact_at: null, days: null, reason: 'Abgeschlossene Stage — keine Wiedervorlage nötig.' }
  }
  // Schedule relative to the later of (last activity + cadence) and tomorrow, so
  // an already-overdue lead is proposed for tomorrow rather than the past.
  const fromActivity = addDays(lastActivityIso.slice(0, 10), days)
  const tomorrow = addDays(today, 1)
  const recontact_at = fromActivity < tomorrow ? tomorrow : fromActivity
  return {
    recontact_at,
    days,
    reason: `Stage „${stage}" — übliche Wiedervorlage nach ${days} Tagen.`,
  }
}

/** Apply the deterministic follow-up suggestion to a lead (no model call).
 *  Used by the copilot tool so the agent can schedule without nested inference. */
export function applyFollowupDeterministic(lead: LeadRow, actor: string): FollowupSuggestion & { applied: boolean } {
  const s = suggestFollowup(lead.stage, lead.updated_at)
  if (!s.recontact_at) return { ...s, applied: false }
  db.prepare("UPDATE leads SET recontact_at = ?, updated_at = datetime('now') WHERE id = ?").run(s.recontact_at, lead.id)
  db.prepare(`INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'recontact', ?)`)
    .run(lead.id, actor, `Wiedervorlage gesetzt: ${s.recontact_at} — ${s.reason}`)
  audit({ actor, action: 'ai.plan_followup', entity: 'lead', entityId: lead.id, detail: { recontact_at: s.recontact_at } })
  return { ...s, applied: true }
}

/** Suggest (and optionally apply) the next follow-up for a lead. */
export async function planFollowup(
  lead: LeadRow,
  actor: string,
  apply: boolean,
): Promise<FollowupSuggestion & { applied: boolean }> {
  const base = suggestFollowup(lead.stage, lead.updated_at)

  // Best-effort AI refinement of the reason (never blocks the suggestion).
  if (base.recontact_at) {
    try {
      const r = await chatJSON<{ reason: string }>(
        'Du planst die nächste Vertriebs-Wiedervorlage. Antworte NUR als JSON {"reason": string} mit einem kurzen deutschen Satz, warum/zu welchem Zweck der nächste Kontakt erfolgen soll. Erfinde keine Fakten.',
        `Lead: ${JSON.stringify({ firma: lead.company, stage: lead.stage, why: lead.why_lead, notes: lead.notes })}\nVorgeschlagenes Datum: ${base.recontact_at}`,
        { temperature: 0.4, maxTokens: 120 },
      )
      if (r.reason) base.reason = r.reason
    } catch {
      // keep the deterministic reason
    }
  }

  let applied = false
  if (apply && base.recontact_at) {
    db.prepare("UPDATE leads SET recontact_at = ?, updated_at = datetime('now') WHERE id = ?").run(base.recontact_at, lead.id)
    db.prepare(`INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'recontact', ?)`)
      .run(lead.id, actor, `Wiedervorlage gesetzt: ${base.recontact_at} — ${base.reason}`)
    audit({ actor, action: 'ai.plan_followup', entity: 'lead', entityId: lead.id, detail: { recontact_at: base.recontact_at, model: AI.model } })
    applied = true
  }
  return { ...base, applied }
}
