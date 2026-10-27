import type { ExtensionModule } from './sockets/load'
import type { WindowSockets } from './sockets/window'

// The registration index for the window (#102): one import and one entry per extension with a window part,
// src/extensions/<id>/window.tsx. Its main-process part, if any, goes in mainExtensions.ts. See docs/EXTENSIONS.md,
// "Extension sockets".
//
//   import myExtension from './my-extension/window'
//   export const WINDOW_EXTENSIONS: ExtensionModule<WindowSockets>[] = [myExtension]

export const WINDOW_EXTENSIONS: ExtensionModule<WindowSockets>[] = []
