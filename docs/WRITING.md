# Writing the docs

This guide is for anyone who writes or edits Corvid's docs. The docs follow the ASD+ standard in
[ASD-PLUS.md](ASD-PLUS.md). This guide does not repeat the standard. It names its rules by number, like "rule 1.8".

The same Markdown files are shown in two places: the Docs view inside Corvid, and the docs pages on the website.
Write each page once, here in `docs/`.

## Where pages live

- `docs/index.md` is the entry page. It links to every page.
- `docs/sections.json` lists the sections, with an id, a title and an order.
- Each page is one file in its section's folder, like `docs/tasks-and-agents/blocked-by.md`.
- Images go in `docs/images`.
- Files at the top of `docs/`, like this one and `PLATFORM.md`, are not pages. They are not shown in the Docs view.

To add a page, create the file, give it front matter, and add a link to it in `docs/index.md`.

## Page template

```markdown
---
title: Blocked by
summary: How to mark a task as waiting on other tasks.
section: tasks-and-agents
order: 5
---

# Blocked by

One or two sentences that say what this is and when you need it.

## Mark a task as blocked

1. Open the task.
2. ...
```

## Front matter fields

| Field | What it holds |
|---|---|
| `title` | The page name. The first heading of the page is the same text. |
| `summary` | One sentence that says what the page covers. It ends with a full stop. It shows in the nav and in search results. |
| `section` | The section id from `docs/sections.json`. It is the same as the folder name. |
| `order` | A whole number that sets the page's place in its section. Two pages in a section cannot share a number. |

`docs/index.md` has only `title` and `summary`.

## Procedures

A procedure is a list of steps the reader follows.

1. Number the steps.
2. Put one action in each step.
3. After an action that changes the screen, say what the reader sees. For example: "Click **Automate**. The task
   moves to **In progress**."
4. Start each step with the action, not with the reason.

Put anything the reader must have before they start, like a project folder, above the first step.

## Names of things in the app

- Write the name of a button, field, tab or menu item in bold, with the exact label the app shows: **New task**,
  **Plan & ask**, **Settings**.
- Copy the label from the app or from the source code. Do not write it from memory.
- Write a path through menus with an arrow: **Settings** → **Board and notifications**.
- Write file names, commands and code in inline code: `npm run setup`, `tasks.json`.

## Keyboard shortcuts

Write the Windows and Linux key first, then the macOS key in brackets: "press Ctrl+P (Cmd+P on macOS)". Write
keys with a capital letter, joined with "+". If a shortcut is the same on every platform, write it once.

## Screenshots

- Take screenshots from a test copy of Corvid with fake data only. Start one with `npm run test-instance`. Never
  use your own Corvid.
- A screenshot shows no personal paths, user names, email addresses, project names or tokens.
- Save it as WebP, or as a compressed PNG, in `docs/images`. Use a name that says what it shows, like
  `tasks-board-dark.webp`.
- Every image has alt text that says what the image shows: `![The task board with four columns](../images/tasks-board-dark.webp)`.
- Add a screenshot only when it helps the reader find something. Text comes first.

## Links

- Link to another page with a relative path to its file: `[Blocked by](../tasks-and-agents/blocked-by.md)`.
- Link to a heading with `#` and the heading's anchor: `[Columns](task-board.md#columns)`.
- The link text says where the link goes. Do not write "click here".
- The linter fails on a link to a page or heading that does not exist.

## Check every claim

Every fact on a page is checked against the app or its source code before it is merged. If you are not sure,
start a test copy and try it. If something is not built yet, do not describe it as if it works (rule 5.3).

If a part of a page must wait, write `TODO:` and the reason, like `TODO: screenshot after the Docs view lands`.
The linter fails on a `TODO` with no reason.

## The linter

Run `npm run docs:lint`. It also runs as part of `npm test` and in CI. It prints each finding as `file:line`, with
the rule it breaks. Errors fail the run. Warnings print, and the run still passes.

| Check | Level | Rule |
|---|---|---|
| Em dash | error | 1.8 |
| Emoji | error | 1.6 |
| A word or phrase from the banned table | error | Part 6, shown as 6 |
| A weasel word | error | 1.9 |
| `TODO` with no reason | error | 5.3 |
| Front matter missing, wrong or with an unknown section, or two pages with the same order | error | front-matter |
| A link or image to a file or heading that does not exist, or an image with no alt text | error | links, images |
| A page that no link path from `docs/index.md` reaches | error | index |
| Headings: the page does not start with one level 1 heading, or a level is skipped | error | headings |
| A paragraph of more than 6 sentences or 120 words | warning | 2.6 |
| Section headings on a page of fewer than 100 words | warning | 3.1 |
| An acronym with no spelled-out form on first use | warning | 1.3 |

The banned words and weasel words come from `docs/ASD-PLUS.md` itself, so the list lives in one place. To change
the list, change the standard.

Acronyms that need no spelled-out form are listed in `ACRONYM_ALLOW` in `scripts/docs-lint-lib.mjs`. Add a term
there only when readers of these docs know it.

### Quoting a banned word

Sometimes a page must show a banned word, for example to quote an error message. Any of these is allowed:

- Put the word in inline code or in a fenced code block.
- Put `<!-- asd-ignore: reason -->` on the same line, or on the line before. The reason is required.

## The manifest

`npm run docs:manifest` reads the front matter of every page and writes `out/docs/docs.json`. It holds the nav
(sections and pages in order, with titles, summaries and paths) and the search text of each page. The Docs view
and the website both build from it. The code is in `scripts/docs-lib.mjs`.
