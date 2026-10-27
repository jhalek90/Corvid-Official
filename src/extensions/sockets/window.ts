import type { ComponentType } from 'react'
import { createRegistry } from './registry'
import type { SocketHost } from './load'

// The window's sockets (#102): a section at the end of Settings, and a page in the Extensions tab. Components render
// inside an error boundary, so one that throws shows a short message in its own box and nothing else breaks. They get
// the same window API as the rest of the interface and nothing more: whatever they ask main for goes through the
// existing handlers and their checks.

export interface ExtensionSettingsSection {
  /** unique within the extension */
  id: string
  /** the section heading, at most 40 characters */
  title: string
  Component: ComponentType
}

export interface ExtensionPage {
  id: string
  /** the page's button in the Extensions tab, at most 30 characters */
  title: string
  Component: ComponentType
}

export interface WindowSockets {
  settingsSection: (s: ExtensionSettingsSection) => () => void
  page: (p: ExtensionPage) => () => void
}

const settings = createRegistry<ExtensionSettingsSection & { key: string }>('Settings section', (s) => s.key)
const pages = createRegistry<ExtensionPage & { key: string }>('Page', (p) => p.key)
const all = [settings, pages]

const ID = /^[a-z0-9-]{1,32}$/
const check = (kind: string, x: { id?: unknown; title?: unknown; Component?: unknown } | undefined, max: number): void => {
  if (typeof x?.id !== 'string' || !ID.test(x.id)) throw new Error(`A ${kind} needs a short id (lowercase letters, digits, hyphens).`)
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > max) throw new Error(`The ${kind} "${x.id}" needs a title of at most ${max} characters.`)
  if (typeof x.Component !== 'function' && typeof x.Component !== 'object') throw new Error(`The ${kind} "${x.id}" has no component.`)
}

export const windowHost: SocketHost<WindowSockets> = {
  socketsFor: (owner) => ({
    settingsSection: (s) => {
      check('settings section', s, 40)
      return settings.add(owner, { ...s, key: `${owner}/${s.id}` })
    },
    page: (p) => {
      check('page', p, 30)
      return pages.add(owner, { ...p, key: `${owner}/${p.id}` })
    }
  }),
  count: (owner) => all.reduce((n, r) => n + r.list().filter((e) => e.owner === owner).length, 0),
  removeOwner: (owner) => all.forEach((r) => r.removeOwner(owner))
}

export const clearWindowSockets = (): void => all.forEach((r) => r.clear())

export const settingsSections = (): { key: string; owner: string; title: string; Component: ComponentType }[] =>
  settings.list().map((e) => ({ key: e.item.key, owner: e.owner, title: e.item.title, Component: e.item.Component }))

export const extensionPages = (): { key: string; owner: string; title: string; Component: ComponentType }[] =>
  pages.list().map((e) => ({ key: e.item.key, owner: e.owner, title: e.item.title, Component: e.item.Component }))
