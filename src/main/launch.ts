import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { LaunchMode } from '@shared/types'
import { claudeArgs } from './pty'
import { externalTerminal, platformOf, terminalScript, vscodeCommand, vscodeFileUri } from './platform'

const isWin = platformOf() === 'win32'

function detached(cmd: string, args: string[], cwd?: string): void {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: false })
  child.on('error', (e) => console.error(`[launch] ${cmd} failed`, e))
  child.unref()
}

/** Runs VS Code on `paths` (plus -r when reuse is set). Windows quotes each path for cmd.exe, as it always has;
 *  elsewhere they go as plain arguments with no shell. Where there's no `code` (Linux without it on the PATH) the
 *  first path opens through the vscode://file URI instead. */
function runCode(paths: string[], reuse = false): void {
  const targets = isWin ? paths.map((p) => `"${p}"`) : paths
  const code = vscodeCommand(reuse ? ['-r', ...targets] : targets)
  if (!code) {
    void shell.openExternal(vscodeFileUri(paths[paths.length - 1]))
    return
  }
  const child = spawn(code.file, code.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: code.verbatim
  })
  child.on('error', (e) => console.error('[launch] code failed', e))
  child.unref()
}

/** Opens the folder in VS Code, then hands the session to the Claude extension's URI handler. */
export function openInVSCode(cwd: string, sessionId?: string): void {
  runCode([cwd])
  if (sessionId) {
    // Give VS Code a moment to open/focus the folder's window so the URI lands there.
    setTimeout(() => void shell.openExternal(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`), 2500)
  }
}

/** Opens a file in VS Code, in the window that has `root` open (or a new one for it). Never runs the file. */
export function openFileInVSCode(file: string, root?: string): void {
  if (root) runCode([root, file])
  else runCode([file], true)
}

/** A folder for the terminal script: the temp dir when its path is plain, else /tmp (the script's path must have
 *  no spaces or quotes, see externalTerminal). Made 0700 by mkdtemp. */
function scriptDir(): string {
  const base = /^\/[A-Za-z0-9._/-]+$/.test(tmpdir()) ? tmpdir() : '/tmp'
  return mkdtempSync(`${base.replace(/\/+$/, '')}/corvid-term-`)
}

/** Resumes a session in an external terminal: a Windows Terminal tab on Windows (as always), Terminal.app on
 *  macOS and the first terminal found on Linux. Those two run a small 0700 script that deletes itself when it
 *  starts; if it never runs, it's removed after ten minutes. */
export function openInTerminal(bin: string, cwd: string, mode: LaunchMode, sessionId?: string, title?: string): void {
  const args = claudeArgs(mode, sessionId)
  if (isWin) {
    const wt = externalTerminal(cwd, bin, args, title)
    if (wt) detached(wt.file, wt.args)
    return
  }
  const dir = scriptDir()
  const script = `${dir}/resume${platformOf() === 'darwin' ? '.command' : '.sh'}`
  const cleanup = (): void => {
    rmSync(script, { force: true })
    try {
      rmdirSync(dir)
    } catch {
      /* already gone */
    }
  }
  try {
    const cmd = externalTerminal(cwd, bin, args, title, undefined, { script })
    if (!cmd) throw new Error('No terminal found. Set $TERMINAL, or install gnome-terminal, konsole or xterm.')
    writeFileSync(script, terminalScript(script, cwd, bin, args, title), { mode: 0o700, flag: 'wx' })
    detached(cmd.file, cmd.args)
    setTimeout(cleanup, 10 * 60_000).unref()
  } catch (e) {
    cleanup()
    throw e
  }
}

export function revealFile(file: string): void {
  shell.showItemInFolder(file)
}

export function openFolder(dir: string): void {
  void shell.openPath(dir)
}
