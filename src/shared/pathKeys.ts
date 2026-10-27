import type { OsName } from './platformInfo'

// Path keys per platform (#151, part of #142). Pure, so main, the window and the tests share them; the platform
// layer (main/platform) re-exports pathKey and within from here. Keys are derived on read: stored paths stay as
// they were typed. The win32 branches are today's normKey and within exactly (scripts/test-platform.mjs pins them).

/** The OS this code runs on: process.platform in the main process and the scripts, the preload's
 *  window.api.platform in the window (which has no process). Unknown: Windows, as before. */
export function hostOs(): OsName {
  const g = globalThis as { process?: { platform?: string }; api?: { platform?: { os?: string } } }
  return osName(g.process?.platform ?? g.api?.platform?.os ?? 'win32')
}

/** Only the platforms Corvid knows about; anything else (freebsd, aix…) is treated as Linux. */
export const osName = (platform: string): OsName => (platform === 'win32' || platform === 'darwin' ? platform : 'linux')

/** The separator pathKey uses: \ on Windows, / elsewhere. */
export const keySep = (platform: string = hostOs()): string => (osName(platform) === 'win32' ? '\\' : '/')

/** A path as a comparison key. Windows: one separator (\), no trailing separators, case folded.
 *  macOS: / kept, case folded (its volumes are case-insensitive by default). Linux: / kept, case kept. */
export function pathKey(p: string, platform: string = hostOs()): string {
  const os = osName(platform)
  if (os === 'win32') return p.replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase()
  const k = p.replace(/\/+$/, '') || (p ? '/' : '')
  return os === 'darwin' ? k.toLowerCase() : k
}

/** Whether pathKey `key` is `folder` or inside it. On POSIX the root "/" contains every absolute path. */
export function within(key: string, folder: string, platform: string = hostOs()): boolean {
  if (osName(platform) === 'win32') return key === folder || key.startsWith(folder + '\\')
  return key === folder || (!!folder && key.startsWith(folder.endsWith('/') ? folder : folder + '/'))
}

/** Whether two paths name the same folder, as git prints them (stray whitespace, either separator on Windows). */
export const samePath = (a: string, b: string, platform: string = hostOs()): boolean => pathKey(a.trim(), platform) === pathKey(b.trim(), platform)
