// Side-effect module: importing it registers every shipped adapter with the
// registry. index.ts imports this once at startup (like the AI tool registry).
//
// Shipped now: payment(stripe), accounting(vies), mail(smtp). The remaining
// categories (enrichment, calendar, telephony) are interface-only — the contract
// exists so the roadmap can fill them in as small adapters without touching the
// rest of the system.
import { register } from './registry'
import { stripeDefinition } from './adapters/stripe'
import { viesDefinition } from './adapters/vies'
import { smtpDefinition } from './adapters/smtp'

register(stripeDefinition)
register(viesDefinition)
register(smtpDefinition)

export { register } from './registry'
