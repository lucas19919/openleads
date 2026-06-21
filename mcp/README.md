# @openleads/mcp

An MCP (Model Context Protocol) server that wraps the **OpenLeads public API**
(`/api/v1`) and exposes it as tools to MCP hosts such as Claude Desktop. It is the
**only** place in the OpenLeads repo where a third-party SDK
(`@modelcontextprotocol/sdk`) is allowed — the backend `api/` stays
dependency-light.

The server speaks JSON-RPC over **stdio**.

## Environment variables

| Variable             | Required | Description                                                                 |
| -------------------- | -------- | --------------------------------------------------------------------------- |
| `OPENLEADS_BASE_URL` | yes      | Base URL of your OpenLeads instance, e.g. `https://leads.example.com`. Must be `https://` (only `http://` is allowed for `localhost`/`127.0.0.1`). |
| `OPENLEADS_API_KEY`  | yes      | A public API key minted in OpenLeads. Must start with `ol_`.                |

Config is validated **fail-closed** at startup: if the key is missing/malformed or
the base URL is not valid http(s), the server throws a German error and exits
before connecting.

## Required API-key scopes

Mint the key in OpenLeads (Admin → API-Schlüssel) with the scopes the tools need:

- `leads:read`, `leads:write`
- `documents:read`, `documents:write`
- `payments:write` (for `record_payment`)
- `stats:read` (for `pipeline_stats`)

> Note: at the time of writing, the live `/api/v1` surface ships `leads:*` and
> `documents:*`. `payments:write` and `stats:read` are the scopes the
> corresponding endpoints are expected to require; grant whatever your instance
> defines. See ASSUMPTIONs in the source.

## Tools

| Tool              | Endpoint                                  |
| ----------------- | ----------------------------------------- |
| `search_leads`    | `GET /api/v1/leads?q&limit&cursor`        |
| `get_lead`        | `GET /api/v1/leads/:id`                   |
| `create_lead`     | `POST /api/v1/leads`                      |
| `update_lead`     | `PATCH /api/v1/leads/:id`                 |
| `list_documents`  | `GET /api/v1/documents?kind&limit&cursor` |
| `get_document`    | `GET /api/v1/documents/:id`               |
| `create_document` | `POST /api/v1/documents`                  |
| `record_payment`  | `POST /api/v1/documents/:id/payments`     |
| `pipeline_stats`  | `GET /api/v1/stats/pipeline`              |

All monetary values are **integer cents** (e.g. `unit_price_cents`, `amount_cents`).

## Run

```sh
cd mcp
npm install
OPENLEADS_BASE_URL=https://leads.example.com \
OPENLEADS_API_KEY=ol_xxx_yyy \
npm start
```

- `npm test` — offline unit tests (mocked `fetch`, no network).
- `npm run typecheck` / `npm run build` — `tsc --noEmit`.

## Claude Desktop configuration

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openleads": {
      "command": "npx",
      "args": ["-y", "tsx", "D:\\Repos\\openleads\\mcp\\src\\server.ts"],
      "env": {
        "OPENLEADS_BASE_URL": "https://leads.example.com",
        "OPENLEADS_API_KEY": "ol_xxx_yyy"
      }
    }
  }
}
```

(Adjust the path to `src/server.ts` for your machine. You can also point
`command` at a global `tsx`/`node` if you prefer.)

## Protocol warning — stdout is sacred

stdout carries the JSON-RPC message stream. A stray `console.log` (or anything
else writing to stdout) **corrupts the protocol** and breaks the connection.
**All** diagnostics in this server go to `console.error` (stderr). Keep it that
way.
