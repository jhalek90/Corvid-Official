// When the dashboard is started from inside VS Code or a Claude Code session, it inherits
// per-process variables (session ids, messaging sockets, "run Electron as Node", …). Left in
// place they'd leak into every `claude` we spawn and make it think it's nested in that parent.
const LEAKY =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION_\w+|MESSAGING_\w+|CHILD_SESSION|EXECPATH|SSE_PORT|EMIT_STARTUP_TIMING|QUESTION_PREVIEW_FORMAT|ENABLE_SDK_FILE_CHECKPOINTING|ENABLE_TASKS)|AI_AGENT|VSCODE_\w+|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|TERM_PROGRAM(_VERSION)?)$/

for (const key of Object.keys(process.env)) {
  if (LEAKY.test(key)) delete process.env[key]
}
