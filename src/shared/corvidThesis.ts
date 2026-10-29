// What Corvid is, for agents (#202). The one source is the docs page docs/getting-started/what-corvid-is.md: the main
// process bundles it (a Vite ?raw import in src/main/index.ts) and registers it here at startup, and every prompt
// builder takes its dose from here. No prompt carries a second hand-typed copy of the thesis.
//
// Two doses. "full": the whole page, for agents that work on the user's own copy of Corvid (the Corvid project, the
// extension pipeline, Corvid itself, /discuss panels about Corvid). "short": the three sentences plus the "when to
// suggest" rule, for agents on any other project, where Corvid is the environment and not the subject. Neutral
// prompts (the extension scan classifier, the usage parser) get nothing.

/** The docs page, relative to the repository root. */
export const THESIS_DOC = 'docs/getting-started/what-corvid-is.md'
/** How a worker on another project phrases its one suggestion, in its done post. */
export const SUGGESTION_PREFIX = 'Corvid could:'
/** The note Corvid (the app) collects those lines into. */
export const SUGGESTIONS_NOTE = 'Corvid could: suggestions from agents'

export type ThesisDose = 'full' | 'short' | 'none'

let registered = ''

/** The page's Markdown, registered once by the main process at startup. */
export const setThesisText = (md: string): void => {
  registered = md
}
export const thesisText = (): string => registered

/** The page without its front matter and its HTML comments. */
export function pageBody(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->\n?/g, '')
    .trim()
}

/** The text under one heading ("## Corvid in three sentences"), up to the next heading of the same or a higher level. */
export function section(md: string, heading: string): string {
  const lines = pageBody(md).split('\n')
  const at = lines.findIndex((l) => l.trim() === heading.trim())
  if (at < 0) return ''
  const level = /^#+/.exec(heading.trim())![0].length
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    const h = /^(#+)\s/.exec(l)
    if (h && h[1].length <= level) break
    out.push(l)
  }
  return out.join('\n').trim()
}

/** Markdown folded into prompt text: one line per block, headings as "Title.", list markers dropped (numbers kept). */
export function fold(md: string): string {
  return md
    .split(/\n\s*\n/)
    .map((block) => {
      const h = /^(#+)\s+(.*)$/.exec(block.trim())
      if (h) return `${h[2].trim()}.`
      return block
        .split('\n')
        .map((l) => l.replace(/^\s*-\s+/, '').replace(/^\s+/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    })
    .filter(Boolean)
    .join('\n')
}

/** The three sentences at the top of the page, as plain text other prompts embed verbatim. */
export const threeSentences = (md = registered): string => fold(section(md, '## Corvid in three sentences'))

/** The "when to suggest" rule for agents on other projects; `on` is the Settings switch "Agents may suggest Corvid improvements". */
export function suggestRule(on: boolean, md = registered): string {
  const lead = 'Corvid is the environment you run in, not the subject of your task; your job is the task.'
  if (!on) return `${lead} The user has turned Corvid suggestions off in Settings: do not suggest Corvid changes.`
  // the section's first block says who the rule is for; the bullets after it are the rule
  return `${lead} ${fold(section(md, '### Agents on any other project')).split('\n').slice(1).join(' ')}`
}

/** The whole page, folded, with a line that says where it comes from and that the agent acts on it. */
export function fullDose(md = registered): string {
  if (!md) return ''
  return `What Corvid is (${THESIS_DOC}, the project owner's intent; this project is the user's own copy of Corvid, so act on it):\n${fold(pageBody(md))}`
}

/** The three sentences plus the rule, for an agent whose task is on another project. */
export function shortDose(suggestionsOn: boolean, md = registered): string {
  if (!md) return ''
  return `About Corvid, the dashboard that started you: ${threeSentences(md)} ${suggestRule(suggestionsOn, md)}`
}

/** The three sentences only, for a lean worker on any project, the Corvid project too (#318, N175 decision 3). */
export function leanDose(md = registered): string {
  if (!md) return ''
  return `About Corvid, the dashboard that started you: ${threeSentences(md)}`
}

/** The dose for one agent: full on the user's copy of Corvid, short elsewhere, nothing for a neutral prompt. */
export function thesisDose(dose: ThesisDose, suggestionsOn = true, md = registered): string {
  if (dose === 'full') return fullDose(md)
  if (dose === 'short') return shortDose(suggestionsOn, md)
  return ''
}

/** Whether a done post carries a suggestion, and the line itself (from the prefix on, one line, at most 500 characters). */
export function suggestionLine(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const at = raw.toLowerCase().indexOf(SUGGESTION_PREFIX.toLowerCase())
    if (at < 0) continue
    const line = (SUGGESTION_PREFIX + raw.slice(at + SUGGESTION_PREFIX.length)).replace(/\s+/g, ' ').trim()
    if (line.length > SUGGESTION_PREFIX.length + 1) return line.slice(0, 500)
  }
  return undefined
}
