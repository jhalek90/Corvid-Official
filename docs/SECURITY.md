# Security: what Corvid protects, and what it doesn't

Corvid runs Claude Code agents on your computer with your files, your shell and your user account. This page says
plainly what Corvid does to keep your secrets away from them, and where that stops. The connector standard and
its own limits are in [CONNECTORS.md](CONNECTORS.md).

## Secrets are held by Corvid, not by agents

- A password, key or token saved as a **connection** stays in Corvid. When an agent uses that connection, Corvid
  makes the call for it and sends back the result. The agent never gets the secret: not in its prompt, its tools,
  its transcript, notes, the board, exports, backups or logs.
- Secrets are encrypted with the system's secure storage (Electron `safeStorage`: Windows data protection, the
  macOS Keychain, or GNOME Keyring or KWallet on Linux) in Corvid's data folder. On Linux without a keyring,
  Corvid refuses to save secrets rather than keep them in plain text. Through
  Corvid's own window they are write-only: you can set or clear one, and you only ever see "set" or "not set".
- **Approvals and safety levels.** A connector's first use asks you in Corvid's own approval dialog. Each connection
  has a safety level: Free, Approve writes, or Strict (the default). Keep **Strict** for anything production.
- **Audit log.** Every call is recorded: who asked, which connection and operation, the decision and the result
  size. The log never holds the secret or the result.
- **Kill switch.** One switch turns every connector off at once, and another turns off a single connector.

## What still reaches the model

**Results reach the model.** What a query or an API call returns goes back to the agent, and so to Anthropic's API.
The credential stays hidden, but customer rows, emails and other data in a result are exposed. Ask for only what
the task needs, and use masking where the connector offers it.

**Scrubbing is best effort.** Corvid masks every secret it knows in results and errors, including common encodings
like base64, hex and URL encoding. It can't catch a value that was split up, transformed, or never given to Corvid.

## Files agents may not read

Agents also have Claude Code's file tools and a shell, and those could read a `.env` file or `~/.aws` directly. So
every agent Corvid starts, and Corvid's own chat, gets a generated Claude Code settings file
(`claude --settings`) with **deny rules** for reading and editing:

- Corvid's data folder, which holds the secrets, connections and backups. This rule can't be switched off.
- Credential folders in your home folder: `~/.ssh`, `~/.aws`, `~/.azure`, gcloud, `~/.kube`,
  `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/.git-credentials`, `~/.gnupg` and
  `~/.claude/.credentials.json`.
- Secret files in a project: `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `id_rsa` and its
  variants, `credentials.json` and `secrets.*`.

Files you attach to a board message (#147) are copied into that same data folder, so the deny rule covers them too
and was not loosened for them. Agents get them only through the board's read-only `read_attachment` tool, and only
for messages addressed to them (Corvid may read any); the files never leave this PC.

You can see and change the list in **Settings → Files agents may not read**. You can switch a default off, add your
own pattern, use **Allow this one** for one project file you want an agent to use, and reset everything. The rules
are added on top of your own Claude Code settings, which Corvid never writes to or changes.

**What the rules really cover.** This was tested with Claude Code 2.1.306 on Windows, using a throwaway agent and
fake files:

- **Blocked:** the Read tool, by relative and absolute path, and Grep, which skipped the denied files. Editing
  and writing get matching Edit rules, which work the same way in Claude Code but weren't tried separately here.
  Shell commands Claude Code recognises as reading a file are blocked too, even when the shell is allowed. In the test, `cat .env`,
  `wc -c server.key`, `grep FAKE .env` and `cp .env copy.txt` were all refused.
- **Not blocked:** a program the agent writes or runs, which can open the file itself. In the test,
  `python -c "open('.env').read()"` got through. Claude Code still asks before running a shell command you haven't
  allowed, but a deny rule alone doesn't stop a determined script.
- A Claude Code allow rule can't override a deny rule. That's why **Allow this one** removes the pattern for that
  project and blocks each of the project's other matching files by its exact path instead, when the agent starts.
  A matching file created later in that project isn't covered for that agent.
- An agent keeps the rules it started with. Changes in Settings apply to agents started after the change.
- **Extension builds** (#98) get more: their file tools can't edit Corvid's protected paths (unless you confirmed a
  tier-3 extension for that area), agent and git configuration, or your main checkout, and they have no merge tool.
  A shell command could still change a file, so Corvid scans the build's real diff and blocks a merge that touches a
  protected path you didn't confirm. See [EXTENSIONS.md](EXTENSIONS.md#the-install-pipeline-98). **Verify builds**
  (#101) get the same rules on a throwaway branch at a clean commit; they have no merge at all and are deleted after.

## The system's encryption has a limit

The system's secure storage keeps your secrets safe from other users and from someone who copies the files to
another machine. It doesn't protect them from other programs running as **you**. In theory, a fully hostile agent
with a shell could run code that asks the system to decrypt Corvid's store, or that reads your key files. The deny
rules, the approvals for shell commands and least-privilege accounts are there to make that hard, and to limit the
damage if it happens. They don't make it impossible.

## Prompt injection

A web page, a file, a query result or another agent's message can contain text written to steer an agent. Corvid
treats board messages and notes as information, never as instructions or approvals. Nothing an agent, a message or
a note says can approve a connector, a write or a command. Approvals happen only in Corvid's own dialogs and in
Claude Code's permission prompts. An agent can still be misled into doing something you allowed, within its project,
its connections and their safety levels. That's why Strict and least privilege matter.

## Agent pings (#195)

With **Agents can ping each other and Corvid** on (off by default), one agent's `@mention` reaches another running
agent or Corvid at once. That opens a path for one agent's text to steer another, so:

- Ping text is untrusted data. Control characters and escape sequences are stripped, it is cut to 1000 characters,
  and it is always labelled as from an agent (name and task), not the user, and as information, never an instruction
  or approval. That holds in the "Board:" line, in a woken agent's first prompt and in Corvid's turn.
- A ping carries nothing of the sender's: no tools, no project links, no connections, no attachments. The target keeps
  its own deny rules, tools and connections; an agent still reads only the attached files of messages addressed to it,
  and agents can't attach files.
- A ping or a wake-up never makes a connection call by itself. A woken agent's connection calls go through the same
  safety levels and approvals as any other.
- A Corvid turn started by a ping is restricted in code, at the tool gate: only reading, answering, posting and adding
  notes run. Starting, stopping or waking workers, changing tasks or settings, connections and deploying are refused.
- Every limit (per hour, per agent, per pair, chain, cooldown, self, duplicate, wake-ups per hour) is enforced in the
  main process, not left to agents.
- Waking a finished agent is a second switch, off by default, turned on only by your click on **Allow** in Corvid's
  own dialog. It never wakes an agent you stopped, one stopped at the time limit or by Stop all, or one whose task was
  removed, and never past the agent limit or the usage limit.
- No MCP tool, board message, slash command or extension can change these settings: only the Settings page in
  Corvid's own window can, and `config:set` drops the keys.

## Connectors proposed by agents

Agents can propose connectors (#92), but only as data: a manifest that one of Corvid's built-in runtimes runs. No
agent-written code ever runs with access to secrets. A proposal does nothing until you approve it in the Connections
tab; agents can't approve one, create a connection, enter a secret or link a project, and a board message saying
otherwise is just text. The draft rules (explicit public hosts only, no IP addresses, local or metadata names, no
`broad`, specific paths, capped limits, size and rate caps) are enforced by Corvid, so a tricked agent can't widen
them. What they can't stop: an agent misled by a web page into proposing a real but wrong host. That's why each
proposal shows the agent's reason and claimed source, highlights hosts nothing approved reaches yet, and is limited to
its project until you choose otherwise. Read the hosts before approving. Settings → *Let agents propose connectors*
turns the feature off.

## Your own models

Every rule on this page applies the same way to every model, Claude or one of your own (Settings → Models). A session
on your own model is the same Claude Code with the same deny rules, approvals and permission prompts, pointed at a
server on this computer (loopback addresses only). It gets no login: Corvid removes every Anthropic key, token and
sign-in variable from its environment and runs it in a separate Claude Code folder with no credentials, and a model
entry has no key field. Only the Settings page adds or changes a model entry. The lean profile for small contexts drops
Corvid extras, never a safety rule. Corvid never moves a task between your own model and a Claude model by itself.

## Where secrets can be typed

- **Connection forms:** these are the right place. They're write-only.
- **Notes and the board:** these refuse text that looks like a key, token or password.
- **Task titles and notes:** every worker reads these, so the task form warns when something looks like a secret,
  and the assistant's task tools refuse it.
- **Agent terminals:** Corvid can't see what you type into a terminal, so it can't stop a secret you type or paste
  there. That text goes to the model like anything else you tell an agent.

## Secrets already in your projects

**Scan for secrets** on a project page looks through that project's files for likely secrets: private keys, cloud
and API keys, tokens, passwords in config files, connection strings with passwords, and `.env` files. It runs on
your PC only, reads nothing outside the project, skips `node_modules` and build folders, and doesn't look at git
history. It shows the file, the line and the kind of secret, never the value. For each finding you can open the Connections tab's
Add wizard to move the secret into Corvid, block the file for agents, or ignore it. Corvid never changes your files. A quiet flag says how
many findings are in files agents can read, and you can snooze it.

## Test copies and backups

Copies of Corvid made with `npm run test-instance` get their own data folder and refuse to touch the real one. The
rolling backups never include the secret store.

## If a secret leaked

Rotate it: change it, or revoke it, where it was issued. Deleting it from a file, a note or a chat doesn't undo a
leak, because it may already be in git history, a transcript or Anthropic's API logs. Then save the new value in
Corvid as a connection.

## Checklist

- Give agents **least-privilege accounts**: read-only database users, scoped API tokens, and limited SSH users.
- Keep **Strict** for production connections.
- Keep secrets **out of project files**. Run Scan for secrets and move what it finds into Corvid.
- **Rotate** anything that was ever exposed.
