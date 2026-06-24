import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-pdf-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  replaceItems,
  finalizeDraft,
  getDocument,
  getSettings,
  setDocumentSignedDoc,
  getDocumentSignedDoc,
  deleteDocumentSignedDoc,
} = await import('./documents')
const { renderDocumentPdf } = await import('./pdf')

after(() => {
  try {
    db.close()
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix)
    } catch {
      /* ignore */
    }
  }
})

function makeInvoice(): number {
  const info = db
    .prepare("INSERT INTO documents (kind, client_name, small_business, vat_rate, status) VALUES ('rechnung', 'Kunde GmbH', 1, 19, 'entwurf')")
    .run()
  const id = Number(info.lastInsertRowid)
  replaceItems(id, [{ description: 'Leistung', quantity: 1, unit: 'Pauschal', unit_price_cents: 11900 }])
  finalizeDraft(id)
  return id
}

test('renderDocumentPdf always produces a valid PDF', async () => {
  const id = makeInvoice()
  const buf = await renderDocumentPdf(getDocument(id)!, getSettings())
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-')
})

test('document signed-copy: store, expose has_signed_doc without leaking bytes, fetch, delete', () => {
  const id = makeInvoice()
  assert.equal(getDocument(id)!.has_signed_doc, false)

  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 8, 7])
  const updated = setDocumentSignedDoc(id, { data: bytes, name: 'rechnung-unterschrieben.pdf', mime: 'application/pdf' })!
  assert.equal(updated.has_signed_doc, true)
  assert.equal((updated as unknown as Record<string, unknown>).signed_doc_data, undefined) // no raw bytes in the public shape
  assert.equal(updated.signed_doc_name, 'rechnung-unterschrieben.pdf')
  assert.equal(updated.signed_doc_size, bytes.byteLength)

  const fetched = getDocumentSignedDoc(id)!
  assert.equal(fetched.mime, 'application/pdf')
  assert.deepEqual([...fetched.data], [...bytes])

  assert.equal(deleteDocumentSignedDoc(id)!.has_signed_doc, false)
  assert.equal(getDocumentSignedDoc(id), null)
  assert.equal(setDocumentSignedDoc(999999, { data: bytes, name: 'x', mime: 'application/pdf' }), null)
})

test('the AGB appendix is added only when enabled, and grows the PDF', async () => {
  const id = makeInvoice()

  // Off (default): no AGB page.
  db.prepare("UPDATE settings SET agb_text = ?, agb_attach_documents = 0 WHERE id = 1").run(
    Array(80).fill('§ AGB-Klausel mit Text.').join(' '),
  )
  const without = await renderDocumentPdf(getDocument(id)!, getSettings())

  // On: AGB appended as an extra page → meaningfully larger.
  db.prepare('UPDATE settings SET agb_attach_documents = 1 WHERE id = 1').run()
  const withAgb = await renderDocumentPdf(getDocument(id)!, getSettings())

  assert.equal(withAgb.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.ok(withAgb.length > without.length + 200, `expected AGB PDF larger: ${withAgb.length} vs ${without.length}`)
})

test('enabling the toggle with no AGB text changes nothing', async () => {
  const id = makeInvoice()
  db.prepare("UPDATE settings SET agb_text = NULL, agb_attach_documents = 1 WHERE id = 1").run()
  const buf = await renderDocumentPdf(getDocument(id)!, getSettings())
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-') // renders fine, no appendix
})
