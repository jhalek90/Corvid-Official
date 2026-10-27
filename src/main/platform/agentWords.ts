import { platformOf } from './shared.mjs'

// Commands named in what workers are told (#151): the git tool's worktree rules (gitTools.ts) and the
// "never kill Corvid by name" line (workers.ts). Windows wording is today's, unchanged.

/** How a worker removes its worktree's node_modules link without touching the main folder's packages.
 *  POSIX: plain rm, no -r and no trailing slash: "rm -rf node_modules/" follows the link and empties the target. */
export function unlinkDepsCommand(platform: string = process.platform): string {
  return platformOf(platform) === 'win32' ? 'cmd /c rmdir node_modules' : 'rm node_modules'
}

/** The warning that goes with unlinkDepsCommand, or nothing where the command can't follow the link. */
export function unlinkDepsWarning(platform: string = process.platform): string {
  return platformOf(platform) === 'win32' ? '' : ` (no -r and no trailing slash: "rm -rf node_modules/" follows the link and deletes the main folder's packages)`
}

/** Examples of killing a program by name, which workers must never do to Corvid. */
export function killByNameExamples(platform: string = process.platform): string {
  return platformOf(platform) === 'win32' ? 'taskkill /IM, Stop-Process -Name' : 'pkill, killall'
}
