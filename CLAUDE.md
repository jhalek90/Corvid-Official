# Working on Corvid

Read `docs/getting-started/what-corvid-is.md` before you reason about what Corvid should do. It is the project
owner's intent: a personal development environment each engineer reshapes, with a small shared base that must stay
mergeable into many diverged copies. Prefer settings and extension sockets over hard-coded choices.

The docs follow `docs/ASD-PLUS.md` (run `npm run docs:lint`). How to run, test and contribute: `CONTRIBUTING.md`.
Test the app only with `npm run test-instance`; never point anything at the real data folder.
