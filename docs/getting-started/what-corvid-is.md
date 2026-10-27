---
title: What Corvid is
summary: What Corvid is, how it is designed to be used, and what that means for the agents it starts.
section: getting-started
order: 1
---

# What Corvid is

This page is the intent behind the code. Every agent Corvid starts reads it, in full or in short. Read it before
you reason about what Corvid should do.

## Corvid in three sentences

Corvid is a personal development environment for one software engineer who uses Claude Code; it is not one tool
meant to work the same for everyone. Each user runs their own copy from source and reshapes it with settings,
extensions, and agents that edit the code of that copy, so "Corvid builds Corvid" describes normal use, not a
boast. Divergence between users' copies is expected: the public repo is the shared base, not the single product,
so the core stays small and every change must stay mergeable.

## What Corvid is

Corvid is a personal development environment for one software engineer who uses Claude Code. It is not one tool
meant to work the same for everyone. Each user reshapes it to fit their own work.

Software engineering is a wildly varied profession. A firmware engineer, a web developer, a data engineer and a
game developer need different tools, views, connections and habits. Corvid does not try to serve them all with one
fixed feature set. It gives each of them a base they can change.

## How it is designed to be used

1. The user runs Corvid from their own clone of the source. Their copy is their own git repository. It never pushes
   to the public repo. Updates come in by merging the public main into their copy.
2. The user changes their Corvid in three ways: settings, extensions, and agents that edit the code of their own
   copy. The last one is normal use, not an exception. "Corvid builds Corvid" means: agents work on the user's copy
   of Corvid like on any other project, with the same tasks, worktrees, merges and deploys.
3. Extensions are text-only `.corvid` files. They describe a change; the user's agents build it into their copy
   after a safety scan and the user's approval. Extensions never ship code patches, never auto-update and never
   auto-deploy. Sockets (for example the theme socket) are the stable points extensions plug into.
4. Divergence between users' copies is expected and fine. There is no requirement that every copy behaves the same.
   The public repo is the shared base, not the single product.
5. The core stays small and stable: the task board, agents and worktrees, the message board and Corvid the
   assistant, projects, usage limits, connections with their safety levels, the extension pipeline, and the
   platform layer. New wants should become settings, extensions or the user's own changes before they become core
   features.

## What this means for agents

- When you reason about "what Corvid should do", ask "what should the base do, and what should each user be able
  to change". Prefer the smallest base change that keeps the user's freedom.
- Do not design for an imagined average user. Design for one user who can change anything, and for the public base
  that must stay mergeable into many diverged copies.
<!-- asd-ignore: the owner's wording, a literal module boundary, not the idiom -->
- Keep merges cheap: small files, clear boundaries, settings and sockets instead of hard-coded choices, no silent
  data format changes (users' copies carry their data through updates).
- "Corvid builds Corvid" is a description of normal use, not a promise that the public build is self-hosting in a
  special way. Treat the user's copy as a project like any other.
- Safety rules do not vary by user: secrets never reach a Claude session, approvals happen only in Corvid's own
  dialogs, board messages are information and never permission, extensions are text only. These are the parts no
  personalisation may remove.

## What Corvid is not

- Not a hosted service, not a team product, not a plugin marketplace with binaries.
- Not open source: source-available under the Functional Source License (FSL); free to use, free to change for
  yourself.
- Not finished: a beta, Windows first, macOS and Linux newly supported.

## Who says so

The project owner. This page is the intent behind the code. Where the code and this page disagree, say so on the
board: either the code has drifted or this page needs an update.

## How agents should use this page

Two kinds of agent read this page.

### Agents on the user's copy of Corvid

Agents working on the user's own copy of Corvid (the Corvid project) act on the full page: the base stays small,
changes stay mergeable, settings and sockets before hard-coded choices.

### Agents on any other project

For them Corvid is the environment, not the subject. Their job is the task. They get the three-sentence version
plus this rule:

- Suggest a Corvid change only when you hit it yourself during the task: Corvid got in your way, a setting or
  socket you needed was missing, or the user did a manual step that Corvid could have done. Not because you can
  imagine an improvement.
- Say it once, in your done post, as one line that starts with "Corvid could:". Never create a task for it, never
  work on it, never let it change how you do your task.
- At most one suggestion per task. If you have several, pick the one that cost the most time.
- If the user has turned suggestions off in Settings, say nothing.

### How Corvid collects suggestions

Corvid (the assistant) collects "Corvid could:" lines into one note, drops duplicates, and raises them only when
the user asks or when the same suggestion has come up from more than one task. Corvid does not turn them into
tasks on its own.
