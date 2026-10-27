// CI's packaging step (#162): electron-builder --dir for this machine's platform, then the same load check deploy.mjs
// runs before it installs anything: the packaged app's own runtime requires every package the main process uses
// from its app.asar, which catches a native module (node-pty) that wasn't packaged for this platform. No signing,
// no publishing, nothing installed or started.
//
//   npm run build && node scripts/package-check.mjs

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installProfile } from '../src/main/platform/shared.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = installProfile(root)

// no code signing on any platform, and never publish
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
const builder = join(root, 'node_modules', 'electron-builder', 'cli.js')
execFileSync(process.execPath, [builder, ...profile.builderArgs, '--publish', 'never'], { cwd: root, stdio: 'inherit', env })

// every package out/main requires, as deploy.mjs's verifyPackage collects them
const mainDir = join(root, 'out', 'main')
const mods = new Set()
for (const f of readdirSync(mainDir).filter((f) => f.endsWith('.js'))) {
  for (const m of readFileSync(join(mainDir, f), 'utf8').matchAll(/require\(["']([^"'.][^"']*)["']\)/g)) {
    const spec = m[1]
    if (spec === 'electron' || spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) continue
    mods.add(spec)
  }
}

const built = profile.builtDir
const asarPkg = join(profile.resources(built), 'app.asar', 'package.json')
const check = join(tmpdir(), `corvid-package-check-${process.pid}.cjs`)
writeFileSync(
  check,
  [
    `const r = require('module').createRequire(${JSON.stringify(asarPkg)})`,
    `for (const m of ${JSON.stringify([...mods])}) {`,
    `  try { r(m) } catch (e) { console.error(m + ': ' + String(e.message).split(/\\r?\\n/)[0]); process.exitCode = 1 }`,
    `}`
  ].join('\n')
)
try {
  execFileSync(profile.executable(built), [check], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60_000 })
} catch {
  console.error(`Package check failed: the build in ${built} can't load its dependencies (see above).`)
  process.exit(1)
} finally {
  rmSync(check, { force: true })
}
console.log(`Package check passed: ${built} (${mods.size} modules load).`)
