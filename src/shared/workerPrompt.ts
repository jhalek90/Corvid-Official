// The system line every worker starts with (#308): its task, what it must not do, its time limit and, with the
// Settings switch "Workers keep project memory in CLAUDE.md" on, the project-memory rule. The thesis dose
// (corvidThesis.ts) and the access prompt (board, notes, git, connections) follow it. Kept short on purpose: every
// worker pays for every word, so a rule is said once, here or in a tool description, not in both.

/**
 * What a worker is told about its time limit (#81). Agents can't see a clock and tend to think far more time
 * has passed than has (they wrapped up "at the 45-minute limit" after 8 to 15 minutes), so they're told
 * to ask instead of guessing.
 */
export const TIME_LIMIT_PROMPT = (minutes: number): string =>
  `The dashboard stops this session after ${minutes} minutes of work; time the computer sleeps or you wait for the user doesn't count, and every start or resume gets a fresh clock. ` +
  'You cannot feel time passing and will think far more has passed than has, so never stop early, skip steps or say you ran out of time on a guess: ' +
  'call time_left (mcp__corvid__time_left) before cutting anything short. Your board tool results show the time too, and warn you when 5 minutes are left.'

/** The project-memory rule (#308): Claude Code loads a project's CLAUDE.md in every session, worktrees included. */
export const PROJECT_MEMORY_RULE =
  'Project memory: CLAUDE.md is this project\'s shared memory for later workers. ' +
  'When your task sets or reveals a convention, a decision or a gotcha that a later task on this project must know and that isn\'t obvious from the code, ' +
  'add one short line to CLAUDE.md under a "Project notes" section (create the file with a one-line header if it doesn\'t exist) and commit it with the rest of your work. ' +
  'Don\'t log what you did (that\'s git), don\'t repeat what\'s already there, keep the file short, and update a line your task has made wrong rather than adding a contradicting one.'

/** The start of a worker's system prompt; the thesis dose and the access prompt are appended by the caller. */
export const workerSystemLine = (taskId: number, minutes: number, projectMemory: boolean): string =>
  `You were started by Corvid, the user's dashboard assistant, to work on a single task (#${taskId}). Stay focused on it. ` +
  'Do not push to remotes, publish, deploy, or delete data unless the task explicitly asks for it. ' +
  TIME_LIMIT_PROMPT(minutes) +
  (projectMemory ? ` ${PROJECT_MEMORY_RULE}` : '')
