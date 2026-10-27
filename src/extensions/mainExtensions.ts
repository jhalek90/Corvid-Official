import type { ExtensionModule } from './sockets/load'
import type { MainSockets } from './sockets/main'

// The registration index for the main process (#102). An extension lives in its own folder, src/extensions/<id>/,
// and registers here with one import and one entry. Its window part, if any, goes in windowExtensions.ts. Corvid loads
// these at start-up; the per-extension flag in Settings switches one off without removing it. See docs/EXTENSIONS.md,
// "Extension sockets".
//
//   import myExtension from './my-extension/main'
//   export const MAIN_EXTENSIONS: ExtensionModule<MainSockets>[] = [myExtension]

export const MAIN_EXTENSIONS: ExtensionModule<MainSockets>[] = []
