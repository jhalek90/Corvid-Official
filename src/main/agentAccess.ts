import { app } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { McpEndpoint, ToolDef } from './mcp'

// Each worker gets its own MCP token on the dashboard's server, holding only the tools Corvid gives
// that worker: the notes tools always, and its project's remote systems when it has any.

/** One bundle of tools for a worker, with the names to pre-approve and the line for its system prompt. */
export interface AccessPart {
  tools: ToolDef[]
  /** tool names Claude Code shouldn't ask about, because Corvid enforces their rules itself */
  allowed: string[]
  prompt: string
  /** a line for the worker's first prompt, for steps it must not forget at the end */
  reminder?: string
}

interface Grant {
  token: string
  file: string
}
const grants = new Map<string, Grant>()
const grantDir = (): string => join(app.getPath('userData'), 'mcp')

/** Tokens die with the app, so configs left by a previous run are useless; clear them. */
export function clearStaleGrants(): void {
  rmSync(grantDir(), { recursive: true, force: true })
  // where they lived before notes gave every worker a token
  rmSync(join(app.getPath('userData'), 'remote', 'mcp'), { recursive: true, force: true })
}

/**
 * CLI arguments and system-prompt text that give one worker its tools. The MCP config goes in a
 * file because node-pty doesn't quote JSON arguments reliably. It holds only the localhost URL and
 * this worker's token.
 */
export function grantWorker(endpoint: McpEndpoint, workerId: string, parts: (AccessPart | null)[]): { args: string[]; prompt: string; reminder: string; toolChars: number } {
  const have = parts.filter((p): p is AccessPart => !!p)
  const token = endpoint.addScope(have.flatMap((p) => p.tools))
  mkdirSync(grantDir(), { recursive: true })
  const file = join(grantDir(), `${workerId}.json`)
  writeFileSync(file, JSON.stringify({ mcpServers: { corvid: { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${token}` } } } }))
  grants.set(workerId, { token, file })
  return {
    args: ['--mcp-config', file, '--allowedTools', have.flatMap((p) => p.allowed.map((t) => `mcp__corvid__${t}`)).join(',')],
    prompt: have.flatMap((p) => (p.prompt ? [p.prompt] : [])).join(' '),
    reminder: have.flatMap((p) => (p.reminder ? [p.reminder] : [])).join(' '),
    toolChars: toolChars(have.flatMap((p) => p.tools))
  }
}

/** About how many characters `tools` take in a session's context: names, descriptions and input schemas (#318). */
export function toolChars(tools: ToolDef[]): number {
  return tools.reduce((sum, t) => {
    let schema = ''
    try {
      schema = JSON.stringify(z.toJSONSchema(z.object(t.input)))
    } catch {
      schema = JSON.stringify(Object.keys(t.input))
    }
    return sum + t.name.length + t.description.length + schema.length
  }, 0)
}

export function revokeWorker(endpoint: McpEndpoint, workerId: string): void {
  const g = grants.get(workerId)
  if (!g) return
  grants.delete(workerId)
  endpoint.removeScope(g.token)
  rmSync(g.file, { force: true })
}
