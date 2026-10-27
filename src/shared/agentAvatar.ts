// Random crows for the agents the dashboard spawns, picked from the look editor's own options
// (crowParts), so a new hat or colour there turns up here too. Random but tasteful: colours only from
// the curated presets, a beak, eye and sheen that stand out from the feathers, most agents in a hat.
// Stable: the same seed (the task id) always gives the same crow, so a restarted worker looks the
// same. Generated in the main process when a worker starts and stored with its board messages; an
// agent can never pick or change it.

import type { CrowLook } from './types'
import { hash } from './agentNames'
import { contrast, CROW_EXTRAS, CROW_HATS, presetsOf } from './crowParts'

/** How much stronger than the editor's own warnings: avatars are drawn small. */
const MIN_BEAK = 1.8
const MIN_EYE = 2.5
const MIN_SHEEN = 1.5
/** Out of 100. */
const HAT_CHANCE = 80
const GLASSES_CHANCE = 14
const BOWTIE_CHANCE = 10

const pick = <T>(list: T[], seed: string): T => list[hash(seed) % list.length]

/** Presets that stand out from `against` by at least `min`; all of them if none does. */
function readable(list: string[], against: string, min: number): string[] {
  const ok = list.filter((c) => contrast(c, against) >= min)
  return ok.length ? ok : list
}

/** Feathers, with the pale one rarer, so most agents still look like crows. */
function bodies(): string[] {
  const list = presetsOf('body')
  return list.flatMap((c) => (contrast(c, '#000000') > 12 ? [c] : [c, c]))
}

function roll(seed: string): CrowLook {
  const body = pick(bodies(), `${seed}:body`)
  const hats = CROW_HATS.filter((h) => h !== 'none')
  const x = hash(`${seed}:extra`) % 100
  return {
    body,
    beak: pick(readable(presetsOf('beak'), body, MIN_BEAK), `${seed}:beak`),
    eye: pick(readable(presetsOf('eye'), body, MIN_EYE), `${seed}:eye`),
    accent: pick(readable(presetsOf('accent'), body, MIN_SHEEN), `${seed}:accent`),
    hat: hash(`${seed}:hat?`) % 100 < HAT_CHANCE ? pick(hats, `${seed}:hat`) : 'none',
    extra:
      x < GLASSES_CHANCE ? 'glasses' : x < GLASSES_CHANCE + BOWTIE_CHANCE ? 'bowtie' : CROW_EXTRAS[0][0]
  }
}

/** Two crows that would read as the same bird at avatar size: the same feathers under the same hat. */
export const looksAlike = (a: CrowLook, b: CrowLook): boolean => a.body === b.body && a.hat === b.hat

/**
 * The crow for an agent. `seed` is its task id (or, for a named agent without a task, its name);
 * `taken` are the crows of agents running now. The first roll is kept unless it looks like one of
 * those, then the next, so it's stable and never twins with a running agent.
 */
export function agentLook(seed: string | number, taken: CrowLook[] = []): CrowLook {
  for (let k = 0; k < 64; k++) {
    const look = roll(k ? `${seed}~${k}` : String(seed))
    if (!taken.some((t) => looksAlike(t, look))) return look
  }
  return roll(String(seed))
}

/** What agents show with Random agent avatars off: the theme's own crow, no hat. */
export const PLAIN_LOOK: CrowLook = { hat: 'none', extra: 'none' }
