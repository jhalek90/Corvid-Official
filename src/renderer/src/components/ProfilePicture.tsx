import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SettingLabel } from './Tooltip'
import { AVATAR_SIDE, PICTURE_MAX_BYTES, sniffPicture } from '@shared/picture'
import { api } from '../api'
import { toast, useStore } from '../store'
import { UserBadge } from './AgentAvatar'

// The user's profile picture in Settings: a round preview with Choose and Remove, and a picture can
// be dropped on the preview or pasted while it has focus. Every way in goes through the same checks
// (sniffPicture: the real format from the first bytes, the size, the dimensions from the header)
// before Chromium decodes it with createImageBitmap, which takes the first frame of an animation.
// The cropper then draws the chosen square onto a canvas and saves that as a new PNG: only pixels
// are copied, so EXIF (location, camera, names) and every other bit of the original stay behind.

interface Source {
  bmp: ImageBitmap
  w: number
  h: number
}

/** where the square sits: its centre in the picture's pixels, and how far in it is zoomed */
interface Crop {
  zoom: number
  cx: number
  cy: number
}

const STAGE = 240
/** the sizes it shows at: the board, the narrow board, a note's author chip */
const PREVIEWS = [
  { size: 40, label: 'Board' },
  { size: 32, label: 'Narrow' },
  { size: 16, label: 'Notes' }
]
const TOO_BIG = 'That picture is over 10 MB. Try a smaller one.'

const side = (src: Source, zoom: number): number => Math.min(src.w, src.h) / zoom
/** zoom in until the square is 16 pixels of the picture, or 8x, whichever comes first */
const maxZoom = (src: Source): number => Math.max(1, Math.min(8, Math.min(src.w, src.h) / 16))

function clampCrop(src: Source, c: Crop): Crop {
  const zoom = Math.min(Math.max(c.zoom, 1), maxZoom(src))
  const half = side(src, zoom) / 2
  return { zoom, cx: Math.min(Math.max(c.cx, half), src.w - half), cy: Math.min(Math.max(c.cy, half), src.h - half) }
}

function draw(canvas: HTMLCanvasElement | null, size: number, src: Source, c: Crop): void {
  if (!canvas) return
  const px = Math.round(size * (window.devicePixelRatio || 1))
  if (canvas.width !== px) canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const s = side(src, c.zoom)
  ctx.imageSmoothingQuality = 'high'
  ctx.clearRect(0, 0, px, px)
  ctx.drawImage(src.bmp, c.cx - s / 2, c.cy - s / 2, s, s, 0, 0, px, px)
}

/** The stored copy: the square, shrunk in halving steps so a big photo stays smooth, as a fresh PNG. */
async function renderAvatar(src: Source, c: Crop): Promise<Uint8Array> {
  let from: CanvasImageSource = src.bmp
  let s = side(src, c.zoom)
  let sx = c.cx - s / 2
  let sy = c.cy - s / 2
  while (s > AVATAR_SIDE * 2) {
    const n = Math.ceil(s / 2)
    const step = document.createElement('canvas')
    step.width = step.height = n
    const ctx = step.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(from, sx, sy, s, s, 0, 0, n, n)
    from = step
    s = n
    sx = sy = 0
  }
  const out = document.createElement('canvas')
  out.width = out.height = AVATAR_SIDE
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(from, sx, sy, s, s, 0, 0, AVATAR_SIDE, AVATAR_SIDE)
  const blob = await new Promise<Blob | null>((done) => out.toBlob(done, 'image/png'))
  if (!blob) throw new Error('encode failed')
  return new Uint8Array(await blob.arrayBuffer())
}

async function decode(bytes: Uint8Array): Promise<Source | string> {
  const info = sniffPicture(bytes)
  if ('error' in info) return info.error
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: info.mime }))
    return { bmp, w: bmp.width, h: bmp.height }
  } catch {
    return "That picture couldn't be read. It may be damaged."
  }
}

export function ProfilePicture(): ReactNode {
  const url = useStore((s) => s.userAvatar)
  const name = useStore((s) => s.config?.userName)
  const [error, setError] = useState('')
  const [src, setSrc] = useState<Source | null>(null)
  const [over, setOver] = useState(false)

  const open = async (bytes: Uint8Array): Promise<void> => {
    setError('')
    const r = await decode(bytes)
    if (typeof r === 'string') setError(r)
    else setSrc(r)
  }
  const fromFile = async (f: File | undefined): Promise<void> => {
    if (!f) return
    if (f.size > PICTURE_MAX_BYTES) return setError(TOO_BIG)
    await open(new Uint8Array(await f.arrayBuffer()))
  }
  const choose = async (): Promise<void> => {
    const r = await api.profilePick()
    if (!r) return
    if ('error' in r) setError(r.error)
    else await open(r.bytes)
  }
  const remove = async (): Promise<void> => {
    setError('')
    await api.profileRemove()
    toast('Profile picture removed')
  }
  const close = (): void => {
    src?.bmp.close()
    setSrc(null)
  }

  return (
    <div
      className="card setting profile-pic"
      onPaste={(e) => {
        const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'))
        if (!f) return
        e.preventDefault()
        void fromFile(f)
      }}
    >
      <div className="pp-main">
        <button
          className={`pp-drop${over ? ' over' : ''}`}
          title="Choose a picture, or drop or paste one here"
          aria-label="Choose a profile picture"
          onClick={() => void choose()}
          onDragOver={(e) => {
            if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            void fromFile(e.dataTransfer.files[0])
          }}
        >
          <UserBadge size={56} name={name} />
        </button>
        <div>
          <SettingLabel
            label="Profile picture"
            tip="Shown beside your messages on the board and on your notes. Drop or paste a picture on the circle, or choose one. Corvid keeps a small square copy in its own data folder, without the photo's details; it stays on this PC and agents never see it."
          />
          {error && (
            <div className="pp-error" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
      <div className="pp-buttons">
        <button className="btn" onClick={() => void choose()}>
          Choose picture…
        </button>
        <button className="btn ghost" disabled={!url} onClick={() => void remove()}>
          Remove
        </button>
      </div>
      {src && (
        <Cropper
          src={src}
          onClose={close}
          onError={(msg) => {
            close()
            setError(msg)
          }}
        />
      )}
    </div>
  )
}

/** Shows the picture in a circle to drag and zoom; nothing is stored until Save. */
function Cropper({ src, onClose, onError }: { src: Source; onClose: () => void; onError: (msg: string) => void }): ReactNode {
  const [crop, setCrop] = useState<Crop>(() => ({ zoom: 1, cx: src.w / 2, cy: src.h / 2 }))
  const [saving, setSaving] = useState(false)
  const stage = useRef<HTMLCanvasElement>(null)
  const previews = useRef<(HTMLCanvasElement | null)[]>([])
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null)
  const top = maxZoom(src)
  const move = (next: Crop): void => setCrop(clampCrop(src, next))

  useLayoutEffect(() => {
    draw(stage.current, STAGE, src, crop)
    PREVIEWS.forEach((p, i) => draw(previews.current[i], p.size, src, crop))
  }, [src, crop])

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await api.profileSave(await renderAvatar(src, crop))
      toast('Profile picture saved')
      onClose()
    } catch {
      onError("That picture couldn't be saved. Try another one.")
    }
  }

  return (
    <div className="overlay">
      <div
        className="dialog cropper"
        role="dialog"
        aria-label="Position your profile picture"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) void save()
        }}
      >
        <h3>Position your picture</h3>
        <p>Drag to move it, and scroll or use the slider to zoom. Arrow keys move it too.</p>
        <div className="crop-body">
          <div
            className="crop-stage"
            tabIndex={0}
            autoFocus
            aria-label="Picture position"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = { x: e.clientX, y: e.clientY, crop }
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d) return
              const k = side(src, d.crop.zoom) / STAGE
              move({ ...d.crop, cx: d.crop.cx - (e.clientX - d.x) * k, cy: d.crop.cy - (e.clientY - d.y) * k })
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onWheel={(e) => move({ ...crop, zoom: crop.zoom * Math.exp(-e.deltaY * 0.0015) })}
            onKeyDown={(e) => {
              const step = side(src, crop.zoom) * 0.03
              const by: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
              if (by[e.key]) move({ ...crop, cx: crop.cx + by[e.key][0] * step, cy: crop.cy + by[e.key][1] * step })
              else if (e.key === '+' || e.key === '=') move({ ...crop, zoom: crop.zoom * 1.1 })
              else if (e.key === '-') move({ ...crop, zoom: crop.zoom / 1.1 })
              else return
              e.preventDefault()
            }}
          >
            <canvas ref={stage} style={{ width: STAGE, height: STAGE }} />
            <div className="crop-ring" />
          </div>
          <div className="crop-side">
            <div className="crop-previews">
              {PREVIEWS.map((p, i) => (
                <div key={p.size} className="crop-prev">
                  <span className="user-pic" style={{ width: p.size, height: p.size }}>
                    <canvas ref={(el) => void (previews.current[i] = el)} />
                  </span>
                  <span className="muted">{p.label}</span>
                </div>
              ))}
            </div>
            <label className="crop-zoom">
              <span className="muted">Zoom</span>
              <input
                type="range"
                min={1}
                max={top}
                step={0.01}
                value={crop.zoom}
                disabled={top <= 1}
                onChange={(e) => move({ ...crop, zoom: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
