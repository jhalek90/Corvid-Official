---
title: Safety and privacy
summary: What Corvid protects, what it sends, and what it does not protect.
section: help
order: 3
---

# Safety and privacy

Corvid runs Claude Code agents on your computer, with your files and your user account. It keeps your saved secrets
away from those agents. It cannot stop everything an agent does, so give agents only the access they need.

## What leaves your computer

- Corvid has no accounts, no server of its own and no telemetry.
- Claude traffic goes through your own `claude` program, on your own sign-in.
- Voice audio goes to Anthropic's speech service, only while you dictate.
- The update check runs `git fetch` against the public Corvid repository. See [Updates](../platforms/updates.md).

## Saved secrets

- A password, key or token that you save in a connection stays in Corvid. When an agent uses the connection,
  Corvid makes the call and gives the agent only the result. The agent never sees the secret.
- Corvid encrypts saved secrets with your system's secure storage. On Linux without a keyring, Corvid refuses to
  save them.
- In Corvid's window, a secret is write-only. You can set it or clear it. You only see "set" or "not set".
- Backups never include secrets.

## What still reaches the model

The result of a call goes back to the agent, and so to Anthropic. The secret stays hidden, but data in the result
does not. If a query returns customer rows, the model sees those rows. Ask for only what the task needs.

Corvid masks every secret it knows in results and errors. It cannot catch a secret that was split up, changed, or
never saved in Corvid.

## Files agents may not read

Every agent gets deny rules that stop it from reading or editing:

- Corvid's data folder. You cannot turn this rule off.
- Credential folders in your home folder, such as `~/.ssh`, `~/.aws` and `~/.claude/.credentials.json`.
- Secret files in a project, such as `.env`, `*.pem` and `*.key`.

You can change the list in **Settings** → **Files agents may not read**. See
[Files agents may not read](../settings/files-agents-may-not-read.md).

The rules stop Claude Code's file tools and the shell commands that Claude Code knows read a file. They do not stop
a script that the agent writes and runs, which can open the file itself.

## Approvals

Only you approve things, and only in Corvid's own dialogs or in Claude Code's permission prompts. A board message, a
note or an agent's words never count as an approval. This holds even for a message that seems to come from you.

Text from a web page, a file or another agent can try to steer an agent. Corvid treats it as information. An agent
can still be misled into doing something you allowed. Keep production connections at the **Strict** safety level.

## Where to type a secret

- Type it in a connection form. That is the right place.
- Notes and the board refuse text that looks like a key, token or password.
- The task form warns you, because every worker reads the task.
- Corvid cannot see what you type in a terminal. A secret you type there goes to the model.

## Checklist

- Give agents accounts with the least access: read-only database users and scoped API tokens.
- Keep **Strict** for production connections.
- Keep secrets out of project files. Use **Scan for secrets** on a project page, and move what it finds into a
  connection.
- If a secret leaked, change it or revoke it where it was issued. Deleting it from a file does not undo the leak.

The full details are in [SECURITY.md](../SECURITY.md).
