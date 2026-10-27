# Security policy

Report a security problem in Corvid privately, through GitHub's private vulnerability reporting. Don't open a
public issue, pull request or discussion for it.

This page says how to report and what happens next. What Corvid protects, and where that protection stops, is in
[docs/SECURITY.md](docs/SECURITY.md).

## Supported versions

Only the `main` branch of [Corvid-Official](https://github.com/jhalek90/Corvid-Official) gets security fixes.
Corvid has no release branches and no older versions under support. A fix lands on `main`, and each user's copy gets
it by merging `main`. The update banner's **Create update task** does this; see
[Updates](docs/platforms/updates.md).

If your copy has diverged, check the problem on a current `main` before you report it. If it only happens with your
own changes or extensions, it is not a problem in Corvid's base.

## How to report

1. Open the [Security tab of Corvid-Official](https://github.com/jhalek90/Corvid-Official/security).
2. Select **Report a vulnerability**. This opens a private advisory that only you and the maintainer can see.
3. Describe the problem:
   - what an attacker can do, and what they need first (for example, a crafted web page an agent reads, or a
     `.corvid` extension the user installs)
   - the steps to reproduce it, with the smallest setup that shows it
   - the Corvid commit (`git rev-parse HEAD` in your copy), your operating system and your Claude Code version
     (`claude --version`)

Never put a real password, key or token in a report. Use fake values that have the same shape.

## What to expect

Corvid has one maintainer, so these are targets, not guarantees:

- A first reply within **7 days**, saying whether the report is in scope.
- An assessment within 14 days: how serious it is, and a plan for the fix.
- A fix on `main` as soon as it is ready, then a published GitHub security advisory. The advisory credits you by
  name, unless you ask to stay anonymous.

Keep the report private until the advisory is published, or for 90 days after your report, whichever comes first.
If a fix needs more time, the maintainer will tell you why and ask for a later date.

Corvid has no bug bounty. There is no payment for reports.

## Scope

In scope: anything that breaks a protection [docs/SECURITY.md](docs/SECURITY.md) says Corvid gives. For example:

- A secret saved as a connection reaches a Claude session, a log, a note, the board, an export or a backup.
- An agent, a board message, a note or a tool argument approves a connector, a write or a command without the
  user's choice in Corvid's own dialog.
- An extension build changes a protected path without the user's confirmation, or a `.corvid` file runs code.
- A deny rule fails to block something that docs/SECURITY.md lists as blocked.
- Another user on the same computer, or a program on the network, can reach Corvid's local server or data folder.

Out of scope:

- Limits that docs/SECURITY.md already states, for example a program an agent writes that opens a denied file
  itself, or a call result that reaches the model.
- Problems in Claude Code itself. Report those to Anthropic.
- Problems in a dependency that Corvid's use of it doesn't expose. Report those to the dependency's project.
- Attacks that start with full control of the user's account.
