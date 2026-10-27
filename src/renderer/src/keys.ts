// The window's shortcut modifier and labels (#156): Cmd on macOS, Ctrl on Windows and Linux. Every shortcut
// checks mod(e) instead of e.ctrlKey, and every label or tooltip naming one comes from keyLabel, so Windows
// keeps exactly its Ctrl+J while macOS shows ⌘J. Inside terminals Ctrl stays Ctrl (Ctrl+C is the interrupt),
// and the terminal toggle stays Ctrl+` everywhere, as in VS Code (Cmd+` cycles windows on macOS).

import {
  ctrlLabel as ctrlLabelFor,
  modClickLabel,
  modDown,
  otherModDown,
  shortcutLabel,
  type PlatformInfo
} from '@shared/platformInfo'
import { api } from './api'

export const platform: PlatformInfo = api.platform

type Mods = { ctrlKey: boolean; metaKey: boolean }

/** The shortcut modifier is down: Cmd on macOS, Ctrl elsewhere. */
export const mod = (e: Mods): boolean => modDown(platform, e)
/** The other modifier is down (Ctrl on macOS, the Windows/Super key elsewhere). */
export const otherMod = (e: Mods): boolean => otherModDown(platform, e)

/** keyLabel('J'): Ctrl+J, or ⌘J on macOS. keyLabel('Shift+Z'): Ctrl+Shift+Z, or ⇧⌘Z. */
export const keyLabel = (key: string): string => shortcutLabel(platform, key)
/** For shortcuts that are Ctrl on every platform: ctrlLabel('`') is Ctrl+`, or ⌃` on macOS. */
export const ctrlLabel = (key: string): string => ctrlLabelFor(platform, key)
/** Ctrl+click, or ⌘-click on macOS. */
export const clickLabel = modClickLabel(platform)
