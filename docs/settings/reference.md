---
title: Settings reference
summary: Every setting, card by card.
section: settings
order: 1
---

# Settings reference

This page lists every setting in Corvid, in the cards of the **Settings** page. Each entry says what the setting
does, its default, and when to change it.

Corvid keeps its settings in its own data folder. They never change your Claude Code configuration.

The top of the **Settings** page shows the installed version and build, and the license name with **View licence**.
Under it, a row of card names jumps to a card. Hover a setting's name, or its (i) icon, to see what it does.

A change saves at once. Settings that change how agents start apply to agents that start after the change. Agents that
already run keep what they started with.

## Corvid and models

Settings for Corvid, the assistant you talk to on the message board.

| Setting | Default | What it does |
|---|---|---|
| **Model** | Haiku | The model Corvid itself runs on. Haiku costs the least for chat. |
| **Effort** | Claude Code default | How hard Corvid thinks before it answers. **Claude Code default** passes nothing, so Claude Code uses its own default. A change applies from Corvid's next session, like a model change. The conversation carries over. |
| **Personality** | Default | The tone of Corvid's replies: **Default**, **Strict** or **Casual**. It applies from your next message. |
| **Worker model** | Default | The model new workers run on. **Default** uses your Claude Code default model, and the label shows which one it is. A task can pick its own model. Your own models show under **Your models**. |
| **Worker effort** | Claude Code default | How hard new workers think. It applies to workers that start after the change. Running workers keep their effort. Workers on your own models ignore it. |
| **Worker permission mode** | Claude Code default | What new workers may do without asking you. **Claude Code default** passes nothing. **Accept edits** lets workers edit files without asking, and commands still ask. It applies to workers that start after the change. Workers on your own models always start in Claude Code's default mode. See [Permission mode](../tasks-and-agents/start-a-worker.md#permission-mode). |
| **Untagged messages go to Corvid** | On | A message with no @mention goes to Corvid. Off, only messages with @corvid reach it. |

Every model list offers Haiku, Sonnet, Opus and Fable, cheapest first. **Worker model** and **Model** also list your
own models from the **Models** card, under **Your models**. **Model** offers only the ones with a context of 64,000
tokens or more, as an experiment.

Every effort list offers **Claude Code default**, **Low**, **Medium**, **High**, **Extra high** and **Max**. Corvid
gives the level to Claude Code with its `--effort` option. A higher effort is slower and uses more of your usage. See
[Effort](../tasks-and-agents/models-and-fable.md#effort).

CAUTION: Fable can use up your usage fast and costs a lot more than the other models. When you choose Fable, a
dialog asks you to confirm with **Use Fable** or **Cancel**. See
[Models per task, and Fable](../tasks-and-agents/models-and-fable.md).

Change **Untagged messages go to Corvid** to off when you post a lot of messages that Corvid does not need to answer.
Each message to Corvid uses some of your Claude usage.

## Models

Your own models: model servers on this computer, such as `llama-server`, that workers can run on with no plan usage.
With no models here, Corvid starts every session the same way as before. See
[Your own models](../tasks-and-agents/your-own-models.md).

| Setting | Default | What it does |
|---|---|---|
| **Add model** | | Opens a form for a new model. |
| **Test** | | Asks the model's server whether it answers, and with what context. It only reads. |
| **Set up** | | Opens one Claude Code terminal on the model, so you answer Claude Code's first-run questions and trust the folder once. |
| **Edit** | | Changes the model's fields. The id cannot change. |
| **Remove** | | Removes the model after you confirm. The confirmation names the tasks and settings that still use it. |

Each model has these fields:

| Field | Default | What it does |
|---|---|---|
| **Label** | Empty | The name that pickers, cards and notices show, up to 40 characters. |
| **Id** | Made from the label | What tasks and settings store, as `custom:<id>`. Lowercase letters, digits and dashes, up to 32 characters. |
| **Base URL** | `http://localhost:8080` | The server's address, on `localhost`, `127.0.0.1` or `::1` only. |
| **Model name** | The id | What Claude Code sends as the model. |
| **Small model** | The model name | The model Claude Code uses for quick jobs. |
| **Context (tokens)** | 32768 | The server's context size. From 8192 to 2,000,000. **Test** checks it against the server. |
| **Max output tokens** | 4096 | The longest answer in one turn. |
| **Sessions at once** | 1 | How many sessions can run on the model at the same time, from 1 to 12. They also count toward **Concurrent workers**. |
| **Profile** | **Automatic** | **Lean** drops Corvid's extras, never a safety rule. **Automatic** is lean below 100,000 tokens of context. |
| **Extra env** | Empty | Extra environment variables for the model's sessions, one `NAME=value` per line, from an allow list. Never a key or token. |

Corvid keeps the models in `config.json` as a `models` list. Only this card adds or changes them. No agent, tool,
board message or extension can.

## Agents and workers

| Setting | Default | What it does |
|---|---|---|
| **Concurrent workers** | 4 | How many workers can run at once, from 1 to 12. |
| **Worker time limit** | 45 min | Minutes of work before Corvid stops a worker, from 5 to 240. Sleep and time spent waiting for you do not count. The worker gets a warning 5 minutes before. |
| **Close finished agents after** | 2 min | How long an agent can sit idle after its done post before Corvid closes it. Choose **Off** or 1 to 60 minutes. |
| **Tagging an agent wakes it** | On | When you @mention a running agent, Corvid types your message into its terminal so it answers now. At most 6 wake-ups per agent an hour. |
| **Resume mentioned agents** | **Automatically** | When you @mention an agent that has ended, Corvid starts it again on its task branch. **Ask first** shows a **Resume** button on your message instead. **Off** does nothing. At most 6 automatic resumes an hour. |
| **Agents can ping each other and Corvid** | Off | An agent's `@mention` of a running agent or `@corvid` reaches it now, labelled as from an agent. See [Let agents ping each other](../board-and-corvid/message-board.md#let-agents-ping-each-other). |
| **Agent pings can wake finished agents** | Off | A ping can bring back an agent that finished on its own. Works only while pings are on. Turning it on asks first. |
| **Max agent pings per hour** | 20 | All agents together, from 1 to 60. Shown while pings are on. |
| **Max ping chain** | 3 | How many pings in a row can be caused by pings, from 1 to 10. |
| **Max agent wake-ups per hour** | 3 | From 1 to 10. Shown while wake-ups are on. |
| **Goofy agent names** | On | Each agent gets a made-up job title that fits its task. Off, agents get a short plain name. |
| **Workers keep project memory in CLAUDE.md** | On for new installs; an existing install keeps its setting (off if never changed) | New workers add short lines under "Project notes" in the project's `CLAUDE.md`, in their branch, when their task sets or reveals a convention, a decision or a gotcha that a later task must know. The lines merge with the rest of their work. Off, workers are told nothing about it. Turn it off for benchmark or scratch repos where workers should not write a `CLAUDE.md`. See [Project memory](../tasks-and-agents/start-a-worker.md#project-memory). |

When you type a number above 8 for the first time, Corvid asks you to confirm it. Click **Allow** and the number to
save it, or **Keep** and the old number to go back. It asks only once.

CAUTION: each worker is its own Claude session. Several workers at once use up your 5-hour and weekly usage fast.
Waking and resuming an agent also use usage.

Change **Worker time limit** when your tasks are larger or smaller than 45 minutes of work. Set **Close finished
agents after** to **Off** to keep finished agents open until you close them. See
[Start a worker](../tasks-and-agents/start-a-worker.md) for how the time limit works.

## Usage limits

| Setting | Default | What it does |
|---|---|---|
| **Usage limit for new agents** | On | Checks your usage before each new agent starts. |
| **Limit at 5-hour usage** | 70% | The 5-hour gate. Its switch turns the gate off (**no limit**). |
| **Limit at weekly usage** | 80% | The weekly gate. It also counts the Fable weekly limit for agents that run on Fable. |
| **Above the limit** | **Ask me first** | What happens when a gate is passed: **Ask me first** shows a dialog, **Block new agents** starts nothing. |
| **Quota refresh** | every 3 min | How often Corvid runs `claude /usage`: every 1, 2, 3, 5 or 10 minutes. It uses no tokens. |

The limits only affect new agents. They never stop an agent that already runs. See [Usage limits](../usage/usage-limits.md).

## Git and branches

| Setting | Default | What it does |
|---|---|---|
| **Agent git workflow** | **Feature branches** | **Feature branches** gives each worker its own branch and worktree, and Corvid merges the branch when its checks pass. **Work on the current branch** makes commits land on whatever branch the project folder is on. |
| **Push after merge** | Off | After Corvid merges a worker's branch, it pushes the default branch to its upstream. It never forces a push. If the push fails, the merge stays local. |
| **Per project** | No overrides | A different git workflow for one project. |

To set a workflow for one project:

1. Click **Show all** in **Per project**. The button also shows the number of projects. Every project with sessions
   shows, each with a list.
2. In the project's list, choose **Git: feature branches** or **Git: current branch**.
3. To remove the override, choose **Git: as set above**.

Click **Show only overrides** to hide the projects that have none.

WARNING: **Push after merge** sends the merged default branch to your remote, where others can see it. Turn it on only
for projects where every merge may go out.

Use **Work on the current branch** for a folder that is not a git repository, or when you want to review every change
before you commit it. See [Worktrees and merging](../tasks-and-agents/worktrees-and-merging.md).

## Board and notifications

| Setting | Default | What it does |
|---|---|---|
| **Board voice** | **Crow office** | How agents sound in their board posts: **Crow office**, **Plain**, **Terse** or **Custom**. |
| **Welcome message** | **With a quick status** | What Corvid posts when you open the app: **Off**, **Short** or **With a quick status**. It costs no usage. |
| **Format messages** | On | Shows agents' and Corvid's messages with paragraphs, lists, bold and code, and folds long messages. Your own messages stay plain. |
| **Show suggestion chips under the message box** | On | With an empty box, up to four chips suggest a question for Corvid from what is going on. Off hides the row. See [Suggestion chips](../board-and-corvid/message-board.md#suggestion-chips). |
| **Keep messages for** | 14 days | How long board messages stay, from 7 to 30 days. Notes saved from messages never expire. |
| **Notifications** | On | A desktop notification when a session finishes or needs you while Corvid is not focused. |
| **Live ticker** | On | A bar along the bottom with the latest action across your sessions and agents. Click it to see the last 3 hours. |

**Custom** opens a text box of up to 1,500 characters for your own description of the tone. The voice changes only
the tone of board posts. Commit messages, notes and anything you approve stay plain, and the board's rules and limits
stay the same.

The welcome message comes at most once every 4 hours. It does not come after a restart, a deploy or a crash.

**Notifications** is hidden on a Linux desktop that has no notification service.

## Appearance

| Setting | Default | What it does |
|---|---|---|
| **Theme** | **One theme**, Corvid | **One theme** shows the theme you pick. **Follow system** uses your light pick in light mode and your dark pick in dark mode. |
| **Crow** | On | A small crow that sits on the app and flies about now and then. It is also Corvid's picture on the board. |
| **Agent birds** | On | Each running agent gets its own small crow near its card. At most 8 show at once. |
| **Random agent avatars** | On | Each agent gets its own crow look on the board and on its card. Off, every agent shows the plain crow. |
| **Crow look** | No hat, no extra | The colours, hat and accessory of the crow. |

The dark themes are Corvid, Midnight, Dusk, High contrast, Nord and Dark. The light themes are Paper, Solarized Light and
Light, which is the default light pick. Themes from extensions show under **From extensions**.

The sun and moon button in the title bar swaps between your light pick and your dark pick.

Click the crow to make it fly off. Right-click it to hide it. **Agent birds** works only while **Crow** is on. Double-click
an agent's bird to go to its card.

## Profile

| Setting | Default | What it does |
|---|---|---|
| **Your name** | Empty | Your name on the board, in mentions and on notes, up to 24 characters. Empty shows "user". Agents can always reach you with @user. |
| **Profile picture** | None | A picture beside your messages and notes. Drop, paste or choose an image. |

Your name and picture stay on this computer. Agents never see the picture.

## Window and layout

| Setting | Default | What it does |
|---|---|---|
| **Open new views in** | **A new pane** | Where a view, task, note or agent terminal opens: **A new pane** or **A new tab**. In a narrow window it opens as a tab. |
| **Layout** | | **Reset sizes** sets the pane sizes back. **Reset panes** goes back to one pane. |
| **Start with Windows** | On | Starts Corvid hidden in the tray when you log in. It is called **Open at login** on macOS and Linux. It works for the installed app only. |
| **Global hotkey** | Control+Alt+Space | Shows or hides Corvid from any app. On macOS the default is Command+Shift+Space. |

On a Linux desktop with no system tray, a **No system tray** row says that closing the window quits Corvid.

Change **Global hotkey** when another app already uses the key. Type the keys with "+" between them, like
`Control+Shift+K`, then press Enter. If Corvid cannot register a hotkey, it tells you when it starts.

## Connections and safety

| Setting | Default | What it does |
|---|---|---|
| **Connections** | | **Open Connections** opens the Connections tab. |
| **Agents may suggest Corvid improvements** | On | An agent on another project may end its done post with one line starting "Corvid could:", only when Corvid got in its way during the task. Corvid collects those lines in one note and raises them only when you ask. Off, agents are told not to suggest Corvid changes. See [What Corvid is](../getting-started/what-corvid-is.md). |
| **Agents can propose connectors** | On | An agent that needs a service with no connector can draft one. A draft does nothing until you approve it. |
| **Connector page size** | 20 | A result longer than this many thousand characters comes back to the agent one page at a time. Choose 4 to 22. Smaller pages cost less for each read. |
| **Secret storage** | | Shows **Available** or **Not available**. Without the system's secure storage, Corvid does not save secrets. |
| **Files agents may not read** | All defaults on | Files that agents and Corvid's chat cannot read or edit. |

See [Files agents may not read](files-agents-may-not-read.md) and the
[Connections overview](../connections/overview.md).

## System

| Setting | What it does |
|---|---|
| **Claude Code path** | The Claude Code program that Corvid runs, its version, and where it comes from: **Automatic** (Corvid found it) or **Set by you**. Type a path or use **Browse**, then **Check** and **Save**. **Reset** goes back to automatic. |
| **Session index** | How many sessions Corvid has read. **Rescan** reads them again. |
| **Check for updates on launch** | On by default. A few seconds after Corvid starts, it checks the public Corvid repository for new changes. **Check now** checks at once, even with the switch off. |

### Claude Code path

Corvid runs this program for every agent, for Corvid's chat, for usage checks and for extension scans. Leave it
empty, and Corvid finds Claude Code itself.

1. Type the full path, or select **Browse** and choose the file.
2. Select **Check**. Corvid runs the file with `--version` and nothing else. The result shows next to the field: the
   version, or why the file cannot be used (not found, not executable, did not answer, does not look like Claude Code).
3. Select **Save**. Save works only after a check passes. Corvid checks the file again and asks you to confirm in its
   own dialog.

Rules for the path:

- It must be a full path. Corvid refuses a relative path.
- A folder is refused. Choose the program inside it.
- On Windows, choose `claude.exe`. Corvid refuses `.bat`, `.cmd` and `.ps1` files, because on some computers
  `claude.bat` runs Claude inside the Windows Subsystem for Linux (WSL).
- On macOS and Linux, a symbolic link is fine. **Check** shows the file it points to.

Only you can change this setting, in this window. Agents, Corvid's chat, slash commands and extensions cannot change
it. Each change goes into Corvid's log. Agents and Corvid that start after the change use the new program. Agents that
already run keep the program they started with.

If the saved file is gone later, Corvid finds Claude Code itself and the row says so.

The update check fetches from the public repository and does nothing else. It never pulls, merges or installs. When
there are new changes, a banner offers **Create update task**. The check runs only for an install made with
`npm run setup`.

Click **Rescan** when sessions are missing from Corvid.

## Extension settings

Extensions that have settings add their own sections after the cards, each under the extension's name.

## Rare and destructive

This card comes last and is marked in red. Both actions ask you to confirm first.

| Setting | What it does |
|---|---|
| **Restore from backup** | Puts back an earlier version of one of Corvid's files, like `config.json`. Choose the file and the backup, then click **Restore…**. |
| **Main chat** | **Clear main chat…** removes every message on the board, in every channel. |

Corvid keeps the last 10 versions of its settings, tasks, projects, agents, notes, board and extensions, plus one a
day for a week. Backups never hold secrets.

CAUTION: a restore restarts Corvid, which stops every running agent. A dialog asks first, with **Restore and restart**
and **Cancel**. Corvid backs up the current version first, so you can undo a restore the same way.

WARNING: **Clear main chat…** removes every message in every channel, for you, Corvid and every agent. A line asks
you to confirm with **Clear** or **Cancel**. Notes saved from messages stay.
