// Linux Chromium sandbox check for setup (#158). Ubuntu 23.10+ blocks unprivileged user namespaces for apps
// AppArmor doesn't know (kernel.apparmor_restrict_unprivileged_userns=1), so Electron's sandbox can't start and the
// app dies with a chrome-sandbox / "No usable sandbox!" error. Corvid keeps sandbox: true (no --no-sandbox); the
// fix is a one-time sudo step, which setup prints and never runs itself. Everything here is a pure function of
// what it's given (sysctl text, file facts, error text), so test-linux-desktop.mjs can fake each case.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'

export const RESTRICT_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
export const PROFILE_FILE = '/etc/apparmor.d/corvid'

/** A sysctl file's value: true for 1, false for 0, undefined when it's missing or unreadable. */
export function sysctlOn(text) {
  const v = String(text ?? '').trim()
  return v === '1' ? true : v === '0' ? false : undefined
}

/** Chromium's sandbox errors: the SUID helper not set up, or no user namespace and no SUID helper. */
export function isSandboxError(text) {
  return /No usable sandbox!|SUID sandbox helper binary was found, but is not configured correctly|chrome-sandbox is owned by root and has mode 4755|apparmor-userns-restrictions|Failed to move to new namespace/i.test(
    String(text ?? '')
  )
}

/** Whether a chrome-sandbox file is the setuid-root helper (uid 0, mode 4755 or with the setuid bit). */
export const suidRoot = (st) => !!st && st.uid === 0 && (st.mode & 0o4000) !== 0

/**
 * What blocks the sandbox for these executables, given the facts:
 *  - restricted: the sysctl (true, false or undefined when it isn't there: older kernels, other distros)
 *  - profile: whether /etc/apparmor.d/corvid exists
 *  - sandboxes: for each executable, its chrome-sandbox's stat (or null)
 * 'ok' when nothing blocks it; 'restricted' when the sysctl is on and neither fix is in place for some executable.
 */
export function sandboxState({ restricted, profile, sandboxes }) {
  if (restricted !== true || profile) return 'ok'
  return sandboxes.every((st) => suidRoot(st)) ? 'ok' : 'restricted'
}

/** A path for an AppArmor profile header: quoted when it has spaces or quotes. */
const aaPath = (p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)

/** The AppArmor profile text: one unconfined profile with userns per executable (the installed app, and the
 *  development Electron that npm start runs). */
export function profileText(executables) {
  const blocks = executables.map(
    (exe, i) => `profile ${i ? `corvid-${i + 1}` : 'corvid'} ${aaPath(exe)} flags=(unconfined) {\n  userns,\n\n  include if exists <local/corvid>\n}`
  )
  return ['abi <abi/4.0>,', 'include <tunables/global>', '', ...blocks, ''].join('\n')
}

/** Single-quotes a path for the printed shell commands. */
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`

/** The message and exact commands to print: (a) the AppArmor profile (survives updates), (b) the setuid helper
 *  (redone after every update, because deploy copies a fresh chrome-sandbox). */
export function sandboxFix(executables, sandboxPaths) {
  return [
    "This Linux blocks Chromium's sandbox for apps AppArmor doesn't know (kernel.apparmor_restrict_unprivileged_userns = 1),",
    'so Corvid would fail to start with a chrome-sandbox error. Corvid keeps its sandbox on; allow it once with sudo:',
    '',
    '  (a) An AppArmor profile for Corvid (recommended; it survives updates):',
    '',
    `  sudo tee ${PROFILE_FILE} > /dev/null <<'EOF'`,
    ...profileText(executables).trimEnd().split('\n').map((l) => (l ? `  ${l}` : '')),
    '  EOF',
    `  sudo apparmor_parser -r ${PROFILE_FILE}`,
    '',
    '  (b) Or make chrome-sandbox setuid root (must be redone after every npm run deploy):',
    '',
    ...sandboxPaths.flatMap((p) => [`  sudo chown root:root ${sh(p)}`, `  sudo chmod 4755 ${sh(p)}`]),
    '',
    'Then start Corvid again. Setup never runs sudo itself.'
  ]
}

/** Reads the facts on this machine and returns the lines to print, or null when nothing blocks the sandbox (or this
 *  isn't Linux). `executables` are the Electron binaries that will run (each with chrome-sandbox beside it). */
export function checkSandbox(executables, { platform = process.platform, read = (p) => readFileSync(p, 'utf8'), exists = existsSync, stat = statSync } = {}) {
  if (platform !== 'linux') return null
  let restricted
  try {
    restricted = sysctlOn(read(RESTRICT_SYSCTL))
  } catch {
    restricted = undefined
  }
  const sandboxPaths = executables.map((exe) => posix.join(posix.dirname(exe), 'chrome-sandbox'))
  const sandboxes = sandboxPaths.map((p) => {
    try {
      return stat(p)
    } catch {
      return null
    }
  })
  const state = sandboxState({ restricted, profile: exists(PROFILE_FILE), sandboxes })
  return state === 'ok' ? null : sandboxFix(executables, sandboxPaths)
}
