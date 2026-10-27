// Renders the app/tray icons (a terminal-prompt glyph) to PNG with no image deps.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const BG = [16, 21, 27]
const RING = [42, 50, 60]
const ACCENT = [79, 214, 197]

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const sdRoundBox = (x, y, h, r) => {
  const qx = Math.abs(x) - h + r
  const qy = Math.abs(y) - h + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdSeg = (px, py, ax, ay, bx, by) => {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * h, pay - bay * h)
}

const WARN = [232, 163, 61]

/** Amber "needs you" dot, top-right, with a dark ring so it reads on any taskbar color. */
function badge(buf, size, { cx = 0.76, cy = 0.24, r = 0.17 } = {}) {
  const aa = 1.2 / size
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d / aa))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x + 0.5) / size - cx, (y + 0.5) / size - cy)
      const ring = cov(d - r - 0.06)
      const dot = cov(d - r)
      if (ring <= 0) continue
      const o = (y * size + x) * 4
      for (let i = 0; i < 3; i++) {
        const under = buf[o + i] * (1 - ring) + BG[i] * ring
        buf[o + i] = Math.round(under * (1 - dot) + WARN[i] * dot)
      }
      buf[o + 3] = Math.max(buf[o + 3], Math.round(ring * 255))
    }
  }
}

/** Black glyph and dot on transparent: a macOS template image, which the menu bar tints for light and dark. The dot's
 *  ring is cut out of the glyph instead of being drawn dark. */
function monoBadge(buf, size, { cx = 0.76, cy = 0.24, r = 0.17 } = {}) {
  const aa = 1.2 / size
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d / aa))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x + 0.5) / size - cx, (y + 0.5) / size - cy)
      const o = (y * size + x) * 4
      buf[o + 3] = Math.round(Math.max(buf[o + 3] * (1 - cov(d - r - 0.06)), cov(d - r) * 255))
    }
  }
}

// mono: a template image (black, alpha only). inset: the share of the canvas the plate spans, so the macOS icon
// gets the margin its icon grid expects (824 of 1024 px); 1 draws edge to edge as before.
function render(size, { plate = true, alert = false, mono = false, inset = 1 } = {}) {
  const buf = Buffer.alloc(size * size * 4)
  const k = inset === 1 ? 1 : inset / 0.94
  const aa = 1.2 / size / k
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d / aa))
  const th = plate ? 0.045 : 0.075
  const ink = mono ? [0, 0, 0] : ACCENT
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size - 0.5) / k + 0.5, v = ((y + 0.5) / size - 0.5) / k + 0.5
      let col = [0, 0, 0], a = 0
      if (plate) {
        const box = sdRoundBox(u - 0.5, v - 0.5, 0.47, 0.13)
        const fill = cov(box)
        const ring = cov(Math.abs(box + 0.012) - 0.008)
        col = BG.map((c, i) => c * (1 - ring) + RING[i] * ring)
        a = fill
      }
      const s = plate ? 1 : 1.25
      const ox = plate ? 0 : -0.06
      const tu = (u - 0.5) * s + 0.5 - ox, tv = (v - 0.5) * s + 0.5
      const glyph = Math.min(
        sdSeg(tu, tv, 0.3, 0.33, 0.47, 0.5),
        sdSeg(tu, tv, 0.47, 0.5, 0.3, 0.67),
        sdSeg(tu, tv, 0.55, 0.67, 0.71, 0.67)
      ) - th
      const g = cov(glyph)
      col = col.map((c, i) => c * (1 - g) + ink[i] * g)
      a = Math.max(a, g)
      const o = (y * size + x) * 4
      buf[o] = Math.round(col[0]); buf[o + 1] = Math.round(col[1]); buf[o + 2] = Math.round(col[2])
      buf[o + 3] = Math.round(a * 255)
    }
  }
  if (alert) (mono ? monoBadge : badge)(buf, size)
  return png(size, buf)
}

function overlay(size) {
  const buf = Buffer.alloc(size * size * 4)
  badge(buf, size, { cx: 0.5, cy: 0.5, r: 0.36 })
  return png(size, buf)
}

mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.png', render(256))
writeFileSync('resources/tray.png', render(32))
writeFileSync('resources/tray@2x.png', render(64))
writeFileSync('resources/tray-alert.png', render(32, { alert: true }))
writeFileSync('resources/tray-alert@2x.png', render(64, { alert: true }))
writeFileSync('resources/overlay-alert.png', overlay(32))
// macOS (#155): the app icon electron-builder turns into the .icns, and the menu bar's template images (16 pt)
writeFileSync('resources/icon-1024.png', render(1024, { inset: 824 / 1024 }))
writeFileSync('resources/trayTemplate.png', render(16, { plate: false, mono: true }))
writeFileSync('resources/trayTemplate@2x.png', render(32, { plate: false, mono: true }))
writeFileSync('resources/tray-alertTemplate.png', render(16, { plate: false, mono: true, alert: true }))
writeFileSync('resources/tray-alertTemplate@2x.png', render(32, { plate: false, mono: true, alert: true }))
console.log('icons written')
