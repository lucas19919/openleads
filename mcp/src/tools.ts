import { z, type ZodRawShape } from 'zod'
import type { OpenLeadsClient } from './client'

// The tool registry: exactly 9 tools wrapping OpenLeadsClient. Exported as a
// plain array so it can be unit-tested offline (no MCP server, no network) and
// registered by server.ts. Each handler returns the MCP content shape; a thrown
// Error (incl. the German API errors from the client) is caught and surfaced as
// an isError text result so the model sees the message instead of a crash.
//
// inputSchema is a raw zod SHAPE (object of zod fields), which is what
// McpServer.registerTool expects — not a wrapped z.object().

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  inputSchema: Shape
  handler: (args: z.infer<z.ZodObject<Shape>>, client: OpenLeadsClient) => Promise<ToolResult>
}

/** Wrap a successful result value as a single JSON text block. */
function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

/** Wrap a thrown error as an isError text block (German message preserved). */
function fail(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : 'Unbekannter Fehler.'
  return { content: [{ type: 'text', text: msg }], isError: true }
}

/** Helper to define a tool with full type inference on its args. */
function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef {
  return def as unknown as ToolDef
}

export const tools: ToolDef[] = [
  defineTool({
    name: 'search_leads',
    description: 'Leads suchen/auflisten (Volltext-Filter q, Cursor-Paginierung).',
    inputSchema: {
      q: z.string().optional().describe('Suchbegriff (Name, E-Mail, Firma).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max. Anzahl (1-100).'),
      cursor: z.number().int().positive().optional().describe('Cursor aus next_cursor.'),
    },
    handler: async (args, client) => {
      try {
        return ok(await client.searchLeads(args.q, args.limit, args.cursor))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'get_lead',
    description: 'Einen einzelnen Lead per ID abrufen.',
    inputSchema: {
      id: z.number().int().positive().describe('Lead-ID.'),
    },
    handler: async (args, client) => {
      try {
        return ok(await client.getLead(args.id))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'create_lead',
    description: 'Einen neuen Lead anlegen.',
    inputSchema: {
      name: z.string().optional().describe('Name des Leads.'),
      email: z.string().optional().describe('E-Mail-Adresse.'),
      phone: z.string().optional().describe('Telefonnummer.'),
      company: z.string().optional().describe('Firma.'),
      source: z.string().optional().describe('Quelle (Standard: api).'),
      notes: z.string().optional().describe('Notizen.'),
    },
    handler: async (args, client) => {
      try {
        return ok(await client.createLead({ ...args }))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'update_lead',
    description: 'Felder eines bestehenden Leads aktualisieren (Teil-Update).',
    inputSchema: {
      id: z.number().int().positive().describe('Lead-ID.'),
      patch: z.record(z.unknown()).describe('Zu ändernde Felder als Objekt.'),
    },
    handler: async (args, client) => {
      try {
        return ok(await client.updateLead(args.id, args.patch))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'list_documents',
    description: 'Dokumente (Rechnungen/Angebote) auflisten, optional nach kind gefiltert.',
    inputSchema: {
      kind: z.enum(['rechnung', 'angebot']).optional().describe('Dokumentart.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max. Anzahl (1-100).'),
      cursor: z.number().int().positive().optional().describe('Cursor aus next_cursor.'),
    },
    handler: async (args, client) => {
      try {
        return ok(await client.listDocuments(args.kind, args.limit, args.cursor))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'get_document',
    description: 'Ein Dokument inkl. Positionen und Summen (in Cent) abrufen.',
    inputSchema: {
      id: z.number().int().positive().describe('Dokument-ID.'),
    },
    handler: async (args, client) => {
      try {
        return ok(await client.getDocument(args.id))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'create_document',
    description:
      'Ein Dokument (rechnung/angebot) anlegen. Beträge in Cent (unit_price_cents).',
    inputSchema: {
      kind: z.enum(['rechnung', 'angebot']).describe('Dokumentart.'),
      lead_id: z.number().int().positive().optional().describe('Verknüpfte Lead-ID.'),
      client_name: z.string().optional().describe('Kundenname.'),
      client_email: z.string().optional().describe('Kunden-E-Mail.'),
      title: z.string().optional().describe('Titel des Dokuments.'),
      intro: z.string().optional().describe('Einleitungstext.'),
      notes: z.string().optional().describe('Notizen.'),
      items: z
        .array(
          z.object({
            description: z.string().optional().describe('Beschreibung der Position.'),
            quantity: z.number().optional().describe('Menge.'),
            unit: z.string().optional().describe('Einheit (z. B. Std, Stk).'),
            unit_price_cents: z
              .number()
              .int()
              .describe('Einzelpreis in CENT (Ganzzahl).'),
          }),
        )
        .optional()
        .describe('Positionen.'),
    },
    handler: async (args, client) => {
      try {
        return ok(await client.createDocument({ ...args }))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'record_payment',
    description: 'Eine Zahlung (Betrag in CENT) zu einem Dokument erfassen.',
    inputSchema: {
      id: z.number().int().positive().describe('Dokument-ID.'),
      amount_cents: z.number().int().positive().describe('Betrag in CENT (positive Ganzzahl).'),
      paid_at: z.string().optional().describe('Zahlungsdatum (ISO 8601), Standard: heute.'),
      method: z.string().optional().describe('Zahlungsart (z. B. ueberweisung).'),
      note: z.string().optional().describe('Notiz.'),
    },
    handler: async (args, client) => {
      try {
        const { id, ...body } = args
        return ok(await client.recordPayment(id, body))
      } catch (e) {
        return fail(e)
      }
    },
  }),

  defineTool({
    name: 'pipeline_stats',
    description: 'Pipeline-Kennzahlen abrufen (Aggregat über Leads/Dokumente).',
    inputSchema: {},
    handler: async (_args, client) => {
      try {
        return ok(await client.pipelineStats())
      } catch (e) {
        return fail(e)
      }
    },
  }),
]
