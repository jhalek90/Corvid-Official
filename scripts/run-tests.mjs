// Runs every test file in one go: each scripts/test-*.mjs that uses node:test. A plain "node --test
// scripts/test-*.mjs" also picks up scripts/test-instance.mjs, which is the test-copy tool and not a test, and
// counts it as a failure.
//
//   npm test                                  (extra arguments go to node --test, e.g. --test-name-pattern=deploy)

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(dir)
  .filter((n) => /^test-.*\.mjs$/.test(n) && readFileSync(join(dir, n), 'utf8').includes("from 'node:test'"))
  .sort()
  .map((n) => join(dir, n))

const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
