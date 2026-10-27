import type { ExtensionModule } from './sockets/load'
import type { ThemeSockets } from './sockets/theme'

// The registration index for themes (#114): one import and one entry per extension that adds themes, from its own
// folder, src/extensions/<id>/themes.ts. A theme is data only (colour tokens), so both the main process and the window
// load this index. The per-extension flag in Settings switches one off without removing it. See docs/EXTENSIONS.md,
// "The theme socket".
//
//   import myThemes from './my-themes/themes'
//   export const THEME_EXTENSIONS: ExtensionModule<ThemeSockets>[] = [myThemes]

export const THEME_EXTENSIONS: ExtensionModule<ThemeSockets>[] = []
