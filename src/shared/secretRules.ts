// What a secret looks like, and which files agents may not read (#91). Shared so the task form can warn
// as the user types, the notes and board can refuse, and the project scan finds the same things.

// The same patterns the repo's commit scan uses (scripts/secret-scan.mjs), plus plain "password: x".
export const SECRET_RULES: [string, RegExp][] = [
  ['a private key', /-----BEGIN ([A-Z]+ )*PRIVATE KEY( BLOCK)?-----/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an API key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe key', /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{3,}@[^\s'"]+/i],
  // secret-scan: allow
  ['a password', /\b(pass(word|wd|phrase)?|secret|api[_-]?key|token)\b["']?\s*[:=]\s*["']?(?=[^"'\s]*[\d!@#$%^&*])[^"'\s]{6,}/i]
]

/** What kind of secret the text seems to hold ("a private key"), or null. */
export function secretKindIn(text: string): string | null {
  return SECRET_RULES.find(([, re]) => re.test(text))?.[0] ?? null
}

/** The gentle warning for text an agent will read (task titles and notes). */
export const SECRET_WARNING = "This looks like a secret. Save it in Corvid's connections instead, so agents never see it."

/** A file pattern agents may not read or edit, in Claude Code's permission-rule syntax. */
export interface DenyDefault {
  pattern: string
  label: string
  /** inside the agent's project (relative to where it runs) rather than the user's home */
  project?: boolean
  /** only on these platforms (process.platform names); every platform when left out */
  platforms?: string[]
}

// ~/ is the user's home; **/ is anywhere under the folder the agent runs in. Corvid's own data folder is
// added by the main process, which knows where it is.
export const DENY_DEFAULTS: DenyDefault[] = [
  { pattern: '~/.ssh/**', label: 'SSH keys' },
  { pattern: '~/.aws/**', label: 'AWS credentials' },
  { pattern: '~/.azure/**', label: 'Azure credentials' },
  { pattern: '~/.config/gcloud/**', label: 'Google Cloud credentials' },
  { pattern: '~/AppData/Roaming/gcloud/**', label: 'Google Cloud credentials (Windows)' },
  { pattern: '~/.kube/**', label: 'Kubernetes config' },
  { pattern: '~/.docker/config.json', label: 'Docker logins' },
  { pattern: '~/.npmrc', label: 'npm token' },
  { pattern: '~/.pypirc', label: 'PyPI token' },
  { pattern: '~/.netrc', label: 'netrc logins' },
  { pattern: '~/.git-credentials', label: 'git credentials' },
  { pattern: '~/.gnupg/**', label: 'GPG keys' },
  { pattern: '~/.claude/.credentials.json', label: 'Claude Code login' },
  // macOS and Linux only (#150), so Windows gets exactly the rules it had
  { pattern: '~/Library/Keychains/**', label: 'macOS keychains', platforms: ['darwin'] },
  { pattern: '~/.local/share/keyrings/**', label: 'GNOME keyrings', platforms: ['linux'] },
  { pattern: '~/.config/gh/hosts.yml', label: 'GitHub CLI token', platforms: ['darwin', 'linux'] },
  { pattern: '**/.env', label: '.env files', project: true },
  { pattern: '**/.env.*', label: '.env.* files', project: true },
  { pattern: '**/*.pem', label: 'PEM keys and certificates', project: true },
  { pattern: '**/*.key', label: 'key files', project: true },
  { pattern: '**/*.p12', label: 'PKCS#12 bundles', project: true },
  { pattern: '**/*.pfx', label: 'PFX bundles', project: true },
  { pattern: '**/*.ppk', label: 'PuTTY keys', project: true },
  { pattern: '**/id_rsa', label: 'SSH private keys', project: true },
  { pattern: '**/id_dsa', label: 'SSH private keys', project: true },
  { pattern: '**/id_ecdsa', label: 'SSH private keys', project: true },
  { pattern: '**/id_ed25519', label: 'SSH private keys', project: true },
  { pattern: '**/credentials.json', label: 'credentials.json', project: true },
  { pattern: '**/secrets.*', label: 'secrets.* files', project: true }
]

/** The defaults that apply on `platform` (anything that isn't Windows or macOS counts as Linux). */
export function denyDefaultsFor(platform: string): DenyDefault[] {
  const os = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
  return DENY_DEFAULTS.filter((d) => !d.platforms || d.platforms.includes(os))
}

/** Whether a file name matches the last part of a `**\/name` pattern (* is any run of characters). */
export function nameMatches(pattern: string, name: string): boolean {
  const last = pattern.replace(/^\*\*\//, '')
  if (last.includes('/')) return false
  const re = new RegExp(`^${last.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  return re.test(name)
}

/** A user's own pattern: a path or glob, no parentheses or line breaks, which would break the rule. */
export function cleanDenyPattern(s: string): string | null {
  const p = s.trim().replace(/\\/g, '/')
  if (!p || p.length > 300 || /[()\r\n]/.test(p)) return null
  return p
}

/** One possible secret found in a project file. The value itself never leaves the scan. */
export interface SecretFinding {
  /** path relative to the project folder, with forward slashes */
  file: string
  /** 1-based; 0 when the file itself is the finding (a .env, a key file) */
  line: number
  kind: string
  /** the first and last two characters of a long value, else nothing */
  hint?: string
  /** no deny rule covers the file, so an agent could read it */
  readable: boolean
  /** git tracks the file, so the value may already be in history */
  tracked: boolean
}

export interface SecretScan {
  project: string
  at: number
  findings: SecretFinding[]
  files: number
  /** stopped early at the file limit */
  partial: boolean
}

export const findingKey = (f: { file: string; kind: string }): string => `${f.file}|${f.kind}`
