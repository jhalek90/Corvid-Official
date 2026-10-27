import { readFileSync } from 'node:fs'
import { allSecretValues, listSystems } from './store'
import { allConnectionSecrets } from '../connectors/store'
import { makeScrubber } from '../connectors/policy'

// Command output (and the command text, before it is logged) has every known secret value
// replaced. Agents never get secrets, so one showing up means the remote side echoed it back,
// e.g. a config file that holds the same password.

/** Passwords, passphrases, and the body lines of every configured private key file. */
function secretValues(): string[] {
  const values = allSecretValues()
  for (const s of listSystems()) {
    if (s.auth !== 'key' || !s.keyPath) continue
    try {
      for (const line of readFileSync(s.keyPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim()
        if (t.length >= 16 && !t.startsWith('-----')) values.push(t)
      }
    } catch {
      /* unreadable key: nothing of it can be in the output */
    }
  }
  // Very short values would mask ordinary text everywhere; nothing that short is a real secret.
  return [...new Set(values.filter((v) => v.length >= 3))].sort((a, b) => b.length - a.length)
}

/** Masks every SSH and connection secret, and its base64, URL-encoded, hex and reversed forms (#87). */
export function scrubber(): (text: string) => string {
  return makeScrubber([...secretValues(), ...allConnectionSecrets()])
}

/** Whether text holds any stored server or connection secret, for refusing to write it somewhere (a note). */
export function hasKnownSecret(text: string): boolean {
  // a short password could match ordinary words; only flag values long enough to be unmistakable
  return [...secretValues(), ...allConnectionSecrets()].some((v) => v.length >= 8 && text.includes(v))
}
