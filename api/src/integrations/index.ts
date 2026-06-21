// Side-effect module: importing it registers every shipped adapter with the
// registry. index.ts imports this once at startup (like the AI tool registry).
//
// Shipped: payment(stripe, gocardless), accounting(vies, lexoffice, sevdesk),
// mail(smtp, google, microsoft), calendar(google, microsoft),
// telephony(sipgate). Enrichment is interface-only for now.
import { register } from './registry'
import { stripeDefinition } from './adapters/stripe'
import { viesDefinition } from './adapters/vies'
import { smtpDefinition } from './adapters/smtp'
import { gocardlessDefinition } from './adapters/gocardless'
import { lexofficeDefinition } from './adapters/lexoffice'
import { sevdeskDefinition } from './adapters/sevdesk'
import { sipgateDefinition } from './adapters/sipgate'
import { googleMailDefinition, googleCalendarDefinition } from './adapters/google'
import { msgraphMailDefinition, msgraphCalendarDefinition } from './adapters/msgraph'

register(stripeDefinition)
register(viesDefinition)
register(smtpDefinition)
register(gocardlessDefinition)
register(lexofficeDefinition)
register(sevdeskDefinition)
register(sipgateDefinition)
register(googleMailDefinition)
register(googleCalendarDefinition)
register(msgraphMailDefinition)
register(msgraphCalendarDefinition)

export { register } from './registry'
