import { EXTENSION_API_VERSION } from './load'

// What a build agent is told about the sockets (#102). The install pipeline (#98) adds this to its build
// instructions, and the packaging wizard (#100) can point seed prompts at it. Plain text, kept short.

export const SOCKET_BUILD_GUIDANCE = [
  `Corvid has extension sockets (API ${EXTENSION_API_VERSION}, documented in docs/EXTENSIONS.md under "Extension sockets").`,
  "Where one fits, build the feature through them: put all of the extension's code in its own folder, src/extensions/<id>/ (the id from the .corvid header),",
  'with main.ts for the main process and window.tsx for the window, each exporting { id, name, api, register }.',
  'Register it with one import and one list entry in src/extensions/mainExtensions.ts and/or windowExtensions.ts, and change nothing else there.',
  'The sockets are: a board slash command, a worker MCP tool, a worker instruction line and a connector manifest (main);',
  'a Settings section and a page in the Extensions tab (window). The per-extension flag in config.disabledExtensions switches it all off; register nothing outside register().',
  'A theme is data: put it in src/extensions/<id>/themes.ts (exporting { id, name, api, register } where register calls s.theme([...]) with an id, a name, a kind and the same tokens the built-in themes use),',
  'and register it with one import and one entry in src/extensions/themeExtensions.ts. Never add a theme to src/shared/themes.ts: a theme extension is tier 1 and declares tier 1.',
  'A diff that only adds files in that folder plus those registration lines is tier 1. Edit core files only when no socket fits, and say which and why.'
].join(' ')
