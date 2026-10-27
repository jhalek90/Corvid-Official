// npm checks for `npm run setup` (#183): which npm versions are supported, and spotting npm ci's lockfile refusal so
// setup can say what it means instead of leaving the user with npm's raw usage dump. Pure functions; setup.mjs and
// test-setup.mjs use them.

/** The npm majors setup and CI run `npm ci` with: Node 22 ships npm 10, Node 24 ships npm 11. */
export const SUPPORTED_NPM = [10, 11]

/** 'supported', 'older' or 'newer' for an npm version string like "11.6.2"; undefined if it can't be read. */
export function npmSupport(version) {
  const major = Number(/^(\d+)\./.exec(version ?? '')?.[1])
  if (!Number.isInteger(major)) return undefined
  if (major < SUPPORTED_NPM[0]) return 'older'
  if (major > SUPPORTED_NPM[SUPPORTED_NPM.length - 1]) return 'newer'
  return 'supported'
}

/** The packages npm ci named as missing from (or wrong in) package-lock.json, or undefined when its output isn't the
 *  "package.json and package-lock.json are not in sync" refusal. An empty list means the refusal without names. */
export function lockfileRefusal(output) {
  const text = String(output ?? '')
  // "Missing: @electron/windows-sign@1.2.2 from lock file", "Invalid: lock file's foo@1.0.0 does not satisfy foo@^2"
  const named = [...text.matchAll(/Missing: (\S+) from lock file|Invalid: lock file's (\S+) does not satisfy/g)].map((m) => m[1] ?? m[2])
  if (!named.length && !/can only install packages when your package\.json and package-lock\.json[\s\S]{0,40}in sync/.test(text))
    return undefined
  return [...new Set(named)]
}
