import { db } from './db'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * A consistent point-in-time snapshot of the whole database as a single file.
 * `VACUUM INTO` works even with WAL active and without locking writers out — the
 * operator owns their data and can pull a backup any time. Returns the bytes.
 */
export function snapshot(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'ol-bak-'))
  const file = join(dir, 'openleads-snapshot.db')
  // VACUUM INTO does not accept a bound parameter; the path is process-internal.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  try {
    return readFileSync(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function snapshotFilename(): string {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  return `openleads-backup-${ts}.db`
}

/** Write a snapshot to disk (used by the cron-friendly backup script). */
export function snapshotToFile(path: string): { path: string; bytes: number } {
  const buf = snapshot()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buf)
  return { path, bytes: buf.length }
}
