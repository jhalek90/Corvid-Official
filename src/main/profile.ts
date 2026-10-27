import { app, dialog, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PICTURE_EXTENSIONS, PICTURE_MAX_BYTES, isStoredAvatar, sniffPicture } from '@shared/picture'

// The user's profile picture. Only the dashboard's own window can set it, through these handlers;
// no MCP tool reads or writes it, and it's never sent anywhere. It lives in the app's data folder,
// outside every repo, as a small square PNG the window made on a canvas: the original file and its
// path are never kept. The window does the decoding (Chromium's sandboxed image decoders); this side
// only reads the chosen file's bytes, after checking its size, and checks what comes back to store.

const dir = (): string => join(app.getPath('userData'), 'profile')
const file = (): string => join(dir(), 'avatar.png')

/** The stored picture, or null when there's none or it isn't one we wrote (it's then ignored). */
export function readAvatar(): Uint8Array | null {
  try {
    const b = new Uint8Array(readFileSync(file()))
    return isStoredAvatar(b) ? b : null
  } catch {
    return null
  }
}

/** Store the window's processed copy, replacing the old one in one step. */
export function saveAvatar(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !isStoredAvatar(bytes)) throw new Error('That picture could not be saved.')
  mkdirSync(dir(), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, file())
  return bytes
}

export function removeAvatar(): void {
  rmSync(file(), { force: true })
}

/** The system file picker, for pictures only. Hands back the file's bytes, never its path. */
export async function pickPicture(win: BrowserWindow): Promise<{ bytes: Uint8Array } | { error: string } | null> {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a profile picture',
    filters: [{ name: 'Pictures', extensions: PICTURE_EXTENSIONS }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths[0]) return null
  try {
    if (statSync(r.filePaths[0]).size > PICTURE_MAX_BYTES) return { error: 'That picture is over 10 MB. Try a smaller one.' }
    const bytes = new Uint8Array(readFileSync(r.filePaths[0]))
    const info = sniffPicture(bytes)
    return 'error' in info ? info : { bytes }
  } catch {
    return { error: "That file couldn't be opened." }
  }
}
