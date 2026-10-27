// Types for docs-lib.mjs, so the app (src/shared/docs.ts) can import it from TypeScript.

export interface DocsPageRef {
  title: string
  summary: string
  order: number
  path: string
}
export interface DocsSection {
  id: string
  title: string
  order: number
  pages: DocsPageRef[]
}
export interface DocsSearchEntry {
  path: string
  title: string
  section: string | null
  headings: string[]
  text: string
}
export interface DocsManifest {
  version: 1
  index: { title: string; summary: string; path: string } | null
  sections: DocsSection[]
  search: DocsSearchEntry[]
}
export interface DocsError {
  path: string
  line: number
  message: string
}

export const PAGE_FIELDS: string[]
export function parseFrontMatter(text: string): { data?: Record<string, string>; body: string; bodyLine: number; error?: string; line?: number }
export function slugify(heading: string): string
export function plainInline(s: string): string
export function isInternal(target: string): boolean
export function resolveLink(fromPath: string, target: string): { path: string; anchor: string; outside: boolean }
export function searchText(body: string): { headings: string[]; text: string }
export function buildManifest(input: {
  files: { path: string; text: string }[]
  sections: { id: string; title: string; order: number }[]
  assets?: Set<string>
}): { manifest: DocsManifest; errors: DocsError[] }
