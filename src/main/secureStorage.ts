import { safeStorage } from 'electron'
import type { SecretStorageStatus } from '@shared/types'
import { secretReadError, secretStorageStatus } from './platform'

// The one way in and out of safeStorage (#159). Both secret stores (connectors/store.ts, remote/store.ts) go
// through here, so the check for a real keyring on Linux (platform/keyring.ts) applies to every secret.
// Secrets are never written in plain text as a fallback: no keyring means no save.

export const storageStatus = (): SecretStorageStatus => secretStorageStatus(safeStorage)

/** A value, encrypted and base64'd for the store; throws the reason to show when secrets can't be saved now. */
export function encryptSecret(value: string): string {
  const s = storageStatus()
  if (!s.available) throw new Error(s.reason)
  return safeStorage.encryptString(value).toString('base64')
}

/** A stored value, decrypted. When the keyring is locked or gone, throws a plain error that never holds the secret. */
export function decryptSecret(enc: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    throw new Error(secretReadError(storageStatus()))
  }
}
