// Builds docs.json from the front matter in docs/: the nav tree (sections, pages, titles, summaries, order, paths)
// and a plain search text per page. The logic is in docs-lib.mjs; this file reads the folder and writes the result.
//
//   npm run docs:manifest                     writes out/docs/docs.json
//   node scripts/docs-manifest.mjs --out F    writes F instead; --stdout prints it
//
// Exits 1, listing each problem as file:line, when a page has no front matter, a duplicate order, an unknown section
// or a link to a missing page.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest } from './docs-lib.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Reads docs/ into what buildManifest takes: every .md file with its text, the other files as assets, and the
// sections from docs/sections.json. Paths are relative to docs/ with forward slashes.
export function readDocsTree(docsDir = join(repo, 'docs')) {
  const files = []
  const assets = new Set()
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else {
        const path = relative(docsDir, full).split('\\').join('/')
        if (path.endsWith('.md')) files.push({ path, text: readFileSync(full, 'utf8') })
        else assets.add(path)
      }
    }
  }
  walk(docsDir)
  let sections = []
  const errors = []
  try {
    sections = JSON.parse(readFileSync(join(docsDir, 'sections.json'), 'utf8')).sections
    if (!Array.isArray(sections)) throw new Error('it has no "sections" list')
  } catch (e) {
    errors.push({ path: 'sections.json', line: 1, message: `can't read docs/sections.json: ${e.message}` })
    sections = []
  }
  return { files, assets, sections, errors }
}

export function buildFromDisk(docsDir) {
  const tree = readDocsTree(docsDir)
  const { manifest, errors } = buildManifest(tree)
  return { manifest, errors: [...tree.errors, ...errors] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const { manifest, errors } = buildFromDisk()
  for (const e of errors) console.error(`docs/${e.path}:${e.line}: ${e.message}`)
  if (errors.length) {
    console.error(`docs manifest: ${errors.length} problem${errors.length === 1 ? '' : 's'}, nothing written`)
    process.exit(1)
  }
  const json = JSON.stringify(manifest, null, 2) + '\n'
  if (args.includes('--stdout')) process.stdout.write(json)
  else {
    const i = args.indexOf('--out')
    const out = i >= 0 && args[i + 1] ? resolve(args[i + 1]) : join(repo, 'out', 'docs', 'docs.json')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, json)
    const pages = manifest.sections.reduce((n, s) => n + s.pages.length, 0)
    console.log(`docs manifest: ${manifest.sections.length} sections, ${pages} pages -> ${relative(repo, out)}`)
  }
}
