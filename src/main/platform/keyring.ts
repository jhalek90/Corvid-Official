import { platformOf } from './shared.mjs'
import type { SecretStorageStatus } from '@shared/types'

// Secret storage per platform (#159, part of #142). Corvid encrypts every secret (connection slots, SSH passwords
// and passphrases) with Electron's safeStorage: DPAPI on Windows, the Keychain on macOS, and on Linux the Secret
// Service (GNOME Keyring, libsecret) or KWallet. With neither on Linux, Electron falls back to "basic_text": a
// fixed key in its own source, which is no protection at all, and isEncryptionAvailable() can still say yes. So on
// Linux only a real keyring backend counts, and anything else (basic_text, unknown, a missing function) refuses.
// Pure: it gets safeStorage (or a fake) as an argument, so scripts/test-keyring.mjs runs every backend here.

/** The parts of electron's safeStorage this needs; getSelectedStorageBackend exists on Linux only. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?: () => string
}

/** The Linux backends that are a real keyring. */
export const LINUX_KEYRINGS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']

export const NO_KEYRING =
  'No system keyring found. Install and unlock one (for example GNOME Keyring or KWallet) so Corvid can store secrets safely, then try again.'
export const NO_SECURE_STORAGE = 'System secure storage is not available, so the secret was not saved.'

/** Whether a secret may be saved now, which backend would hold it, and if not, the reason to show. */
export function secretStorageStatus(ss: SafeStorageLike, platform: string = process.platform): SecretStorageStatus {
  const os = platformOf(platform)
  let can = false
  try {
    can = ss.isEncryptionAvailable()
  } catch {
    can = false
  }
  if (os !== 'linux') {
    const backend = os === 'win32' ? 'dpapi' : 'keychain'
    return can ? { available: true, backend } : { available: false, backend, reason: NO_SECURE_STORAGE }
  }
  let backend = 'unknown'
  try {
    if (typeof ss.getSelectedStorageBackend === 'function') backend = String(ss.getSelectedStorageBackend() || 'unknown')
  } catch {
    backend = 'unknown'
  }
  return can && LINUX_KEYRINGS.includes(backend) ? { available: true, backend } : { available: false, backend, reason: NO_KEYRING }
}

/** The error for a stored secret that can't be decrypted now. Never names or echoes the secret. */
export function secretReadError(status: SecretStorageStatus, platform: string = process.platform): string {
  if (status.available) return 'A stored secret could not be read from system secure storage. Set it again on the connection.'
  if (platformOf(platform) === 'linux')
    return 'A stored secret could not be read: no system keyring is available, or it is locked. Unlock your keyring (for example GNOME Keyring or KWallet), then try again.'
  return 'A stored secret could not be read because system secure storage is not available right now.'
}
