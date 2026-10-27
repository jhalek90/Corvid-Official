// Syntax colouring for the file preview. highlight.js core plus a fixed set of grammars,
// bundled with the app: nothing is fetched. The language comes from the extension only.
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import gml from 'highlight.js/lib/languages/gml'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const GRAMMARS = { bash, csharp, css, gml, ini, javascript, json, markdown, powershell, python, sql, typescript, xml, yaml }
for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar)

const BY_EXT: Record<string, keyof typeof GRAMMARS> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  csproj: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  gml: 'gml',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql'
}

/** Past this many characters the preview stays plain: highlighting a near-256 KB file stalls the pane. */
const MAX_CHARS = 100_000
/** Minified or generated files: one huge line is slow to colour and unreadable either way. */
const MAX_LINE = 5_000

/** The file's text as highlighted HTML (already escaped), or undefined to show it plain. */
export function highlight(name: string, text: string): string | undefined {
  const dot = name.lastIndexOf('.')
  const lang = dot > 0 ? BY_EXT[name.slice(dot + 1).toLowerCase()] : undefined
  if (!lang || text.length > MAX_CHARS) return undefined
  let start = 0
  for (let nl = text.indexOf('\n'); start < text.length; nl = text.indexOf('\n', start)) {
    const end = nl < 0 ? text.length : nl
    if (end - start > MAX_LINE) return undefined
    start = end + 1
  }
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return undefined
  }
}
