import { z } from 'zod'
import type { AccessPart } from './agentAccess'
import { mergeBranch, type AgentBranch } from './agentGit'
import { unlinkDepsCommand, unlinkDepsWarning } from './platform/agentWords'
import { hasKnownSecret } from './remote/scrub'

// The worker's side of feature branches: what it's told, and the one tool that merges its branch.
// The tool does the merge itself so the rules (lock, --no-ff, abort on conflict, no force) hold
// whatever the model does.

export function branchPrompt(b: AgentBranch, platform: string = process.platform): string {
  return (
    `Git: you work on the branch ${b.branch} in your own git worktree, ${b.cwd}, ` +
    (b.reused ? `continuing the work already on that branch (look at its git log first). ` : `which the dashboard made from ${b.defaultBranch} for this task. `) +
    `The main folder, ${b.repo}, belongs to the user and to other agents: never edit files there, never switch branches anywhere, and never touch any branch other than ${b.branch}. ` +
    `If you only research, check or take screenshots and change no files, make no commits; the branch is removed when you finish. ` +
    `If you change files: commit in small steps on ${b.branch} with clear messages. When the work is done, run the project's checks if it has them (typecheck, build or tests). ` +
    `Only if they pass, call mcp__corvid__merge_task_branch, which merges ${b.branch} into ${b.defaultBranch} with a merge commit; do not run git merge yourself. ` +
    `If checks fail, the tool refuses, or the merge conflicts, do not merge, rebase, reset or retry with force: stop and report, and leave the branch for the user. ` +
    `Do not push (the dashboard pushes after a merge only if the user turned that on). Never force anything, never rewrite history, never change a remote or git config, ` +
    `and never put secrets in commit messages. node_modules here is a link to the main folder's: do not delete it recursively or install packages through it. ` +
    `If you must change dependencies, first remove only the link with "${unlinkDepsCommand(platform)}"${unlinkDepsWarning(platform)}, then install. Other ignored local files (such as .env) are not in the worktree; say so if you need them.`
  )
}

export function gitAccess(b: AgentBranch, subject: string, push: () => boolean, merged: (message: string) => void): AccessPart {
  return {
    allowed: ['merge_task_branch'],
    prompt: branchPrompt(b),
    tools: [
      {
        name: 'merge_task_branch',
        description:
          `Merge your task branch (${b.branch}) into ${b.defaultBranch} in the main folder, with a merge commit. Call it once, only after you committed everything and the project's checks passed. ` +
          `It refuses, and changes nothing, when you have uncommitted changes, the main folder has uncommitted changes or is busy, or the merge conflicts (then it aborts the merge). Report what it says.`,
        input: { checks: z.string().describe('which checks you ran and that they passed, e.g. "npm run typecheck and npm run build passed", or "none: the project has no checks"') },
        run: async ({ checks }: { checks: string }) => {
          if (/\b(fail|failed|failing|error)\b/i.test(checks) && !/\bpass/i.test(checks)) return 'Checks failed, so nothing was merged. Fix them first, or stop and report.'
          const title = hasKnownSecret(subject) ? `task branch` : subject
          const r = await mergeBranch(b, title, push())
          if (r.merged) merged(r.message)
          return r.message
        }
      }
    ]
  }
}
