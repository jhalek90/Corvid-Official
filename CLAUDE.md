# Working on Corvid

Read `docs/getting-started/what-corvid-is.md` before you reason about what Corvid should do. It is the project
owner's intent: a personal development environment each engineer reshapes, with a small shared base that must stay
mergeable into many diverged copies. Prefer settings and extension sockets over hard-coded choices.

The docs follow `docs/ASD-PLUS.md` (run `npm run docs:lint`). How to run, test and contribute: `CONTRIBUTING.md`.
Test the app only with `npm run test-instance`; never point anything at the real data folder.

## Project notes

- To turn a setting on for new installs only, write it into the first config.json (the no-file branch of `getConfig` in `src/main/config.ts`, as `workerProjectMemory` does), never via `DEFAULTS`: that would flip what "absent" means for existing copies.
- To see agent cards in a test copy (it starts no workers), eval `__dash.sampleAgents(n, states, [], workerExtras, agentExtras)`; agentExtras gives a card a made-up session (`s`) or activity (`a`). Start the copy with `--env DASH_SHOT_DIR=<dir>` to get a PNG of the Agents view.
