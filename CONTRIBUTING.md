# Contributing to Corvid

Thanks for wanting to help. Corvid is a small personal project, so keep changes focused and expect a slow, friendly
review. Read [What Corvid is](docs/getting-started/what-corvid-is.md) first: it says what belongs in the shared base
and what should stay a setting, an extension or a user's own change.

## Issues and pull requests

Corvid isn't accepting pull requests yet. Issues are welcome: bug reports, and platform test reports from macOS and
Linux (see [docs/TESTING-PLATFORMS.md](docs/TESTING-PLATFORMS.md)). Open one on the repository's **Issues** tab and
pick the matching template.

## Run and test

You need Node.js 22.18 or newer, npm and git, and Claude Code installed and signed in, on Windows, macOS or Linux
(Windows is where Corvid is used daily; see the platform status in the [README](README.md#platforms)).

```sh
npm install          # also points git at .githooks (pre-commit secret scan) and downloads Electron's binary
npm run dev          # development build with hot reload
npm run typecheck    # run this before every commit
npm run build        # build into out/
```

The `scripts/` folder has focused tests (`npm run test-extensions`, `npm run test-security` and others, listed
in `package.json`). Run the ones that cover what you changed.

Code that differs between Windows, macOS and Linux goes in the platform layer (`src/main/platform/`). See
[docs/PLATFORM.md](docs/PLATFORM.md). `npm run test-platform` pins today's Windows behaviour, so run it whenever you
touch that layer.

Test the app only with a **test copy**: `npm run test-instance -- start --owner <you>` (see
[Testing Corvid safely](#testing-corvid-safely)). Never point a test at your real Corvid data folder, and don't run
`npm run deploy` unless you mean to replace your installed Corvid.

## Testing Corvid safely

Agents (and you) test Corvid with a **test copy**, started only through the test-instance script. It never touches
the real app or its data.

```
npm run build
npm run test-instance -- start --owner <task or agent> [--data empty|copy] [--from <folder>] [--env KEY=VALUE] [--hidden]
npm run test-instance -- list
npm run test-instance -- whoami|stop|kill <id> --owner <owner>
npm run test-instance -- eval <id> --owner <owner> "<javascript run in the window>"
npm run test-instance -- show <id> --owner <owner>    (shows a copy started with --hidden, like a tray click)
npm run test-guards
```

- `start` makes a fresh data folder (empty, or `--data copy`: the real data or `--from <folder>` without secrets,
  the assistant's folder, caches or backups), picks a free port and a random token, starts this checkout's build
  and records the owner, process id, port and folder in `%TEMP%\corvid-test-instances\registry.json`
  (`CORVID_TEST_HOME` moves it). `--again <id>` starts a stopped copy's folder again. `--assistant` and
  `--workers` opt in to Corvid's assistant (on a fresh session) and to real workers; both spend Claude usage.
  `--claude-dir <folder>` points the copy at a fake `~/.claude`.
- `stop`, `kill`, `whoami` and `eval` only act on a copy in the registry, only for its owner, and only after the copy
  has answered with the same process id, owner and data folder. `stop` quits it cleanly; `kill` ends it by its
  process id (to test the closed-unexpectedly notice). Nothing kills Corvid by name or image.
- A test copy is any run with `DASH_DATA_DIR` (or `DASH_TEST_INSTANCE`). It refuses to start on the real data
  folder however the path is spelled (case, slashes, short names, junctions, symlinks), and logs the folder it
  uses. It shows TEST and its owner in the window title and in a badge, and it doesn't set the login item (or Linux
  autostart entry) or the Windows Start menu shortcut, register the global hotkey, show a tray icon or notifications, poll usage, rebuild,
  deploy, merge or push, start the assistant or start workers (unless opted in). It reads `~/.claude` but never
  writes there. Its control port listens on `127.0.0.1` only, behind the script's token; the real app opens no
  such port and drops a `--remote-debugging-port` it's given.
- The single-instance lock is per data folder: a test copy and the real app never block or quit each other.

Rules for agents working on Corvid (also in their instructions): test only with `npm run test-instance`, never kill
or quit Corvid by name or image, never point anything at the real data folder or the real app, never write to
`~/.claude`, and never deploy unless the user asked.

## Debug aids

- `DASH_DATA_DIR=<dir>` runs Corvid as a test copy on a separate data folder (see
  [Testing Corvid safely](#testing-corvid-safely); use the script rather than setting it by hand). Pointing `USERPROFILE` at a folder with a sample `.claude` runs it on
  sample sessions too.
- `DASH_CLOSE_FINISHED_SEC=<n>` closes finished agents after n seconds instead of the Settings minutes, for testing.
- `DASH_SHOT_DIR=<dir>` captures views to PNG and quits. `DASH_SHOT_VIEWS` lists them, separated by `|` (default
  `terminals`, the Agents view); `DASH_SHOT_DELAY` and `DASH_SHOT_STEP` set the waits in milliseconds, and
  `DASH_SHOT_SIZE=<w>x<h>` sizes the window first.
- `node scripts/ui-smoke.mjs <test copy id> --owner <owner>` drives a test copy started with
  `npm run test-instance`, through its checked control port: it adds fake tasks and fake workers in every state, opens the task editor,
  removes cards through the editor in quick bursts and undoes them in every view, opens the Corvid project page and a scoped project,
  and fails on any error, error panel or blank window. Never point it at the real Corvid.
- `localStorage['corvid.termDebug'] = '1'` (in DevTools, then reload) counts terminal fits, sizes sent to the
  process and xterm renders in `window.__termStats`; `__termStats.reset()` clears them. A terminal tells its
  process its size only once the size has held for 150 ms, and never a size it already has.

## Continuous integration

Every push and pull request runs [.github/workflows/ci.yml](.github/workflows/ci.yml) on GitHub Actions, on
Windows, macOS and Linux. It needs no secrets, reads the repository only, and publishes nothing. Open the **Checks**
tab of a pull request (or **Actions** for a push) to see it.

In a private repository, such as a private copy of Corvid, CI runs only on demand: open **Actions**, pick **CI** and
click **Run workflow**. A push or pull request there starts the workflow, but its jobs are skipped, so it uses no
Actions minutes. In a public repository it runs on every push and pull request. The condition is the `if:` line on
the test and npm 11 jobs; the package job waits for the test job, so it follows.

It has three jobs per platform:

- **Test (os)**: on Linux first the secret scan (`npm run secret-scan`: secrets, key and `.env` files,
  `node_modules` or build output, files over 5 MB), then `npm ci`, a check that Electron's binary was downloaded
  (`node scripts/electron-binary.mjs --strict`), `npm run typecheck`, `npm run build`, `npm test` (every
  `scripts/test-*.mjs` file), then the UI smoke test (`scripts/ci-smoke.sh`, which runs `scripts/ui-smoke.mjs`)
  against a test copy.
- **npm ci with npm 11 (os)**: the test job's `npm ci` uses Node 22's npm 10, so this one installs the newest npm 11
  on the runner and runs `npm ci --ignore-scripts`, then checks `package-lock.json` didn't change. npm 11.6.2+
  checks the lockfile more strictly (#183). If it fails with "Missing: … from lock file", regenerate the missing
  entries with `npx -y npm@11.21.1 install --package-lock-only` (an exact version: `npx npm@11` reuses whatever
  npm 11 you already have) and check the diff only adds entries.

  When you change dependencies, write the lockfile with npm 10 or the newest npm 11 (10.9.9 and 11.21.1 leave
  it exactly as it is). Some older npm 11 releases rewrite it: 11.5.1 drops the `@electron/windows-sign` entries
  again, which brings the npm 11.6.2+ refusal back, and 11.6.x shuffles `"peer"` flags. `npm -v` tells you which
  you have.
- **Package (os)**: runs after all three test jobs pass. `npm run package-check` builds the unpacked app for that
  platform with `electron-builder --dir` (no signing, no publishing) and checks the packaged app can load every
  module it needs, including node-pty's platform package. The build isn't uploaded: Corvid is built from a clone.

Reading the results:

- A red cross on a job means a step failed. Open the job and expand the red step; the last lines usually name the
  failing test (`✖ <test name>`) or the TypeScript error.
- Skipped tests (marked `﹣` in the log, counted under `skipped` at the end) are expected, and each line ends with
  the reason, such as `# Windows only`, `# POSIX only` or `# no pre-crossplatform tag here`: some tests only make
  sense on one platform, and live tests need a signed-in Claude Code that CI doesn't have.
- The UI smoke test must pass on Linux, where it runs under `xvfb-run`. On macOS and Windows it isn't proven reliable
  yet, so a failure there shows as a warning (an orange mark on that step) and the job still passes. Look at it, but
  it doesn't block a merge.
- To reproduce a failure, run the same command locally; the step names are the commands. For the smoke test:
  `npm run build`, then `bash scripts/ci-smoke.sh`. It starts a test copy with owner `ci`, runs
  `node scripts/ui-smoke.mjs <id> --owner ci` and stops the copy.
- A newer push to the same branch cancels the older run, so a "cancelled" run is not a failure.
- The Linux runner has no system keyring, and none is needed: the tests replace Electron with a fake `safeStorage`.
  On Linux Corvid saves a secret only when `getSelectedStorageBackend()` names a real keyring
  (`src/main/platform/keyring.ts`), so a test fake that must save secrets returns `'gnome_libsecret'` from it.
  Without that, the test passes on Windows and macOS but fails on Linux with "No system keyring found".

## Workflow

- Work on a feature branch made from `main`, one topic per branch (for example `fix-board-scroll`).
- Commit in small steps with clear messages. Don't rewrite shared history or force-push.
- A `#NNN` in a code comment or developer doc (such as `(#183)`) is a task number on the maintainer's private task
  board, not a GitHub issue; you can't look it up, and new code doesn't need one.
- Make sure `npm run typecheck` passes and the secret scan in the pre-commit hook stays happy.
- Pull requests aren't accepted yet (see [Issues and pull requests](#issues-and-pull-requests)).

## Publishing to the public repo

This section is for the maintainer. Corvid is developed in a private repository. The public repository shares no
history with it. Each update reaches the public `main` as one new commit with the private `main`'s exact tree.

Sync when a batch of changes is ready for users, for example a fix that users need or a finished feature.

1. On private `main`, bump `version` in `package.json` (and `package-lock.json`). Use a patch bump by default. Use a
   minor or major bump only when the maintainer decides it.
2. Add a dated `CHANGELOG.md` entry that lists the changes users can see. Merge both into private `main`.
3. Run `npm run publish-sync -- --dry-run`, then `npm run publish-sync`.
4. Read the summary. Then push with the command that the script prints.

The script works in its own clone of the public repository, `../Corvid-Official` next to the private checkout
(`--dir` changes this). It never works in the private checkout. It sets the public commit identity (the GitHub
noreply address) in that clone only. The commit message is `Corvid v<version>`, a list of the merges since the last
sync without the private `#NNN` numbers, and a `Synced-from: <private commit>` line. The next run starts from that
line.

The script refuses in these cases:

- The public `main` has a commit that the script didn't make, for example an edit on GitHub.
- The secret scan finds something in the tree.
- A tracked file holds the private git email address.
- The version is the same as the public version.

The script never pushes. A push to the public repository can't be undone, because others can clone or cache the
code at once. Only the maintainer approves a push, in a permission prompt, never on the board.

## Terms for contributions

This is a simple statement, not a formal agreement. A formal contributor license agreement may replace it later.

By submitting a contribution (code, documentation, artwork or anything else) to this repository, you agree that:

- your contribution is licensed under the project's license, the one in [LICENSE](LICENSE);
- the maintainer may also relicense your contribution, including under other license terms, as part of Corvid;
- you wrote the contribution yourself, or you otherwise have the right to submit it under these terms.

If you can't agree to this, please don't submit the contribution; open an issue to talk about it instead.

See also [TRADEMARK.md](TRADEMARK.md) for the Corvid name and artwork.
