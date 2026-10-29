import { promises as fsp } from 'node:fs'
import { claudeHome } from './testCopy'
import { customConfigDir } from './agentDeny'
import { join } from 'node:path'
import type { LiveSession } from '@shared/types'

/** Claude Code's live registry, and the one in the custom models' config folder for sessions on the user's own models (#317). */
const dirs = (): string[] => [join(claudeHome(), 'sessions'), join(customConfigDir(), 'sessions')]

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

async function read(): Promise<LiveSession[]> {
  const out: LiveSession[] = []
  for (const dir of dirs()) await readDir(dir, out)
  return out
}

async function readDir(dir: string, out: LiveSession[]): Promise<void> {
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const r = JSON.parse(await fsp.readFile(join(dir, n), 'utf8'))
      if (!r.pid || !r.sessionId || !alive(r.pid)) continue
      out.push({
        pid: r.pid,
        sessionId: r.sessionId,
        cwd: r.cwd ?? '',
        status: r.status ?? 'idle',
        waitingFor: r.waitingFor,
        name: r.name,
        kind: r.kind,
        entrypoint: r.entrypoint,
        statusUpdatedAt: r.statusUpdatedAt
      })
    } catch {
      /* file mid-write */
    }
  }
}

export type Transition = { session: LiveSession; from: string }

/** Polls Claude Code's live session registry; reports the list and busy->not-busy transitions. */
export function watchLive(
  onList: (list: LiveSession[]) => void,
  onTransition: (t: Transition) => void,
  intervalMs = 1500
): () => LiveSession[] {
  let last: LiveSession[] = []
  let lastKey = ''
  const prevStatus = new Map<string, string>()

  const tick = async (): Promise<void> => {
    const list = await read()
    for (const s of list) {
      const before = prevStatus.get(s.sessionId)
      if (before === 'busy' && s.status !== 'busy') onTransition({ session: s, from: before })
      prevStatus.set(s.sessionId, s.status)
    }
    for (const id of [...prevStatus.keys()]) if (!list.some((s) => s.sessionId === id)) prevStatus.delete(id)
    const key = JSON.stringify(list.map((s) => [s.pid, s.sessionId, s.status, s.waitingFor, s.name]))
    last = list
    if (key !== lastKey) {
      lastKey = key
      onList(list)
    }
  }
  void tick()
  setInterval(() => void tick(), intervalMs)
  return () => last
}

/** One session's status straight from its file, not the last poll: for checking an agent is still idle right before typing (#80). */
export async function freshStatus(pid: number): Promise<{ status: string; statusUpdatedAt?: number } | null> {
  for (const dir of dirs()) {
    try {
      const r = JSON.parse(await fsp.readFile(join(dir, `${pid}.json`), 'utf8'))
      return r.pid === pid && alive(pid) ? { status: r.status ?? 'idle', statusUpdatedAt: r.statusUpdatedAt } : null
    } catch {
      /* not in this registry */
    }
  }
  return null
}
