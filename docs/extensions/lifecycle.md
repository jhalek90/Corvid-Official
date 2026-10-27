---
title: Disable, update and remove
summary: How to turn an extension off, update it or take it out.
section: extensions
order: 4
---

# Disable, update and remove

An installed extension's page has buttons to switch it off, take it out, put it back and update it. Most of these
use git only: no agent and no Claude usage.

## How a change is made

Disable by revert, Enable after a revert, Remove and Re-apply work the same way:

1. Corvid makes a new branch in its own folder and applies the change there.
2. The page shows the change for review: the files, the typecheck result and the full diff.
3. You click **Approve and merge**, or **Discard**. Discard keeps the branch.

Only your click merges. Nothing is pushed. After a merge, the page offers **Rebuild and restart Corvid**.

CAUTION: **Rebuild and restart Corvid** ends every running agent.

Only one change per extension can wait for review at a time. If main has uncommitted changes, or agents are working in
the Corvid project, Corvid asks you to confirm first. The merge still refuses while main has uncommitted changes.

## Disable and Enable

The **Disable** button tells you which kind of disable you get.

- **Disable (instant)** shows when the build put the feature behind a flag that the code reads. Corvid switches it
  off at once, with no rebuild. New agents get the change. Running agents keep the tools they started with.
- **Disable (needs a rebuild)** shows when there is no such flag. Corvid reverts the extension's merge on a branch
  for your review. The status becomes **Disabled** after the merge.

**Enable** turns the flag back on, or reverts the revert. If Corvid changed so much that the old commits no longer
apply, the page offers **Rebuild from the text**.

## Remove

1. Click **Remove…**. The dialog "Remove *name* *version*?" opens.
2. Read the dialog. It lists other installed extensions that need this one. Remove those first, in the order shown.
3. Read the list of files left in Corvid's data folder. Corvid does not delete them. Delete them yourself if you do
   not want them.
4. Choose what happens to the extension's text. Tick **Remove and delete the extension** to delete its stored text.
   Leave it unticked to keep the text, and the extension goes back to **Not installed yet**.
5. Click **Remove**, or **Remove and delete the extension**. The change waits for your review.

A deleted extension is marked **Removed**. It is hidden in the list unless you tick **Show removed**. Its history,
scan and cost records stay.

### When Remove or Disable conflicts

A revert can conflict when Corvid changed the same lines after the extension was installed. Nothing on main changes.
The page names the files and offers two choices:

- **Leave it as it is**: the extension stays installed.
- **Resolve with an agent…**: an agent takes the extension out by hand and keeps the newer changes.

CAUTION: **Resolve with an agent…** uses your Claude usage. Corvid shows an estimate and a soft cap first, and nothing
starts until you click **Confirm and resolve**.

Corvid checks the agent's result itself: the files it changed, protected paths, the diff scan and the typecheck. Then
you review and merge it as usual.

## Put it back

- **Re-apply the stored build** merges the recorded build onto the current main again. It is free and shown for
  review first.
- **Rebuild from the text** runs the full install again: scan if needed, a new estimate, a build agent and review.
  It costs Claude usage. The new build goes on top of the installed one.

## Update

Updates never happen by themselves. When a newer version of the same extension is in your list, the card shows
**Update available** with both version numbers.

1. Import the new `.corvid` file.
2. Open the installed extension's page. Click **Show what changed in the text** to read the line diff.
3. Click **Open *version* to scan and install**. The new version's page opens.
4. Scan, confirm the estimate, build and review it like any install.

The new build starts from your current Corvid, with the old version in it. When you merge it, the old version is
marked **Removed**, with its history kept.

## History and changes outside Corvid

Every action and finding is listed in **Lifecycle history** on the page.

At start-up, Corvid checks that each installed extension's merge is still in main. If you reverted, reset or rebased
by hand, the extension is marked **Changed outside Corvid**. **Re-apply the stored build** or **Rebuild from the
text** brings it back.
