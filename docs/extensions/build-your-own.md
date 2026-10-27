---
title: Build your own
summary: How to write and package your own extension.
section: extensions
order: 6
---

# Build your own

The **New extension** wizard turns a feature you built, or a new idea, into a `.corvid` file. Then **Verify…**
test-builds the file on a clean copy of Corvid. Only a verified extension can be shared.

## Package a feature with the wizard

The wizard is a guided chat with a packaging agent. It only produces text. It never installs, builds, deploys or
shares anything.

CAUTION: the packaging agent uses your Claude usage. The wizard shows an estimate before it starts. A session stops
at 14 turns.

1. In the Extensions tab, click **New extension**.
2. Check **Author name in the file**. It defaults to your board name. Nothing from this PC is added.
3. Pick how to start:
   - **From something I built**: pick one or a few related features you merged on this Corvid. Corvid lists your
     merged task branches.
   - **From scratch**: answer a short interview about a new idea.
4. Click **Start the packaging agent**. The agent shows on the Agents page while it works.
5. Read the outline the agent proposes. Click **Approve the outline and write it**, or say what to change.
6. Read the draft and the problems listed under it. Fix every problem in the chat.
7. Click **Save as extension**. The extension appears in the list as **Not installed yet**.

The packaging agent can read Corvid's source with read-only tools. It cannot read secrets, connections or Corvid's
data folder. For **From something I built**, it reads the task notes, board posts and diff privately, to understand
what the feature does.

Corvid sets the facts it knows itself: the id, the version, the author, the Corvid version it was built on, and the
measured effort. It also works out the tier and capabilities from the diff.

To change an extension you created, click **Edit** on its page. The wizard opens on its text and saves a new version.

## Corvid's checks on every draft

A draft can be saved only when it passes every check:

- the same text rules as an import, so patches, diffs and too much code are refused
- a leak check for local paths, your account and PC names, project names, connection names and hosts, and things that
  look like keys, tokens or passwords
- wording that steers the build agent beyond the build, such as "don't tell the user" or "skip the checks"
- the declared tier against what the diff touched
- the instant text checks of the [safety scan](safety-scan.md)

The leak check finds common patterns. It does not find everything. Read the full text before you save it.

## Write a good extension

- **Describe behaviour, not code.** Say what the user sees and can do, and what data it stores. Do not describe how
  your code did it.
- **Write a seed prompt that builds anywhere.** Name parts of Corvid by what they do, such as "the board view", not
  by file names.
- **Leave out everything of yours.** No paths, machine or account names, project names, hosts, connections or keys.
- **Write acceptance checks a stranger can run.** Number them. Make each one concrete, like "Pinning four messages
  shows only the last three, newest first". Add a restart check when the feature stores data.
- **Declare an honest tier and capabilities.** List every core area, package and host. A tier lower than the change
  needs is refused.
- **Describe only the build.** Say nothing about what to tell or hide from the user, or about the scan, the checks or
  approvals.
- **Use a socket when one fits.** See [Sockets and themes](sockets-and-themes.md).

## Verify

**Verify…** test-builds the extension from its text on a clean, throwaway copy of Corvid. It uses the same rules,
deny rules, diff scan and checks as an install. It is never merged. Your main, your installed extensions and your
running Corvid do not change.

CAUTION: a verify build uses your Claude usage, like an install. The confirmation shows the estimate and the soft cap.

Before you start, the extension needs a finished scan. A tier 3 extension also needs its tier 3 confirmation.

1. On the extension's page, open **Verify and share** and click **Verify…**.
2. Under **The clean copy**, pick where the build starts. The default is the extension's built-on commit. On your own
   Corvid, where that commit already has your feature, Corvid uses the commit just before your feature was merged
   and says so.
3. Read the estimate and click **Confirm and verify**.
4. Wait for the result. Corvid removes the throwaway branch and folder afterwards and keeps the report.

A verify passes when every acceptance check passed, no test failed, the typecheck passed, and the diff matches the
declared capabilities. A tier 1 extension must also keep the tier 1 shape. Anything else fails, with every reason
listed. For an extension you created, **Fix in Edit** opens the wizard with the findings.

A pass counts only for this exact text. Any edit makes a new version that needs a new verify.

NOTE: verified means the text rebuilt the feature on a clean Corvid at that version. It does not prove the feature is
safe, or that it builds the same way on other versions or with other models.

## Share

Sharing saves the extension's text as a file, or copies it. Nothing is uploaded, and Corvid sends no data anywhere.

1. On a verified extension's page, click **Share…**. The dialog shows a summary, the final leak check and the full
   text.
2. If the leak check found something, the better fix is **Edit**, then verify again. To share the file as it is,
   tick **I've read these and the file is fine to share as it is**.
3. Click **Save as .corvid…** and pick a place, or click **Copy as text**.

The shared file carries the real effort from the verify and a verification block with the commit, the date and the
Corvid version.

When someone imports your file, their Corvid shows the verification block as your claim. Their Corvid still runs the
full scan, estimate, build and review.

## Licence

A `.corvid` file is its author's own text, and the author decides how to share it. The feature it builds is a change
to Corvid, so it falls under Corvid's licence. The `LICENSE` file in the repository is what counts.
