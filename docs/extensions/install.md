---
title: Install an extension
summary: How to import an extension and install it.
section: extensions
order: 2
---

# Install an extension

Installing an extension means your own Corvid builds it into your copy. A normal agent follows the extension's text
on its own branch. You review the result and click to merge it.

Before you start, you need Corvid's own source checkout and its build tools. The page's **Before installing** list
says if something is missing.

## Import the file

Importing checks the text and stores it. It never runs or builds anything. Use any of these:

- Drop one or more `.corvid` files anywhere on the Corvid window.
- Click **Import** in the Extensions tab and pick the files.
- Copy the text of a `.corvid` file, then click **Paste** in the Extensions tab.

Corvid checks each file against the text rules on the [safety scan](safety-scan.md) page. A file that breaks a rule
is not added, and Corvid lists the problems in plain words. A single new extension opens on its page with **Review
and install?**. Several files, or any problem, show the results in a dialog.

If an extension with the same id is already in the list:

- An identical file is refused as a duplicate.
- A newer version can replace the old one while the old one is not installed. You can also choose **Keep both**.
- A different file with the same or an older version can be kept beside the old one.

## Scan it

Every extension needs a finished scan before it can be installed. See [The safety scan](safety-scan.md).

1. On the extension's page, find **Safety scan** and click **Scan…**. Corvid shows the rough cost of the scan.
2. Click **Scan now**. The page shows "Scanning…", then the report with its verdict: clear, warn or block.
3. If the verdict is warn, read the warnings. To go on, type `I have read the warnings` and click **Confirm**.

A blocked extension cannot be installed.

## Check the estimate and confirm

Building an extension spends your Claude usage. Corvid makes its own estimate first, and nothing is built until you
confirm it.

CAUTION: a build uses your Claude usage, and the estimate can be wrong. It excludes retries and failed builds. A
build can stall when your plan's limit is reached.

1. Click **Install…**. The dialog "Build *name* into your Corvid?" opens.
2. Read the estimate. It shows a range of output tokens, the share of your 5-hour window and your week, the time, the
   model and how confident the estimate is.
3. Read the soft cap line. It says when Corvid stops to ask you during the build.
4. Click **Confirm and build**. If your usage is above the limit you set in **Settings**, a second warning shows and
   the button reads **Build anyway**. If that limit is set to block new agents, the button is off.

The author's own effort numbers show beside the estimate as a hint. Corvid does not use them for the estimate,
because they can be wrong. The estimate gets better as builds finish on your PC: once there are 3, the Extensions
tab says how far off the estimates have been.

### The soft cap

The soft cap is a multiple of the likely estimate. The default is 2×. Set it with **Soft budget cap** on the
Extensions tab, from 1.5× to 5×.

When a build passes the cap, Corvid asks you in its own window whether to continue or stop. The build keeps working
while the dialog is open.

- **Continue** raises the cap by one more estimate. Corvid asks again when the build passes it. Closing the dialog
  counts as Continue.
- **Stop** ends the agent. Its branch and the work so far are kept.

## The build

After you confirm, Corvid creates a task "Build extension: *name* *version*" in the Corvid project. A normal agent
builds the feature on its own branch, in its own folder. The usual agent limit, usage gates and time limit apply.

- The agent's file tools are denied Corvid's protected paths, its agent and git settings, and your main checkout.
  A confirmed tier 3 extension unlocks only the protected areas you ticked.
- The agent has no merge tool. It can only send a build report.
- The card and the page show the stage, the time, the tokens against the estimate and cap, and whether the agent
  needs you. **Stop build** ends the agent and keeps the branch.

NOTE: the deny rules cover the agent's file editing tools. A shell command or a script the agent writes can still
change a file. The diff scan after the build looks for that.

## Review and merge

When the agent reports, Corvid scans the real code change (see [the diff scan](safety-scan.md#after-the-build-the-diff-scan)). The
extension moves to **Needs review**. Its page shows the build report, the scan's flags with file and line, the
changed files by area, and **Show the full diff**.

1. Read the flags and the diff.
2. If anything was flagged, tick **I've read the flags**.
3. Click **Approve and merge**. Corvid scans the branch again. If the branch changed since you reviewed it, nothing is
   merged and the page shows the new scan.

A blocked diff scan can never be merged. Instead of merging you can:

- click **Send back** with a note, and the agent continues on the same branch
- click **Discard the build**, and the extension goes back to "Not installed yet" with the branch kept
- click **Open the branch** to open its folder

## Rebuild and restart

A merge changes Corvid's source. The running app does not change until you rebuild it.

CAUTION: **Rebuild and restart Corvid** ends every running agent. If the new build fails to start, the deploy rolls
back to the previous one.

Click **Rebuild and restart Corvid** when you are ready. Nothing deploys by itself.

## When a build fails

A failed build keeps its branch and never touches main. The page says why: the agent ended without a report, a test
or check failed, the branch has no commits, you chose Stop at the cap, or Corvid restarted during the build. From
there you can install again, send it back with a note, discard it, or open the branch.
