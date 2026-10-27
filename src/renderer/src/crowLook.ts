// The crow's colours, from Settings. Custom colours override the theme's --crow-* tokens in one
// injected <style>, scoped to the crow's own elements so they win over whatever the theme sets on
// :root. The mascot, the avatar and the editor's preview all follow at once. Unset colours keep
// the theme's own crow. A body colour too close to the active theme's background gets a firmer
// rim, taken from the theme's text colour so it shows in any theme; it's rechecked on theme change.

import type { CrowLook } from '@shared/types'
import { contrast, LOW_CONTRAST, luminance, rgb } from '@shared/crowParts'

const FIRM_RIM = 'color-mix(in srgb, var(--text) 80%, transparent)'

const hex = (c: number[]): string => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const mix = (a: string, b: string, t: number): string => {
  const x = rgb(a)
  const y = rgb(b)
  return hex(x.map((v, i) => v + (y[i] - v) * t))
}

/** the active theme's page background as #rrggbb, or null if it isn't a plain hex colour */
function pageBg(): string | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null
}

/** True when the custom body colour all but vanishes against the active theme's background. */
export function hardToSee(look: CrowLook): boolean {
  const bg = pageBg()
  return !!look.body && !!bg && contrast(look.body, bg) < LOW_CONTRAST
}

/** True when the eye is lost against the body (the theme bodies are all near-black, the eyes pale). */
export function eyeHidden(look: CrowLook): boolean {
  if (!look.eye && !look.body) return false
  return contrast(look.eye ?? '#e8ecf0', look.body ?? '#222830') < 1.6
}

/**
 * The look's colours as CSS custom properties. Unset colours are left out, so the theme's own show.
 * `bg` is the page background the firm-rim rule checks the feathers against.
 */
export function lookProps(look: CrowLook, bg: string | null): Record<string, string> {
  const v: Record<string, string> = {}
  const { body, beak, eye, accent } = look
  if (body) {
    // the wing a step off the body: lighter on a dark bird, darker on a pale one
    const wing = mix(body, luminance(body) < 0.4 ? '#ffffff' : '#000000', 0.09)
    Object.assign(v, { '--crow-body': body, '--crow-wing': wing, '--crow-av-body': body, '--crow-av-wing': wing })
    if (bg && contrast(body, bg) < LOW_CONTRAST) v['--crow-rim'] = FIRM_RIM
  }
  if (beak) Object.assign(v, { '--crow-beak': beak, '--crow-av-beak': beak })
  if (eye) v['--crow-eye'] = eye
  if (accent) {
    const [r, g, b] = rgb(accent)
    Object.assign(v, { '--crow-sheen': `rgba(${r}, ${g}, ${b}, 0.5)`, '--crow-trim': accent })
  }
  return v
}

const vars = (look: CrowLook): string =>
  Object.entries(lookProps(look, pageBg()))
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')

let current: CrowLook | undefined
let watching = false

function write(): void {
  let el = document.getElementById('crow-look') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'crow-look'
    document.head.appendChild(el)
  }
  // .crow-tint is for anything else drawn in the crow's colours, like the editor's hat buttons
  const css = current ? `.crow:not(.agent-bird), .crow-av, .crow-tint { ${vars(current)} }` : ''
  if (el.textContent !== css) el.textContent = css
}

/** Apply the look's colours everywhere the crow is drawn. Hats and accessories are markup, not CSS. */
export function applyCrowLook(look: CrowLook | undefined): void {
  current = look
  write()
  if (watching) return
  watching = true
  // the firm rim depends on the theme's background, so recheck when the theme changes
  new MutationObserver(() => current?.body && write()).observe(document.documentElement, { attributes: true })
}
