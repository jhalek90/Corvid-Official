import { execFile } from 'node:child_process'
import type { UpdateState } from '@shared/updateCheck'

// The git half of the update check (#143), kept free of electron so scripts/test-update-check.mjs runs it against a
// fake upstream. It fetches `upstream` and counts; it never pulls, merges, resets or pushes.

export const UPSTREAM = 'upstream'
export const FETCH_TIMEOUT_MS = 20_000

const git = (cwd: string, args: string[], timeout = 10_000): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(
      'git',
      args,
      // never a password prompt or a credential window: a fetch that needs one just fails
      { cwd, windowsHide: true, timeout, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } },
      (e, out) => (e ? reject(e) : resolve(out.trim()))
    )
  )

const firstLine = (e: unknown): string => String((e as Error).message ?? e).split(/\r?\n/).find((l) => l.trim() && !l.startsWith('Command failed')) ?? 'git failed'

/** Fetch `upstream` in `repo` and compare upstream/main with the checked-out branch. */
export async function checkRepo(repo: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<UpdateState> {
  const checkedAt = Date.now()
  const remotes = await git(repo, ['remote']).catch(() => undefined)
  if (remotes === undefined) return { status: 'not-install', detail: "Corvid's source folder isn't a git repository.", checkedAt }
  if (!remotes.split(/\r?\n/).includes(UPSTREAM))
    return { status: 'not-install', detail: "This copy has no upstream remote (it isn't an install made by npm run setup), so there's nothing to check.", checkedAt }
  try {
    await git(repo, ['fetch', '--quiet', '--no-tags', UPSTREAM, 'main'], timeoutMs)
  } catch (e) {
    return { status: 'failed', detail: firstLine(e), checkedAt }
  }
  try {
    // `fetch upstream main` updates upstream/main through the remote's refspec; FETCH_HEAD is the fallback
    const upstream = await git(repo, ['rev-parse', `${UPSTREAM}/main`]).catch(() => git(repo, ['rev-parse', 'FETCH_HEAD']))
    const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')) || 'HEAD'
    const count = Number(await git(repo, ['rev-list', '--count', `HEAD..${upstream}`]))
    return { status: count > 0 ? 'available' : 'up-to-date', count, upstream, branch: branch === 'HEAD' ? undefined : branch, checkedAt }
  } catch (e) {
    return { status: 'failed', detail: firstLine(e), checkedAt }
  }
}
