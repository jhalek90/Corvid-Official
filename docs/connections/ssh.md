---
title: SSH servers
summary: How to add a server that agents can run commands on.
section: connections
order: 7
---

# SSH servers

An SSH (Secure Shell) server connection lets agents run commands on a server and upload files to it. Corvid signs in
with the password or key you saved. The agent never sees it.

## Add a server

Before you start, have the host name, the port, the user name, and either the password or a private key file.

1. Open the Connections tab and click **Add connection**.
2. Click **SSH server**. You see the **New SSH server** form.
3. Fill in **Name**, **Host**, **Port** and **User**. Agents use the name.
4. Under **Sign in with**, click **Key file** or **Password**.
5. For a key file, click **Browse…** and pick the **Private key file**. Corvid stores the path only, never a copy.
   If the key has a passphrase, type it under **Key passphrase**. For a password, type it under **Password**.
6. Pick a **Safety level**. See [Safety levels](safety-levels.md).
7. Under **Linked projects**, click the projects whose agents may use the server.
8. Click **Add server**. The server's card shows under **Connections**.

Click **Test** on the card to check it. The expanded card has the same check as **Test connection**. The test connects and checks the host key. It runs no command.

The first time an agent uses an SSH server, Corvid asks you to approve the **SSH server** connector. See
[Approvals](approvals.md).

## Host keys

Corvid remembers a server's host key on the first connect. After that it checks the key every time. If the key
changes, Corvid refuses to connect. The card shows the remembered key, with a **Forget** button.

WARNING: a changed host key can mean that another machine answers in place of your server. Click **Forget** only
when you know why the key changed, for example after you rebuilt the server.

## What agents can do

The SSH server connector has three operations:

- `run` runs one shell command and returns the exit code and the output. A plain inspection command counts as a
  read. Any other command counts as a write.
- `run_as_root` runs one command with `sudo -n`. It is always admin, so it always asks, unless the connection is
  **Free** and you allowed admin operations without asking.
- `upload` sends one file from the agent's own folders to the server. It counts as a write.

Agents can also use `list_systems` and `run_on`. `run_on` is the same as `run` and goes through the same approvals
and kill switch.

CAUTION: on **Approve writes**, Corvid decides what counts as a plain inspection command. On **Free**, every command
runs without asking. Use **Strict** for a server you care about.

## Uploads

`upload` takes a local path, a remote path, and optionally `overwrite` and `mode`. The file goes from disk to the
server over SFTP (SSH File Transfer Protocol). The file is written with the connection user's permissions. There is
no root version of `upload`.

When an upload waits for approval, the dialog shows the file, its size, the start of its SHA-256 hash and the remote
path. The result gives the full hash and a `sha256sum` command to check the file on the server.

Corvid refuses an upload before it asks you when:

- the file is outside the agent's worktree (or its project folder, when it has no worktree) or its session
  scratchpad. Corvid resolves links and `..` first. A worktree's `node_modules` link counts as outside.
- the agent is not a task worker, so Corvid does not know its folders,
- the file is covered by the rules in [Files agents may not read](../settings/files-agents-may-not-read.md),
- the file is in `~/.claude`, `~/.ssh`, `~/.gnupg` or a keyring folder, or has the name of a key or credentials file.
  These are refused even when you turned the matching rule off,
- the content holds a secret: a match for the commit secret scan, or any password or key saved in Corvid. Corvid
  unpacks a gzip file to check it, and checks the member names of a tar file,
- it is not one plain file. Pack a folder with `tar` first,
- it is larger than 50 megabytes (MB),
- a file already exists at the remote path and `overwrite` is not `true`. A remote path that is a folder is always
  refused,
- `mode` is not three octal digits, like `644` or `0644`. Setuid, setgid and the sticky bit are refused.

NOTE: Corvid checks xz and zip files as they are, without unpacking them. A key packed inside one is not found by the
content check. The folder and file name checks still apply.

## Audit

Every command and upload is written to the audit log: the command, the outcome and who approved it. For an upload
it has the path, the size and the hash. It never holds the output or the file content. See
[Audit](overview.md#audit).

## Delete a server

1. Expand the server's card.
2. Click **Delete**, then confirm. Corvid deletes the saved password or passphrase too. It does not touch your key
   file.
