// How a Claude Code session on one of the user's own models is launched (#314, step 2 of the plan in N175, section 3):
// the same CLI, pointed at the entry's server with a dummy token, in its own config folder with no login in it. Pure:
// it only describes the launch, so scripts/test-effort.mjs can check it without starting anything. Claude-model
// sessions never come through here.

import { DEFAULT_MAX_OUTPUT, type CustomModel } from '@shared/customModels'

/** A change to a session's environment: names taken out, then names set. Only custom-model sessions have one. */
export interface LaunchEnv {
  /** set on top of the environment Corvid already passes */
  env: Record<string, string>
  /** taken out of that environment first (any case, for Windows) */
  unset: string[]
}

export interface CustomLaunch extends LaunchEnv {
  /** the model part of the command line; no --effort and no --permission-mode (N175 decisions 5 and 9) */
  args: string[]
}

/** The token the session sends. The server checks none (auth "none"); it only keeps Claude Code from asking for a login. */
export const DUMMY_TOKEN = 'corvid-no-key'

/**
 * What must never reach a custom-model session: every login, key and header Claude Code reads, and the switches and
 * base URLs that would send it to another provider. Names from Claude Code 2.1.312.
 */
export const CUSTOM_UNSET = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSIONS_OAUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL'
]

/**
 * The context window Claude Code assumes for a model it doesn't know (2.1.312: 200,000). CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * is a percentage of that window (capped at the window less 13,000), so it is worked out against it. When Claude Code's
 * real window is smaller, it compacts earlier, never later.
 */
export const ASSUMED_WINDOW = 200_000
/** Compact once the conversation fills this share of what's left of the server's context after the output reserve. */
const COMPACT_AT = 0.8

/** The auto-compact percentage for an entry, or undefined when Claude Code's own threshold is already low enough. */
export function autoCompactPct(m: CustomModel): number | undefined {
  const room = m.contextTokens - (m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT)
  const pct = Math.floor(((room * COMPACT_AT) / ASSUMED_WINDOW) * 100)
  return pct >= 100 ? undefined : Math.max(1, pct)
}

export function customLaunch(m: CustomModel, configDir: string): CustomLaunch {
  const small = m.smallModel ?? m.model
  const pct = autoCompactPct(m)
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: m.baseUrl,
    ANTHROPIC_AUTH_TOKEN: DUMMY_TOKEN,
    ANTHROPIC_MODEL: m.model,
    // every alias a subagent or /model can ask for stays on this model
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: m.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: m.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT),
    CLAUDE_CONFIG_DIR: configDir,
    ...(pct !== undefined ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct) } : {})
  }
  // the entry's own env last, already allow-listed in config; it never replaces or brings back a name Corvid handles
  const own = new Set([...Object.keys(env), ...CUSTOM_UNSET])
  for (const [k, v] of Object.entries(m.env ?? {})) if (!own.has(k.toUpperCase())) env[k] = v
  return { env, unset: [...CUSTOM_UNSET], args: ['--model', m.model] }
}

/** The environment with `change` applied. Names match in any case, as Windows' do, so no second spelling survives. */
export function withEnv(base: Record<string, string | undefined>, change: LaunchEnv): Record<string, string | undefined> {
  const gone = new Set([...change.unset, ...Object.keys(change.env)].map((k) => k.toUpperCase()))
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(base)) if (!gone.has(k.toUpperCase())) out[k] = v
  return { ...out, ...change.env }
}
