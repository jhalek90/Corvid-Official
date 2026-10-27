# Third-party notices

Corvid itself is licensed under the Functional Source License 1.1 with the Apache 2.0 future license (see
[LICENSE](LICENSE)). It ships with the third-party software listed here, each under its own license. Each
package's full license text is in its folder under `node_modules` (in a packaged build, inside `resources/app.asar`
or `resources/app.asar.unpacked`), and the authoritative list is each package's own `package.json`.

This list was made from `npm ls --omit=dev --all` and the packages' own `package.json` files on 2026-10-27, for
Corvid 0.1.0. Update it when production dependencies change: `node scripts/third-party-licenses.mjs` prints the
counts below.

## Runtime

- **Electron** (MIT), with Chromium, Node.js and their bundled components. A packaged build carries their notices
  as `LICENSE.electron.txt` and `LICENSES.chromium.html` next to `Corvid.exe`.

## Direct dependencies

| Package | License | Used for |
|---|---|---|
| react, react-dom | MIT | The window's interface |
| @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links | MIT | Terminals |
| @lydell/node-pty (native module, with @lydell/node-pty-win32-x64) | MIT | Terminal processes |
| @modelcontextprotocol/sdk | MIT | The local tool server for agents |
| lucide-react | ISC | Icons |
| highlight.js | BSD-3-Clause | Code highlighting in the file viewer |
| @fontsource-variable/inter (Inter typeface) | SIL Open Font License 1.1 | Interface font |
| @fontsource-variable/jetbrains-mono (JetBrains Mono typeface) | SIL Open Font License 1.1 | Monospace font |
| ssh2 | MIT | Remote systems over SSH |
| pg | MIT | PostgreSQL connections |
| mysql2 | MIT | MySQL connections |
| tedious | MIT | SQL Server connections |
| zod | MIT | Data validation |
| three | MIT | The 3D graph in the Context cloud view |

## Other licenses among the indirect dependencies

Of the 213 production package folders installed for Windows (the other platforms' optional node-pty builds are
not installed), 187 are MIT and 11 are ISC. The rest:

- **BSD-3-Clause:** highlight.js, bcrypt-pbkdf, @js-joda/core, sprintf-js, fast-uri, qs, ieee754,
  buffer-equal-constant-time
- **BSD-2-Clause:** json-schema-typed
- **Apache-2.0:** long, ecdsa-sig-formatter
- **0BSD:** tslib
- **Unlicense:** tweetnacl
- **SIL Open Font License 1.1:** the two fonts above

No production dependency is under the GPL, the LGPL or the AGPL, and none has an unknown or missing license.
pg-types and pgpass declare MIT in their `package.json` but ship no separate license file.

## Fonts

The Inter and JetBrains Mono fonts are bundled into the window's build under the SIL Open Font License 1.1. The
license allows bundling and redistributing them with software. Their license texts are in
`node_modules/@fontsource-variable/inter/LICENSE` and `node_modules/@fontsource-variable/jetbrains-mono/LICENSE`.

## Colour themes

- **Nord** colours: (c) Sven Greb, MIT.
- **Solarized** colours: (c) Ethan Schoonover, MIT.

## Corvid's own artwork

The app and tray icons are drawn by `scripts/make-icons.mjs`, and the crows are drawn in code
(`src/renderer/src/crow.ts` and its components). Both are Corvid's own work, covered by Corvid's license and by
[TRADEMARK.md](TRADEMARK.md), not third-party material.
