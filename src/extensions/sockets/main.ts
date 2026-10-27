import type { ZodRawShape } from 'zod'
import type { ToolDef } from '../../main/mcp'
import type { AccessPart } from '../../main/agentAccess'
import { createRegistry, type Entry } from './registry'
import type { SocketHost } from './load'

// The main-process sockets (#102): board slash commands, worker MCP tools, worker instruction lines and connector
// manifests. Extensions get only these functions. They never get Corvid's stores, approvals, secrets or windows:
// a command answers the user with text, a tool returns data under the same token, scoping and permission prompts
// as every other worker tool, an instruction is one line of plain text, and a connector is only ever a draft that
// goes through the validator and waits for the user's approval in Connections.

/** A board slash command. Runs only for what the user typed in Corvid's own message box, never for a post by an agent
 *  or a tool; its answer is shown as a dashboard notice under the user's message. */
export interface ExtensionCommand {
  /** without the slash: 2 to 32 lowercase letters, digits and hyphens; it may not shadow an existing command */
  name: string
  description: string
  argumentHint?: string
  run: (args: string) => string | Promise<string>
}

/** What an extension tool knows about its caller. Fixed by Corvid from the worker's token, never by the agent. */
export interface ToolContext {
  caller: 'worker'
  /** the project folder the worker works in */
  project: string
  taskId?: number
}

/** An MCP tool for workers. Served as mcp__corvid__ext_<id>_<name>, to workers only. A tool that isn't read-only is
 *  not pre-approved, so Claude Code asks the user before each call. Its result is masked for secrets and audited. */
export interface ExtensionTool {
  /** 2 to 32 lowercase letters, digits and underscores; the full name gets the ext_<id>_ prefix */
  name: string
  description: string
  input: ZodRawShape
  /** true only when it changes nothing: then Claude Code doesn't ask before calling it */
  readOnly?: boolean
  run: (args: Record<string, unknown>, ctx: ToolContext) => unknown
}

/** One plain-text line added to every new worker's instructions. */
export interface ExtensionInstruction {
  /** unique within the extension */
  id: string
  /** one line, at most 300 characters */
  text: string
}

/** A connector manifest offered as a draft for the user to review. */
export interface ExtensionConnector {
  manifest: Record<string, unknown>
  /** why the extension needs it, shown with the draft */
  reason: string
}

/** The sockets an extension's main-process part receives. Each returns its unregister function. */
export interface MainSockets {
  command: (c: ExtensionCommand) => () => void
  tool: (t: ExtensionTool) => () => void
  instruction: (i: ExtensionInstruction) => () => void
  connector: (c: ExtensionConnector) => () => void
}

export const TOOL_NAME = /^[a-z][a-z0-9_]{1,31}$/
export const COMMAND_NAME = /^[a-z][a-z0-9-]{1,31}$/
export const INSTRUCTION_MAX = 300

const toolKey = (owner: string, name: string): string => `ext_${owner.replace(/-/g, '_')}_${name}`

const commands = createRegistry<ExtensionCommand>('Slash command', (c) => c.name)
const tools = createRegistry<ExtensionTool & { full: string }>('Tool', (t) => t.full)
const instructions = createRegistry<ExtensionInstruction & { key: string }>('Instruction', (i) => i.key)
const connectors = createRegistry<ExtensionConnector & { key: string }>('Connector', (c) => c.key)
const all = [commands, tools, instructions, connectors]

/** Names the core already uses, so an extension command can't shadow one (set by index.ts). */
let taken: () => string[] = () => []
export const setTakenCommands = (f: () => string[]): void => void (taken = f)

const need = (ok: boolean, msg: string): void => {
  if (!ok) throw new Error(msg)
}
const oneLine = (s: unknown, max: number): boolean => typeof s === 'string' && !!s.trim() && s.length <= max && !/[\r\n]/.test(s)

function socketsFor(owner: string): MainSockets {
  return {
    command: (c) => {
      need(COMMAND_NAME.test(c?.name ?? ''), `Command name "${c?.name}" must be 2 to 32 lowercase letters, digits and hyphens.`)
      need(!taken().includes(c.name), `/${c.name} is already a command in Corvid.`)
      need(oneLine(c.description, 160), `/${c.name} needs a one-line description of at most 160 characters.`)
      need(typeof c.run === 'function', `/${c.name} has no run function.`)
      return commands.add(owner, { name: c.name, description: c.description, argumentHint: c.argumentHint, run: c.run })
    },
    tool: (t) => {
      need(TOOL_NAME.test(t?.name ?? ''), `Tool name "${t?.name}" must be 2 to 32 lowercase letters, digits and underscores.`)
      need(oneLine(t.description, 600), `Tool ${t.name} needs a one-line description of at most 600 characters.`)
      need(!!t.input && typeof t.input === 'object', `Tool ${t.name} needs an input shape (use {} for none).`)
      need(typeof t.run === 'function', `Tool ${t.name} has no run function.`)
      return tools.add(owner, { ...t, readOnly: t.readOnly === true, full: toolKey(owner, t.name) })
    },
    instruction: (i) => {
      need(oneLine(i?.text, INSTRUCTION_MAX), `An instruction must be one line of at most ${INSTRUCTION_MAX} characters.`)
      need(typeof i.id === 'string' && /^[a-z0-9-]{1,32}$/.test(i.id), 'An instruction needs a short id.')
      return instructions.add(owner, { id: i.id, text: i.text.trim(), key: `${owner}/${i.id}` })
    },
    connector: (c) => {
      need(!!c?.manifest && typeof c.manifest === 'object', 'A connector needs a manifest object.')
      need(oneLine(c.reason, 400), 'A connector needs a one-line reason of at most 400 characters.')
      return connectors.add(owner, { manifest: c.manifest, reason: c.reason, key: `${owner}/${String(c.manifest.id)}` })
    }
  }
}

export const mainHost: SocketHost<MainSockets> = {
  socketsFor,
  count: (owner) => all.reduce((n, r) => n + r.list().filter((e) => e.owner === owner).length, 0),
  removeOwner: (owner) => all.forEach((r) => r.removeOwner(owner))
}

/** Empties every main-process socket, before the extensions are loaded again. */
export const clearMainSockets = (): void => all.forEach((r) => r.clear())

// ---------- what the core reads ----------

/** The commands for the board's popup, after the core's own. */
export const extensionCommands = (): { name: string; description: string; argumentHint?: string; owner: string }[] =>
  commands.list().map((e) => ({ name: e.item.name, description: e.item.description, argumentHint: e.item.argumentHint, owner: e.owner }))

/** Runs an extension command the user typed; its answer as text (a failure is an answer too, never a crash). */
export async function runExtensionCommand(name: string, args: string): Promise<string | null> {
  const e = commands.get(name)
  if (!e) return null
  try {
    const out = await e.item.run(args)
    return typeof out === 'string' && out.trim() ? out : `/${name} finished.`
  } catch (err) {
    return `/${name} (from the ${e.owner} extension) failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

export interface ToolAuditEntry {
  at: number
  extension: string
  tool: string
  agent: string
  project: string
  ok: boolean
  /** the result held something secret-looking, which was masked */
  masked: boolean
  error?: string
}

export interface AccessDeps {
  /** masks secrets in a result: the crash log's patterns and every connection secret (index.ts) */
  scrub: (text: string) => string
  audit: (e: ToolAuditEntry) => void
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''))

/** One extension tool as a ToolDef for a worker's token: scoped to that worker, masked and audited. */
function toolDef(e: Entry<ExtensionTool & { full: string }>, scope: { project: string; agent: string; taskId?: number }, d: AccessDeps): ToolDef {
  const t = e.item
  return {
    name: t.full,
    description: `${t.description} (from the ${e.owner} extension)`,
    input: t.input,
    readOnly: t.readOnly,
    run: async (args) => {
      const ctx: ToolContext = Object.freeze({ caller: 'worker' as const, project: scope.project, ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}) })
      const base = { at: Date.now(), extension: e.owner, tool: t.full, agent: scope.agent, project: scope.project }
      try {
        const raw = asText(await t.run({ ...(args ?? {}) }, ctx))
        const text = d.scrub(raw)
        d.audit({ ...base, ok: true, masked: text !== raw })
        return text
      } catch (err) {
        const msg = d.scrub(err instanceof Error ? err.message : String(err))
        d.audit({ ...base, ok: false, masked: false, error: msg.slice(0, 300) })
        throw new Error(msg)
      }
    }
  }
}

/** The extensions' part of a worker's access: their tools (read-only ones pre-approved, the rest asked about by
 *  Claude Code) and their instruction lines. Null when no extension adds anything. */
export function extensionAccess(scope: { project: string; agent: string; taskId?: number }, d: AccessDeps): AccessPart | null {
  const ts = tools.list()
  const lines = instructions.list().map((e) => d.scrub(e.item.text))
  if (!ts.length && !lines.length) return null
  const names = ts.map((e) => e.item.full)
  return {
    tools: ts.map((e) => toolDef(e, scope, d)),
    allowed: ts.filter((e) => e.item.readOnly).map((e) => e.item.full),
    prompt: [...lines, ...(names.length ? [`Extension tools: ${names.map((n) => `mcp__corvid__${n}`).join(', ')}.`] : [])].join(' ')
  }
}

/** The connector manifests extensions offer, for index.ts to submit as drafts. */
export const extensionConnectors = (): { owner: string; manifest: Record<string, unknown>; reason: string }[] =>
  connectors.list().map((e) => ({ owner: e.owner, manifest: e.item.manifest, reason: e.item.reason }))

/** Counts per socket, for the Extensions tab. */
export const mainSocketCounts = (owner: string): Record<string, number> => ({
  commands: commands.list().filter((e) => e.owner === owner).length,
  tools: tools.list().filter((e) => e.owner === owner).length,
  instructions: instructions.list().filter((e) => e.owner === owner).length,
  connectors: connectors.list().filter((e) => e.owner === owner).length
})
