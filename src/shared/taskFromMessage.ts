// A task made from an error or a message (#117): "Make task" on an error toast used to put the whole message in the
// title, with no notes and no project, so Automate couldn't run it (#116). Now the title is short, the message goes in
// the notes, and a message about Corvid itself or an extension is filed under Corvid's own project.

/** What the caller knows about a message, beyond its text. */
export interface MessageAbout {
  /** the extension it is about, by its name */
  extension?: string
}

export interface MessageTask {
  title: string
  notes: string
  /** about Corvid itself or an extension: file it under Corvid's own project */
  corvid: boolean
}

const MAX_TITLE = 70

/** The first sentence, cut at a word to about 70 characters. */
export function shortTitle(text: string, max = MAX_TITLE): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const first = flat.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? flat
  const s = first.replace(/[.!]$/, '')
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}…`
}

const EXTENSION = /\bextensions?\b|\.corvid\b/i
const CORVID = /\bCorvid\b/

/** The task to make from an error or message: a short title, the full message in the notes, and whether it is Corvid's. */
export function taskFromMessage(text: string, about: MessageAbout = {}): MessageTask {
  const full = text.trim()
  const name = about.extension?.trim()
  // the lifecycle's revert or cherry-pick conflict (#99): "This conflicts with later changes to Corvid in <files>."
  const conflict = /conflicts with later changes to Corvid/i.test(full)
  const files = full.match(/later changes to Corvid in (.+?)\.(\s|$)/i)?.[1]
  const title = conflict
    ? name
      ? `Resolve extension conflict: ${name}`
      : shortTitle(`Resolve extension conflict${files ? ` in ${files}` : ''}`)
    : name
      ? shortTitle(`${name}: ${shortTitle(full, MAX_TITLE)}`)
      : shortTitle(full)
  const corvid = !!name || conflict || EXTENSION.test(full) || CORVID.test(full)
  const notes = [`Made from ${conflict || name ? 'an extension' : 'an app'} error message${name ? ` about "${name}"` : ''}. The full message:`, '', full].join('\n')
  return { title: title || 'Look into an error', notes, corvid }
}
