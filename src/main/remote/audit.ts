import { app } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry } from '@shared/types'

// Every command an agent asks to run, one JSON line each: system, command, outcome and who
// approved it. Commands are scrubbed before they get here, and output is never logged
// (only its size), so the log holds no secrets.

const MAX_BYTES = 5 * 1024 * 1024
const file = (): string => join(app.getPath('userData'), 'remote', 'audit.jsonl')

export function audit(entry: AuditEntry): void {
  mkdirSync(join(app.getPath('userData'), 'remote'), { recursive: true })
  try {
    if (statSync(file()).size > MAX_BYTES) renameSync(file(), file().replace(/\.jsonl$/, '.1.jsonl'))
  } catch {
    /* no log yet */
  }
  appendFileSync(file(), JSON.stringify(entry) + '\n')
}

/** Newest first. */
export function readAudit(limit = 200): AuditEntry[] {
  try {
    const lines = readFileSync(file(), 'utf8').trim().split('\n').slice(-limit)
    return lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry]
      } catch {
        return []
      }
    }).reverse()
  } catch {
    return []
  }
}

export const auditPath = file
