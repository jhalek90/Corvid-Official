---
title: What extensions are
summary: What an extension is, and what it can and cannot change.
section: extensions
order: 1
---

# What extensions are

An extension is a feature for Corvid, shared as a short text file. Your own Corvid reads the text and builds the
feature into your copy. The author's code never reaches you.

## A text file, not code

An extension is one file with the ending `.corvid`. It is plain UTF-8 text, at most 64 kilobytes (KB). It holds:

- a header with the name, version, tier and declared capabilities
- a summary and a description of what the feature does
- a seed prompt: the instructions a build agent follows to build the feature
- numbered acceptance checks that say how to tell the build works

Corvid refuses a file that holds a patch, a diff, encoded data, HTML or more than a few short code snippets. The
[safety scan](safety-scan.md) page lists every rule.

## How an extension gets into your Corvid

1. You import the `.corvid` file. Corvid checks the text and stores it. Nothing runs.
2. Corvid scans the text for risks.
3. Corvid estimates what the build costs in Claude usage. You confirm the estimate.
4. A build agent builds the feature on its own branch in Corvid's project.
5. Corvid scans the real code change. You review it and click to merge it.
6. You rebuild and restart Corvid when you are ready.

[Install an extension](install.md) walks through each step.

## Tiers

Each extension declares a tier. The tier says how deep into Corvid the feature reaches. The Extensions tab shows it
as a word.

| Tier | Shown as | What it may change |
|---|---|---|
| 1 | adds files | New files and their registration lines only. |
| 2 | changes core | The interface, board, tasks, notes, settings, projects, agents and terminals. |
| 3 | changes protected core | Connections and approvals, remote systems, secrets, deny rules and secret scanning, usage gates, backups, crash handling, the deploy script, and the extension machinery itself. |

A tier 3 extension needs an extra confirmation before it is built. You tick a box for each protected area it
declares.

## What extensions never do

- **Ship code.** Authors share text. Your own build agent writes the code on your PC.
- **Run on import.** Importing only checks and stores the text.
- **Install, approve or merge by themselves.** Only a click in Corvid's own window does that. No agent, tool or board
  message can import, install or approve an extension.
- **Update by themselves.** A newer version is a separate file that goes through its own scan, estimate, build and
  review.
- **Deploy by themselves.** After a merge, Corvid offers **Rebuild and restart Corvid**. Nothing restarts until you
  click it.
- **Get pushed.** An installed extension stays on this PC. Corvid does not push its merge, whatever the push setting
  says.

## Your part

Corvid's checks reduce risk. They do not make an extension safe. The scans look for known patterns, and wording can
be written to slip past them. You are the last check: read the scan report, read the diff before you merge, and
install extensions only from people you trust.

## The Extensions tab

Open it from the rail, or press Ctrl+8 (Cmd+8 on macOS). Each extension shows as a card with its name, version,
author, tier, effort and status. Click a card to open the extension's page.

At the top of the tab are **New extension**, **Import** and **Paste**.
