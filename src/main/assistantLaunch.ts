// The model part of Corvid's own command line and the environment its session runs in (#320). Claude models get
// launchArgs (model and effort) on the user's login, as always. A custom model (experimental, N175 decision 6) gets the
// same customLaunch env and args as a worker on it (#314): its server, a dummy token, the custom config folder, and no
// --effort. Pure, so scripts/test-effort.mjs checks it without starting anything.

import type { AppConfig } from '@shared/types'
import { launchArgs } from '@shared/models'
import { assistantModelProblem, findCustomModel, isCustomModelRef, type CustomModel } from '@shared/customModels'
import { customLaunch, withEnv } from './customLaunch'

export type Env = Record<string, string | undefined>

export type AssistantLaunch =
  | { args: string[]; env: Env; custom?: CustomModel }
  /** a custom model Corvid can't run on: nothing starts, and `problem` says why */
  | { problem: string }

export function assistantLaunch(cfg: Pick<AppConfig, 'assistantModel' | 'assistantEffort' | 'models'>, base: Env, configDir: string): AssistantLaunch {
  if (isCustomModelRef(cfg.assistantModel)) {
    const problem = assistantModelProblem(cfg.models, cfg.assistantModel)
    const m = findCustomModel(cfg.models, cfg.assistantModel)
    if (problem || !m) return { problem: problem ?? 'Its entry is gone.' }
    const l = customLaunch(m, configDir)
    return { args: l.args, env: withEnv(base, l), custom: m }
  }
  // Runs on the subscription login; a stray API key in the environment would take precedence.
  const env = { ...base }
  delete env.ANTHROPIC_API_KEY
  // the model and effort (#238); an effort change, like a model change, applies from the next session
  return { args: launchArgs(cfg.assistantModel, cfg.assistantEffort), env }
}
