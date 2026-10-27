// The docs linter: checks the docs in docs/ against the mechanical rules of ASD+ (docs/ASD-PLUS.md) and the docs'
// own structure, and prints each finding as file:line with its rule. Errors fail the run, warnings only print.
// The checks are in docs-lint-lib.mjs; docs/WRITING.md says what each one means.
//
//   npm run docs:lint                         the docs pages, index.md and docs/WRITING.md
//   node scripts/docs-lint.mjs FILE...        other Markdown files too (prose, headings and links only)
//   node scripts/docs-lint.mjs --legacy       the older docs: README, INSTALL, CONTRIBUTING and docs/*.md
//   --quiet                                   errors only

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDocsTree } from './docs-manifest.mjs'
import { formatFinding, lintMarkdown, lintTree, parseStandard } from './docs-lint-lib.mjs'
import { isInternal } from './docs-lib.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(repo, 'docs')
const LEGACY = ['README.md', 'INSTALL.md', 'CONTRIBUTING.md', 'docs/CONNECTORS.md', 'docs/EXTENSIONS.md',
  'docs/PLATFORM.md', 'docs/SECURITY.md', 'docs/TESTING-PLATFORMS.md']

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const files = args.filter((a) => !a.startsWith('--'))
if (args.includes('--legacy')) files.push(...LEGACY)

const standardPath = join(docs, 'ASD-PLUS.md')
const standardText = existsSync(standardPath) ? readFileSync(standardPath, 'utf8') : null
let findings = []
let prefix = 'docs/'

if (!files.length) {
  const tree = readDocsTree(docs)
  const extra = ['WRITING.md'].filter((p) => tree.files.some((f) => f.path === p)).map((p) => tree.files.find((f) => f.path === p))
  findings = [...tree.errors.map((e) => ({ ...e, level: 'error', rule: 'front-matter' })), ...lintTree({ ...tree, standardText, extra })]
} else {
  // other files: prose, headings, alt text and links that point at files that don't exist
  prefix = ''
  const standard = standardText == null ? null : parseStandard(standardText)
  if (!standard) console.error('docs/ASD-PLUS.md is missing: the banned words and weasel words are not checked')
  for (const file of files) {
    const full = resolve(repo, file)
    if (!existsSync(full)) { findings.push({ path: file, line: 1, level: 'error', rule: 'links', message: 'no such file' }); continue }
    const path = relative(repo, full).split('\\').join('/')
    const checkLink = (link) => {
      if (!isInternal(link.target)) return null
      const target = decodeURI(link.target.split('#')[0])
      return target && !existsSync(resolve(dirname(full), target)) ? `${link.image ? 'image' : 'link'} to a missing file: ${link.target}` : null
    }
    findings.push(...lintMarkdown(readFileSync(full, 'utf8'), { path, standard, checkLink }))
  }
}

const errors = findings.filter((f) => f.level === 'error')
for (const f of findings) if (!quiet || f.level === 'error') console.log(formatFinding(f, prefix))
const warns = findings.length - errors.length
console.log(`docs lint: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`)
process.exit(errors.length ? 1 : 0)
