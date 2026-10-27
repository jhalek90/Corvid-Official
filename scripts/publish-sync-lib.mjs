// The pure parts of scripts/publish-sync.mjs: the changelog text, the private #NNN stripping, the Synced-from
// trailer and the check that the public repo holds only commits the sync made. No git, no files, so
// scripts/test-publish-sync.mjs can test them directly.

// The first public commit, made by hand by #231 with the tree of this private commit. Every later public commit
// is a sync commit and names its private commit in a Synced-from trailer.
export const BASELINE = {
  public: '5603e63565ec3cf0729b6fb4f7da06ab2f7f44f7',
  private: 'd56bf057944377b0c8d6f3eb66d024e61202b925'
}

// The identity public commits carry: the GitHub noreply address, never the maintainer's own email.
export const PUBLIC_IDENTITY = { name: 'Justin Halek', email: '13923704+jhalek90@users.noreply.github.com' }

export const TRAILER = 'Synced-from'

// Removes private task numbers: "#244 CI: fix" -> "CI: fix", "(#12, #13)" -> "". A "#" not followed by digits stays.
export function stripTaskNumbers(text) {
  return text
    .replace(/\s*\((?:#\d+[,;\s]*)+\)/g, '')
    .replace(/(^|[\s(])#\d+\b:?/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// One first-parent commit subject of private main -> the line it gives in the changelog, or null when it says
// nothing to a user (merges of main or a remote back in, version bumps).
export function changeLine(subject) {
  let s = subject.trim()
  if (/^Merge (remote-tracking )?branch '[^']*'( of \S+)?( into \S+)?$/.test(s)) return null
  const task = /^Merge \S+: (.+)$/.exec(s)
  if (task) s = task[1]
  else if (/^Merge /.test(s)) return null
  s = stripTaskNumbers(s)
  if (!s || /^(bump )?version\b/i.test(s)) return null
  return s
}

// The changelog list from the subjects, oldest first, without repeats.
export function changeLines(subjects) {
  const seen = new Set()
  const out = []
  for (const subject of subjects) {
    const line = changeLine(subject)
    if (line && !seen.has(line.toLowerCase())) {
      seen.add(line.toLowerCase())
      out.push(line)
    }
  }
  return out
}

// The public commit message. The trailer goes last, in its own paragraph, so git and the next run can read it.
export function commitMessage({ version, lines, privateSha }) {
  const list = lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- Maintenance changes.'
  return `Corvid v${version}\n\n${list}\n\n${TRAILER}: ${privateSha}\n`
}

// The private commit a public commit message says it was synced from, or null.
export function syncedFrom(message) {
  const m = new RegExp(`^${TRAILER}:\\s*([0-9a-f]{40})\\s*$`, 'mi').exec(message)
  return m ? m[1].toLowerCase() : null
}

const isSyncCommit = (c, identity) => !!syncedFrom(c.message) && c.authorEmail === identity.email && c.committerEmail === identity.email

// Checks the public main's history, newest first: [{ sha, authorEmail, committerEmail, message }]. The newest sync
// commit (a Synced-from line, by the public identity), or else the baseline, is the trusted point: the last sync
// checked everything below it. Commits above it weren't made by the sync (an edit on GitHub, a merged pull request,
// someone else's push), so the sync refuses rather than overwrite them, unless `accept` names the public head: the
// maintainer has brought those changes into private main. The caller still checks that the private tree holds them.
// Returns { ok: true, lastSynced, trusted, outside } or { ok: false, reason }.
export function checkPublicHistory(commits, { accept, baseline = BASELINE, identity = PUBLIC_IDENTITY } = {}) {
  if (!commits.length) return { ok: false, reason: 'the public main has no commits' }
  const root = commits[commits.length - 1]
  if (root.sha !== baseline.public)
    return { ok: false, reason: `the public main's first commit is ${root.sha.slice(0, 12)}, not the expected ${baseline.public.slice(0, 12)}` }
  const t = commits.findIndex((c) => c.sha === baseline.public || isSyncCommit(c, identity))
  const trusted = commits[t]
  const outside = commits.slice(0, t)
  const head = commits[0]
  if (accept && accept !== head.sha)
    return { ok: false, reason: `--accept-public names ${accept.slice(0, 12)}, but the public main is at ${head.sha.slice(0, 12)}` }
  if (outside.length && !accept) {
    const subject = head.message.split('\n')[0]
    return {
      ok: false,
      reason: `${outside.length} commit(s) on the public main weren't made by publish-sync (newest ${head.sha.slice(0, 12)} "${subject}"). Bring their changes into private main, then pass --accept-public ${head.sha}`
    }
  }
  return {
    ok: true,
    lastSynced: trusted.sha === baseline.public ? baseline.private : syncedFrom(trusted.message),
    trusted: trusted.sha,
    outside: outside.map((c) => c.sha)
  }
}

// "M\tpath" lines from git diff --name-status -> counts and paths per kind.
export function summarizeNameStatus(text) {
  const out = { added: [], changed: [], removed: [] }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [status, ...paths] = line.split('\t')
    if (status.startsWith('A')) out.added.push(paths[0])
    else if (status.startsWith('D')) out.removed.push(paths[0])
    else out.changed.push(paths.join(' -> '))
  }
  return out
}
