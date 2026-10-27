import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ZodRawShape } from 'zod'
import { headUnits } from '@shared/text'

export interface ToolDef {
  name: string
  description: string
  input: ZodRawShape
  readOnly?: boolean
  run: (args: any) => Promise<unknown> | unknown
}

export interface McpEndpoint {
  url: string
  token: string
  server: Server
  /** A further token that sees only `tools` (a worker's project-bound remote tools). */
  addScope: (tools: ToolDef[]) => string
  removeScope: (token: string) => void
}

const MAX_RESULT = 24_000

function asText(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > MAX_RESULT ? headUnits(s, MAX_RESULT) + ' …[truncated]' : s
}

/** A tool's answer as text blocks: a paged result (#104) sends the page and its footer apart, so the page stays valid JSON. */
const asContent = (v: unknown): ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] => {
  // an attached image (#147): the text first, then the picture, so the reader sees it as an image
  const image = (v as { image?: { data: string; mimeType: string }; text?: string } | null)?.image
  if (image) return [{ type: 'text' as const, text: asText(String((v as { text?: string }).text ?? '')) }, { type: 'image' as const, ...image }]
  const parts = (v as { textParts?: unknown } | null)?.textParts
  return Array.isArray(parts) ? parts.map((p) => ({ type: 'text' as const, text: asText(String(p)) })) : [{ type: 'text' as const, text: asText(v) }]
}

/**
 * The dashboard's tools for the assistant, served as MCP over HTTP on localhost.
 * A random bearer token keeps other local processes out. Each token has its own set of tools:
 * the assistant's, or one worker's.
 */
export function startMcp(assistantTools: ToolDef[]): Promise<McpEndpoint> {
  const token = randomBytes(24).toString('hex')
  const scopes = new Map<string, ToolDef[]>([[token, assistantTools]])
  const server = createServer((req, res) => {
    const bearer = /^Bearer (\w+)$/.exec(req.headers.authorization ?? '')?.[1]
    const tools = bearer ? scopes.get(bearer) : undefined
    if (!tools) {
      res.writeHead(401).end()
      return
    }
    // Stateless: a fresh MCP server per request, as the SDK recommends for this mode.
    const mcp = new McpServer({ name: 'dashboard', version: '1.0.0' })
    for (const t of tools) {
      mcp.registerTool(
        t.name,
        { description: t.description, inputSchema: t.input, annotations: { readOnlyHint: !!t.readOnly } },
        async (args: any) => {
          try {
            return { content: asContent(await t.run(args ?? {})) }
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true }
          }
        }
      )
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      await mcp.connect(transport)
      let parsed: unknown
      try {
        parsed = body ? JSON.parse(body) : undefined
      } catch {
        res.writeHead(400).end()
        return
      }
      await transport.handleRequest(req, res, parsed)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        server,
        addScope: (tools) => {
          const t = randomBytes(24).toString('hex')
          scopes.set(t, tools)
          return t
        },
        removeScope: (t) => void (t !== token && scopes.delete(t))
      })
    })
  })
}
