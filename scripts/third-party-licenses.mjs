// Counts the licenses of Corvid's installed production packages, for THIRD_PARTY_NOTICES.md.
// It reads `npm ls --omit=dev --all` and each installed package's own package.json; it changes nothing.
//
//   node scripts/third-party-licenses.mjs
//
// Copy the counts into THIRD_PARTY_NOTICES.md by hand, with the date. Optional packages for other
// platforms (node-pty's other builds) aren't installed, so they aren't counted.
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('node_modules')) {
  console.error('node_modules is missing; run npm ci first')
  process.exit(1)
}
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json --long', { maxBuffer: 1 << 28 }).toString())

// One entry per installed package folder; npm ls repeats a package under every parent that uses it.
const folders = new Map()
function walk(deps) {
  for (const dep of Object.values(deps || {})) {
    if (!dep.path) continue // an optional package that isn't installed here
    if (!folders.has(dep.path)) folders.set(dep.path, readPackage(dep.path))
    walk(dep.dependencies)
  }
}

function readPackage(path) {
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  let license = pkg.license
  if (license && typeof license === 'object') license = license.type
  // Old packages (ssh2, cpu-features, buildcheck) use a "licenses" array instead.
  if (!license && Array.isArray(pkg.licenses)) license = pkg.licenses.map((l) => l.type || l).join(' OR ')
  const hasFile = readdirSync(path).some((f) => /^(licen[cs]e|copying)/i.test(f))
  return { name: pkg.name, license: license || 'UNKNOWN', hasFile }
}

walk(tree.dependencies)

const byLicense = new Map()
for (const pkg of folders.values()) {
  if (!byLicense.has(pkg.license)) byLicense.set(pkg.license, new Set())
  byLicense.get(pkg.license).add(pkg.name)
}
const count = (license) => [...folders.values()].filter((p) => p.license === license).length

console.log(`${folders.size} production package folders installed`)
for (const [license, names] of [...byLicense].sort((a, b) => count(b[0]) - count(a[0]))) {
  const list = names.size <= 12 ? `: ${[...names].join(', ')}` : ''
  console.log(`  ${license}: ${count(license)}${list}`)
}
const flagged = [...folders.values()].filter((p) => /GPL|UNKNOWN/i.test(p.license))
console.log(flagged.length ? `GPL-family or unknown: ${flagged.map((p) => p.name).join(', ')}` : 'No GPL-family or unknown licenses')
const noFile = [...new Set([...folders.values()].filter((p) => !p.hasFile).map((p) => p.name))]
console.log(`No license file in the package folder: ${noFile.join(', ') || 'none'}`)
