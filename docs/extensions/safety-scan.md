---
title: The safety scan
summary: How Corvid checks an extension before and after it is built.
section: extensions
order: 3
---

# The safety scan

Corvid checks an extension three times: when you import it, before you install it, and after the build. Each check
looks for known risks. None of them proves an extension is safe.

WARNING: wording can be written to slip past every check on this page. An extension's text becomes instructions to
an agent that can edit Corvid, and Corvid holds your connections and secrets. Read the scan report and the diff
yourself, and install extensions only from people you trust.

## On import: the text rules

Every import goes through a strict, line-based check. It refuses:

- a file over 64 kilobytes (KB), or one that is not valid UTF-8 text
- control characters and hidden Unicode, such as zero-width and text-direction characters
- look-alike letters in the name or author, such as mixed alphabets
- HTML, script links and inline event handlers
- encoded blobs, such as long base64 or hex runs and escaped bytes
- patches and diffs
- too much code: more than 3 code blocks, or blocks over 15 lines
- a broken header or broken sections, such as unknown fields or a tier below the core areas it declares

A refused file is not added. The errors are listed in plain words.

## Before install: the scan

The scan reads the text and runs nothing. It has two layers.

**Text checks** are instant and free. They list every web address, host, e-mail address, file path and package the
text mentions. They flag:

- a host or package the header does not declare
- wording that tells the agent to ignore its instructions, or that speaks to the scanner
- hiding things from you, or sending data somewhere
- reading secrets, keys, connections or Corvid's data folder
- switching off approvals, safety levels, deny rules, scanning, backups, limits or the rollback
- the deploy script, start-up items, install scripts, downloading and running code, encoded commands, and changes to
  git remotes

A mention of a protected area forces the extension to tier 3, whatever the author declared.

**The classifier** is the artificial intelligence (AI) part of the scan: a Claude model that reads the text and reports what it would do. It runs through your own
Claude command-line tool with no tools, no MCP servers, no settings and no project access, in an empty temporary
folder. It runs twice with different instructions, and the stricter answer counts.

The classifier uses your Claude usage. Haiku is the default model. Before a scan runs, Corvid shows its rough cost in dollars. On Haiku a scan of a small extension is under 1 cent.
Change the model with **Classifier** in the **Safety scan** section. Results are kept by the text's hash, so the same
text is not scanned twice.

## The verdict

| Verdict | When | What you can do |
|---|---|---|
| block | Any flag for sending data out, reading secrets, switching off safeguards, deceiving you, or targeting the build agent. Or the classifier says block. | Read the report and delete the extension. You cannot override a block. |
| warn | Any other flag, an undeclared host or package, a forced tier, or something odd in the text. | Type `I have read the warnings` to go on. Corvid records it. |
| clear | Nothing above. | Go on to install. |

A failed scan is never clear. If the classifier cannot run, gives a bad answer twice, times out, or Corvid closes
during the scan, the page says **The scan failed** and offers **Scan again**. The extension has no verdict until a
scan finishes.

### Review without the AI scan

You can skip the classifier with **Review without the AI scan…**. Then only the text checks have read the extension.

WARNING: without the classifier, nothing has checked what the extension's wording is trying to do.

To skip it, type `review without scan` and click **Review without scan**. Corvid records the choice. A blocked
extension cannot skip.

## After the build: the diff scan

After the build agent reports, Corvid scans the real code change on the branch. It flags or blocks:

| What it looks for | Result |
|---|---|
| A protected path changed, unless you confirmed tier 3 for that area | block |
| Install scripts in `package.json` | block |
| Reading secrets, the connection store or credential files in code | block |
| Changes to agent or git settings | block |
| New packages or hosts the extension did not declare | flag |
| Network code, dynamic code, or code that runs programs | flag |
| Writes outside the app, updaters, start-up items, the deploy script | flag |
| Encoded strings, binary files, very large files | flag |
| Changes outside the areas the extension declared | flag |

A blocked diff can never be merged. A flagged diff can be merged after you tick **I've read the flags**. Corvid runs
the scan again right before the merge, on the branch as it is then.

The diff scan uses a fixed list of patterns. Code can hide what it does from any fixed list. Read the diff.

## What stays your responsibility

- Read the scan report before you confirm a warning.
- Read the diff before you click **Approve and merge**.
- Treat an author's "verified" claim as a claim. Corvid shows it as one and still runs every check.
