// The user's profile picture: what a file must look like before anything decodes it, and what the
// stored copy is. Formats are told by their first bytes, never the extension, and the size is read
// from the header so a 50000 x 50000 image is turned away before it can take the memory to decode.
// SVG isn't on the list: it's a document that can carry scripts, not a picture.

export type PictureKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp'

export interface PictureInfo {
  kind: PictureKind
  mime: string
  width: number
  height: number
}

/** files bigger than this are refused before they're read */
export const PICTURE_MAX_BYTES = 10 * 1024 * 1024
/** longest side, and total pixels, a picture may have before it's decoded */
export const PICTURE_MAX_SIDE = 12_000
export const PICTURE_MAX_PIXELS = 50_000_000
/** the stored copy: a square PNG this many pixels a side */
export const AVATAR_SIDE = 256
/** the stored copy can't be bigger than this (a 256 x 256 PNG is well under it) */
export const AVATAR_MAX_BYTES = 1024 * 1024
/** what the file picker offers */
export const PICTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

const MIME: Record<PictureKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n))
const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1]
const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8)
const u24le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3])
const i32le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]
    if (m === 0xff) {
      i++
      continue
    }
    // start-of-frame markers carry the size; C4, C8 and CC share the range but aren't frames
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2
      continue
    }
    if (m === 0xda || m === 0xd9) return null
    i += 2 + u16be(b, i + 2)
  }
  return null
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f)
    return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) }
  if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
  return null
}

/** The picture's format and size from its first bytes, or a short reason it isn't one we take. */
export function sniffPicture(b: Uint8Array): PictureInfo | { error: string } {
  if (b.length > PICTURE_MAX_BYTES) return { error: 'That picture is over 10 MB. Try a smaller one.' }
  if (b.length < 16) return { error: "That file isn't a picture Corvid can use." }
  let kind: PictureKind | null = null
  let size: { width: number; height: number } | null = null
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b.length >= 24 && ascii(b, 12, 4) === 'IHDR') {
    kind = 'png'
    size = { width: u32be(b, 16), height: u32be(b, 20) }
  } else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    kind = 'jpeg'
    size = jpegSize(b)
  } else if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') {
    kind = 'gif'
    size = { width: u16le(b, 6), height: u16le(b, 8) }
  } else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    kind = 'webp'
    size = webpSize(b)
  } else if (ascii(b, 0, 2) === 'BM' && b.length >= 26) {
    kind = 'bmp'
    const header = i32le(b, 14)
    size = header === 12 ? { width: u16le(b, 18), height: u16le(b, 20) } : { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) }
  }
  if (!kind) {
    const head = new TextDecoder().decode(b.subarray(0, 1024)).toLowerCase()
    if (head.includes('<svg')) return { error: "SVG pictures aren't supported, as they can carry scripts. Try a PNG or JPG." }
    return { error: "That file isn't a picture Corvid can use. Try a PNG, JPG, WebP, GIF or BMP." }
  }
  if (!size || !size.width || !size.height) return { error: "That picture looks damaged, so Corvid can't read it." }
  if (size.width > PICTURE_MAX_SIDE || size.height > PICTURE_MAX_SIDE || size.width * size.height > PICTURE_MAX_PIXELS)
    return { error: `That picture is ${size.width} x ${size.height}, too big to open safely. Try one under ${PICTURE_MAX_SIDE} pixels a side.` }
  return { kind, mime: MIME[kind], ...size }
}

/** The stored copy is only ever a square PNG of AVATAR_SIDE pixels, small enough to load in one go. */
export function isStoredAvatar(b: Uint8Array): boolean {
  if (b.length > AVATAR_MAX_BYTES) return false
  const info = sniffPicture(b)
  return 'kind' in info && info.kind === 'png' && info.width === AVATAR_SIDE && info.height === AVATAR_SIDE
}
