---
title: Files agents may not read
summary: The files Corvid keeps away from agents, and how to change the list.
section: settings
order: 2
---

# Files agents may not read

Corvid stops agents from reading or editing files that hold secrets, like `.env` files and SSH keys. Every agent
Corvid starts, and Corvid's own chat, gets a list of Claude Code deny rules for these files.

The rules are added on top of your own Claude Code settings. Corvid never changes your Claude Code settings.

## What is on the list

- **Corvid's data folder.** It holds your connections, secrets and backups. This rule cannot be switched off.
- **Credential files in your home folder**, such as `~/.ssh/**`, `~/.aws/**`, `~/.azure/**`, the Google Cloud
  folder, `~/.kube/**`, `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/.git-credentials`,
  `~/.gnupg/**` and `~/.claude/.credentials.json`.
- **Secret files in a project**: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `id_rsa`, `id_dsa`,
  `id_ecdsa`, `id_ed25519`, `credentials.json` and `secrets.*`.

macOS also gets a rule for `~/Library/Keychains/**`. Linux also gets one for `~/.local/share/keyrings/**`. Both get one
for `~/.config/gh/hosts.yml`, the GitHub command-line tool's token.

## What the rules stop, and what they do not

The rules stop Claude Code's own file tools. They also stop shell commands that Claude Code knows read a file, like
`cat .env` or `type .env`.

They do not stop a script that an agent writes and runs, because the script opens the file itself.

WARNING: a deny rule does not keep a secret safe from a script. Keep real secrets in a Corvid connection, where agents
never see them. See the [Connections overview](../connections/overview.md).

## Change the list

Open **Settings** → **Connections and safety** → **Files agents may not read**. Changes apply to agents that start
after the change. An agent that already runs keeps the rules it started with.

To switch a default rule off:

1. Clear the check box next to the pattern. Agents that start after this are no longer blocked from those files.

To add your own pattern:

1. Type a path or glob in the box under the list, like `**/*.secret` or `~/.myapp/token`.
2. Click **Add**, or press Enter. The pattern shows in the list, marked **yours**.

A pattern cannot contain brackets. To remove one of your patterns, click the X next to it (**Remove this pattern**).

To go back to the defaults:

1. Click **Reset**. Every default is on again, your own patterns are removed, and no file is allowed. The button shows
   only when you have changed something.

## Allow one file

Sometimes an agent needs one secret file in a project, for example a test key. You can allow that one file without
switching off the whole rule.

1. Open the project page and find the file in its [secret scan](../projects/projects-page.md#secret-scan).
2. Click **Allow this one** on the file's row. Agents in that project can now read that file.

The file shows in Settings under the list, with the project's name. To block it again, click the X next to it (**Block it again**).

NOTE: when you allow one file, Corvid lifts the pattern for that project and blocks each of the project's other
matching files by its exact path. A matching file created after the agent starts is not covered for that agent.
