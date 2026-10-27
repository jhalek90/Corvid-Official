// Run by `npm install` (the "prepare" script): point git at .githooks so the pre-commit secret
// scan runs for everyone who builds Corvid. Quietly does nothing outside a git checkout.
import { execFileSync } from 'node:child_process'

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
} catch {
  /* not a git checkout (e.g. installed from a tarball) */
}
