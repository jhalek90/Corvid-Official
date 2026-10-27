import { app } from 'electron'
import { access, open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import type { FileEntry, FilePlace, FilePreview } from '@shared/types'

/** Enough for any real source folder; node_modules and friends get cut off. */
const MAX_ENTRIES = 2000

/** One level of a folder for the explorer: folders first, then files, by name. `.git` is noise. */
export async function listDir(dir: string): Promise<{ entries: FileEntry[]; truncated: number }> {
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents
      .filter((d) => d.name !== '.git')
      .map(async (d): Promise<FileEntry> => {
        const path = join(dir, d.name)
        let isDir = d.isDirectory()
        // Junctions/symlinks report as links; follow them so linked folders still expand.
        if (d.isSymbolicLink()) isDir = await stat(path).then((s) => s.isDirectory(), () => false)
        return { name: d.name, path, dir: isDir }
      })
  )
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.dir ? -1 : 1))
  return { entries: entries.slice(0, MAX_ENTRIES), truncated: Math.max(0, entries.length - MAX_ENTRIES) }
}

/** Drive letters that are actually mounted. A-B are skipped: probing a floppy slot can stall. Elsewhere the root
 *  and the mounted volumes under it: /Volumes/* on macOS, /media/$USER/* and /mnt/* on Linux (#151). */
export async function listDrives(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  list: (dir: string) => Promise<string[]> = (d) => readdir(d),
  real: (p: string) => Promise<string> = (p) => realpath(p)
): Promise<FileEntry[]> {
  if (platform !== 'win32') return [{ name: '/', path: '/', dir: true }, ...(await mountedVolumes(platform, env, list, real))]
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const found = await Promise.all(letters.map((l) => access(`${l}:\\`).then(() => true, () => false)))
  return letters.filter((_, i) => found[i]).map((l) => ({ name: `${l}:`, path: `${l}:\\`, dir: true }))
}

async function mountedVolumes(platform: string, env: NodeJS.ProcessEnv, list: (dir: string) => Promise<string[]>, real: (p: string) => Promise<string>): Promise<FileEntry[]> {
  const parents = platform === 'darwin' ? ['/Volumes'] : [env.USER ? posix.join('/media', env.USER) : '', '/mnt'].filter(Boolean)
  const out: FileEntry[] = []
  for (const parent of parents) {
    for (const name of (await list(parent).catch(() => [] as string[])).sort()) {
      if (name.startsWith('.')) continue
      const path = posix.join(parent, name)
      // macOS lists the startup disk too ("Macintosh HD", a link to /), which the root entry already is
      if ((await real(path).catch(() => path)) === '/') continue
      out.push({ name, path, dir: true })
    }
  }
  return out
}

/** Known folders via Electron, so OneDrive-redirected Desktop/Documents resolve to where they really are. */
export function listPlaces(): FilePlace[] {
  const names = { home: 'Home', desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads' } as const
  const out: FilePlace[] = []
  for (const [key, name] of Object.entries(names)) {
    try {
      out.push({ name, path: app.getPath(key as keyof typeof names) })
    } catch {
      /* not every platform has every folder */
    }
  }
  return out
}

/** Text shown in the preview pane; bigger files are cut, not refused. */
const PREVIEW_BYTES = 256 * 1024

/** Formats Chromium can draw in an <img>. SVG stays a text preview: it's source people read. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/** Images go over IPC whole, as base64; past this they're described, not shown. */
const PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024

/** Reads the head of a file as text. Anything with NUL bytes (and no UTF-16 BOM) counts as binary. Known images come back whole. */
export async function readPreview(file: string): Promise<FilePreview> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const mime = IMAGE_MIME[extname(file).slice(1).toLowerCase()]
    if (mime) {
      if (size > PREVIEW_IMAGE_BYTES) return { size, image: null }
      return { size, image: `data:${mime};base64,${(await fh.readFile()).toString('base64')}` }
    }
    const buf = Buffer.alloc(Math.min(size, PREVIEW_BYTES))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)
    const truncated = bytesRead < size
    if (head[0] === 0xff && head[1] === 0xfe) return { size, text: head.subarray(2).toString('utf16le'), truncated }
    if (head.subarray(0, 8192).includes(0)) return { size, binary: true }
    // A cut can land mid-character; drop the replacement char that leaves at the end.
    let text = head.toString('utf8').replace(/^\uFEFF/, '')
    if (truncated) text = text.replace(/\uFFFD$/, '')
    return { size, text, truncated }
  } finally {
    await fh.close()
  }
}
