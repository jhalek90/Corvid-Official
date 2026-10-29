// An agent card's activity line (#327): the tool and the first command or target only, "Bash · npm run typecheck",
// with the full label kept for the tooltip.

const SHELLS = new Set(['Bash', 'PowerShell'])

/**
 * The first command of a shell line, without the plumbing: cut at the first unquoted pipe, separator or redirection
 * ("npm run typecheck 2>&1 | tail -4; npm run docs:lint" -> "npm run typecheck"), past a leading `cd somewhere &&`
 * and an opening bracket. A description ("Run the typecheck") has none of those and comes back as it is.
 */
export function firstCommand(line: string): string {
  const cmds: string[] = []
  let cur = ''
  let quote = ''
  let redirect = false
  const end = (): void => {
    cmds.push(cur.replace(/\s+\d$/, '').trim()) // the "2" of "2>&1"
    cur = ''
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = ''
      if (!redirect) cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      if (!redirect) cur += c
    } else if (c === '|' || c === ';' || c === '&' || c === '\n') {
      if (cur.trim()) end()
      else cur = ''
      redirect = false
      const last = cmds[cmds.length - 1]
      if (last && !/^cd\s/i.test(last)) break
    } else if (c === '>' || c === '<') redirect = true
    else if (!redirect) cur += c
  }
  if (cur.trim()) end()
  const first = cmds.find((x) => !/^cd\s/i.test(x)) ?? cmds[0] ?? line.trim()
  return first.replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '') || line.trim()
}

/**
 * Who and what for the card ("Bash", "npm run typecheck"; it shows them as "Bash · npm run typecheck"), and the whole
 * label for its tooltip ("Bash: npm run typecheck 2>&1 | tail -4"). A subagent's line names the subagent instead of the tool.
 */
export function activityLine(tool: string | undefined, label: string, agent?: string): { who: string; what: string; full: string } {
  const who = agent || tool || ''
  const what = tool && SHELLS.has(tool) ? firstCommand(label) : label
  return { who, what, full: who ? `${who}: ${label}` : label }
}
