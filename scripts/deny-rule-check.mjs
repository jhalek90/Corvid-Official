// The deny-rule check by hand (#150, docs/PLATFORM.md): prints the rule Corvid writes for a folder on this
// machine and saves two Claude Code settings files next to each other, one with that rule and one with the
// pre-#150 form (///path on macOS and Linux), so a tester can run a real claude against both.
//
//   node scripts/deny-rule-check.mjs <folder> <where to write deny-new.json and deny-old.json>

import { register } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [folder, out] = process.argv.slice(2)
if (!folder || !out) {
  console.error('usage: node scripts/deny-rule-check.mjs <folder> <output folder>')
  process.exit(1)
}
register('data:text/javascript,' + encodeURIComponent(`export async function load(u, c, next) { return /\\.ts$/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c) }`))
const { absRule } = await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'main', 'platform', 'paths.ts')).href)

const full = resolve(folder)
const rule = `${absRule(full)}/**`
const old = process.platform === 'win32' ? rule : `//${full}/**`
const settings = (r) => JSON.stringify({ permissions: { deny: [`Read(${r})`, `Edit(${r})`] } }, null, 1)
writeFileSync(join(out, 'deny-new.json'), settings(rule))
writeFileSync(join(out, 'deny-old.json'), settings(old))
console.log(`rule now:     ${rule}`)
console.log(`before #150:  ${old}`)
console.log(`wrote ${join(out, 'deny-new.json')} and ${join(out, 'deny-old.json')}`)
