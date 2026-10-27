import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { pathsOf, platformOf, toNative } from './shared.mjs'

// Paths per platform (#149). The win32 branches are today's Windows code, moved unchanged:
//   pathKey = normKey (shared/projectList.ts) = projectKey (shared/projects.ts) after / to \
//   within  = within (shared/projectList.ts)
//   absRule = absRule (main/agentDeny.ts), which now calls this one (#150)
//   tempDirs = the tempDirs of skipEnv (main/projectStore.ts)
// The call sites still use their own copies; scripts/test-platform.mjs checks both agree on Windows.

export { toNative }
// pathKey and within live in shared/pathKeys.ts (#151) so the window's project keys use the same rules.
export { pathKey, within } from '@shared/pathKeys'

/** Claude Code's absolute-path form of a path for permission rules (gitignore syntax, // anchors at the
 *  filesystem root): //c/Users/... on Windows, //Users/... and //home/... on macOS and Linux (#150).
 *  POSIX paths are resolved first (no trailing or doubled slashes, no ..) and gitignore's special characters
 *  are escaped, so a folder like "repo [old]" is matched literally rather than as a character class. */
export function absRule(p: string, platform: string = process.platform): string {
  if (platformOf(platform) !== 'win32') return `/${posix.resolve(p).replace(/[\\[\]*?]/g, '\\$&')}`
  return `//${p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase())}`
}

/** The folders that count as temporary, for the project import's skip rules. */
export function tempDirs(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): string[] {
  const os = platformOf(platform)
  if (os === 'win32') {
    const local = env.LOCALAPPDATA
    return [tmp, local ? pathsOf(os).join(local, 'Temp') : '', env.TEMP ?? '', env.TMP ?? ''].filter(Boolean)
  }
  // macOS: tmpdir() is /var/folders/..., which realpath shows as /private/var/folders/...
  if (os === 'darwin') return [tmp, tmp.startsWith('/var/') ? '/private' + tmp : '', env.TMPDIR ?? ''].filter(Boolean)
  return [tmp, env.TMPDIR ?? '', '/tmp'].filter((d, i, all) => d && all.indexOf(d) === i)
}
