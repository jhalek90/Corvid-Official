// Electron's binary (#175): electron 44 no longer downloads it on npm install (its install.js became opt-in), so a
// fresh `npm ci` left node_modules/electron without dist/ and path.txt, and setup, npm start and npm run dev failed.
//
// Run as the "postinstall" script, and by setup.mjs after npm ci. When the binary is already there it does nothing
// and prints nothing. Otherwise it runs Electron's own installer, which downloads the zip (ELECTRON_MIRROR, proxy
// settings and electron_config_cache apply: this script passes the environment through as it is), checks it
// against the package's checksums.json and unpacks it.
//
// As postinstall it never fails the install: offline, `npm ci` still succeeds with a one-line note, and setup
// (or npm start, which then fails with "Electron uninstall") points at the same fix. ELECTRON_SKIP_BINARY_DOWNLOAD=1
// skips it there, like electron's old postinstall did. `npm ci --ignore-scripts` doesn't run it at all; setup does.
//
//   node scripts/electron-binary.mjs            the postinstall: a note on failure, exit 0
//   node scripts/electron-binary.mjs --strict   exit 1 when the binary is still missing afterwards
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ELECTRON_INSTALLER, electronNeedsDownload } from '../src/main/platform/shared.mjs'

/** How setup and the postinstall run Electron's installer: node, with the environment untouched. */
function runInstaller(installer, { quiet }) {
  const r = spawnSync(process.execPath, [installer], { stdio: ['ignore', 'inherit', quiet ? 'pipe' : 'inherit'], encoding: 'utf8' })
  return { ok: r.status === 0, error: r.error?.message || (r.stderr || '').trim().split(/\r?\n/)[0] || '' }
}

/**
 * Download Electron's binary into `<root>/node_modules` if it's missing. Returns what happened:
 * { ran: false } when nothing was needed or it was skipped, { ran: true, ok, error } after running the installer.
 */
export function ensureElectronBinary(root, { postinstall = false, env = process.env, platform = process.platform, exists, run = runInstaller, log = console.log } = {}) {
  const nm = join(root, 'node_modules')
  if (!electronNeedsDownload(nm, platform, exists)) return { ran: false }
  if (postinstall && env.ELECTRON_SKIP_BINARY_DOWNLOAD) return { ran: false, skipped: true }
  log("Downloading Electron's binary (once per install of the electron package)…")
  const r = run(join(nm, ELECTRON_INSTALLER), { quiet: postinstall })
  if (!r.ok && postinstall) {
    log(`Couldn't download Electron's binary${r.error ? ` (${r.error})` : ''}. npm run setup tries again, or run: node node_modules/electron/install.js`)
  }
  return { ran: true, ...r }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const strict = process.argv.includes('--strict')
  const r = ensureElectronBinary(join(import.meta.dirname, '..'), { postinstall: !strict })
  process.exit(strict && r.ran && !r.ok ? 1 : 0)
}
