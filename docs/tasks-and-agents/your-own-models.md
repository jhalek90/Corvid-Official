---
title: Your own models
summary: How to run workers on a model server on your own computer, what has been tested, and a llama.cpp quick start.
section: tasks-and-agents
order: 9
---

# Your own models

A custom model is a model server on your own computer, such as `llama-server` from llama.cpp, that you add in
**Settings** → **Models**. A worker on it is the same Claude Code session as any other worker. Corvid points that
session at your server instead of at Anthropic, and it uses no plan usage.

With no models in **Settings** → **Models**, Corvid starts every session the same way as before.

NOTE: custom models are new. Small local models make more mistakes than Claude models, and their context is often
small. Start with small, clear tasks.

## What works

Corvid needs four things from your model server, whatever model or program it is:

- It runs on this computer, at an address on `localhost`, `127.0.0.1` or `::1`. Corvid refuses every other address.
- It speaks Anthropic's Messages API (`/v1/messages`) itself, with tool use and streaming.
- It needs no API key.
- It has a context of at least about 32,000 tokens. Claude Code's own prompt takes about 13,600 tokens, and Corvid's
  prompts come on top. The [lean profile](#the-lean-profile) keeps Corvid's part small. Corvid itself needs 64,000
  tokens or more.

### Tested

One setup has run real Corvid workers:

| Part | What was used |
|---|---|
| Server | `llama-server` from llama.cpp, build b11966, the CUDA 12.4 build for Windows |
| Model | A 27B Qwen model, as an IQ3_S GGUF file (the model file format llama.cpp reads) |
| Graphics card | NVIDIA RTX 4060 Ti with 16 GB |
| Server settings | 32k context, a quantized cache (`q8_0`), one slot, thinking off |
| Speed | About 870 tokens per second to read the prompt, about 18 tokens per second to write |

`llama-server` speaks `/v1/messages` itself, so no proxy was needed. Two settings mattered:

- The model's chat template refused a second system message. A changed template fixed it. See
  [Troubleshooting](#troubleshooting).
- Thinking was off (`--reasoning off`). With thinking on, every answer took much longer.

### Should work, not tested

These should work, because they give Corvid the same API on this computer. Nobody has tried them with Corvid yet.

- Other GGUF models that `llama-server` can run, when their chat template supports tool calls and the model uses
  tools well. Each model can need its own template fix, as Qwen did.
- Any other local server that offers Anthropic's `/v1/messages` on `localhost`.
- A translating proxy on this computer, such as LiteLLM, in front of a server that speaks another API style, such as
  OpenAI's `/v1/chat/completions`. Corvid then talks to the proxy's address.

Small models, and models with heavy quantization, get tool calls wrong more often.

### Not yet

- API keys. A model entry has no field for a key, and Corvid refuses key-like names in **Extra env**. Hosted
  providers that need a key do not work.
- Servers on another computer. Corvid refuses every address that is not `localhost`, `127.0.0.1` or `::1`, also on
  your own network.
- Your models for the extension scan, the packager, the new-project agent and `/discuss` panels. These always run on
  Claude.

## Quick start with llama.cpp

Corvid never starts, stops or restarts your server. You start it yourself, in its own window, and leave it running.

These steps are for Windows with an NVIDIA graphics card (GPU). On other systems, get `llama-server` for your
system from llama.cpp, and start it with the same options.

1. From llama.cpp's releases on GitHub, download the CUDA build for Windows and the `cudart` zip for the same CUDA
   version.
2. Unzip both into one folder. `llama-server.exe` and the CUDA files must be side by side.
3. Download a GGUF model file that fits in your GPU's memory, with room left for the context.
4. Open a command window in that folder and start the server:

   ```text
   llama-server -m <your-model>.gguf -c 32768 --port 8080 --parallel 1 --jinja --reasoning off -fa on -ctk q8_0 -ctv q8_0 --alias qwen-local
   ```

   Wait until the server says it is listening.
5. In Corvid, open **Settings** → **Models**, click **Add model**, and give it the context from `-c` (see
   [Add a model](#add-a-model)).
6. Click **Test**. The line under the form says the server answers with a context of 32,768 tokens.
7. Click **Save**, then **Set up** on the model's row, once (see [Set up Claude Code once](#set-up-claude-code-once)).
8. Pick the model for one small task and start it (see
   [Put a task or the workers on your model](#put-a-task-or-the-workers-on-your-model)).

What the options do:

- `-c` is the context size. Write the same number in the model's entry.
- `--parallel 1` gives the whole context to one session. With more slots, each session gets a part of `-c`.
- `--jinja` uses the model's own chat template. If the template fails, give a changed one with
  `--chat-template-file` (see [Troubleshooting](#troubleshooting)).
- `--reasoning off` turns thinking off. Agents answer much faster without it.
- `-fa on -ctk q8_0 -ctv q8_0` turn on flash attention and store the cache at 8 bits, so a bigger context fits in
  the GPU's memory.
- `--alias` sets the name the server reports. Without it, the server reports the path of the `.gguf` file.

Option names can change between llama.cpp builds. `llama-server --help` lists the ones your build has.

## Add a model

1. Open **Settings** → **Models** and click **Add model**. A form opens.
2. Fill in the fields. **Save** stays off, and the line next to it says why, until every field is valid.
3. Click **Test**. A line under the form says whether the server answers and with what context.
4. Click **Save**. The model shows in the list, with its address, context, sessions at once and profile.

| Field | Default | What it holds |
|---|---|---|
| **Label** | Empty | The name that pickers, cards and notices show, up to 40 characters. |
| **Id** | Made from the label | What tasks and settings store, as `custom:<id>`. Lowercase letters, digits and dashes, up to 32 characters. It cannot be `haiku`, `sonnet`, `opus`, `fable` or `default`, and it cannot change after you save. |
| **Base URL** | `http://localhost:8080` | The server's address. `http` or `https` on this computer only, with no user name or password in it. |
| **Model name** | The id | What Claude Code sends as the model. `llama-server` answers to any name. |
| **Small model** | The model name | The model Claude Code uses for quick jobs. |
| **Context (tokens)** | 32768 | The server's context size, as you started it with `-c`. From 8192 to 2,000,000. |
| **Max output tokens** | 4096 | The longest answer the model may give in one turn. |
| **Sessions at once** | 1 | How many sessions can run on this model at the same time. One GPU usually means 1. |
| **Profile** | **Automatic** | **Lean** or **Full**. **Automatic** is lean below 100,000 tokens of context. See [The lean profile](#the-lean-profile). |
| **Extra env** | Empty | Extra environment variables for its sessions, one `NAME=value` per line. |

**Extra env** takes only `API_TIMEOUT_MS`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, and names that start with
`CLAUDE_CODE_` or `DISABLE_`. Corvid refuses any name with `KEY`, `TOKEN`, `SECRET`, `PASS`, `AUTH` or `CREDENTIAL`
in it, and the names Corvid sets itself.

Each row in the list also has **Edit** and **Remove**. When a task or setting still uses the model, the row says so.
**Remove** asks you to confirm and names them. A task on a removed model does not start until you add the
model back or pick another one. Corvid never moves it to a Claude model by itself.

Only **Settings** → **Models** adds or changes your models. No agent, tool, board message or extension can.

## Set up Claude Code once

Corvid runs sessions on your models in a Claude Code configuration folder of their own, not in `~/.claude`. That
folder has no login in it. The first time, Claude Code asks its first-run questions and whether you trust the folder.
Answer them once with **Set up**:

1. Click **Set up** on the model's row. A Claude Code terminal opens on that model, in the folder above your project
   folders and their worktree folders.
2. Answer Claude Code's first-run questions.
3. Answer yes when it asks whether you trust the folder.
4. Close the terminal.

Corvid types nothing into that terminal. If your projects are on more than one drive, a message names the folders
that **Set up** does not cover. A worker in one of them can stop at the trust question, and Corvid tells you (see
[Health messages](#health-messages)).

The folder is shared by all your models:

| System | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\<data folder name>\claude-custom` |
| macOS | `~/Library/Application Support/<data folder name>-claude-custom` |
| Linux | `$XDG_STATE_HOME/<data folder name>/claude-custom` (`~/.local/state` when `XDG_STATE_HOME` is not set) |

Your own Claude Code settings, plugins, skills, global MCP servers and user `CLAUDE.md` in `~/.claude` do not reach
these sessions. The project's own `.claude/settings.json` and `CLAUDE.md` do. Your allow rules stay in `~/.claude`,
so workers on your models ask for permission more often.

## Put a task or the workers on your model

Every worker model picker has a **Your models** group under the Claude models:

- A task's **Model** in the task editor. This puts one task on your model and leaves the others on Claude.
- **Worker model** in **Settings** → **Corvid and models**. This puts every task without a model of its own on your
  model.

The agent card shows the model's label. Its tooltip says that it is one of your own models, with no plan usage.

A worker on your own model always differs from a Claude worker in these ways:

- It starts in Claude Code's default permission mode, so it asks before it edits a file. **Worker permission mode**
  does not apply to it.
- It gets no effort level. **Worker effort** does not apply to it. Thinking is set on the server.
- Every model name that Claude Code or a subagent asks for goes to your server.

## Limits

- **Sessions at once**: each model has its own limit, 1 by default. A second start is refused with "Qwen 27B (local)
  already has 1 of 1 session running, which is its limit in Settings → Models."
- **Concurrent workers** in **Settings** → **Agents and workers** still counts every worker, on any model.
- The usage limit for new agents and the Fable plan check do not apply, because your model uses no plan usage.
- The extension scan and `/discuss` panels always run on Claude, whatever the worker model is.

## The lean profile

A session needs part of the context before it reads a file. Claude Code's own prompt took about 13,600 tokens in a
test with a 32k server. Corvid's prompts and tools add a few thousand more. On a small context, that leaves little
room for work.

The lean profile makes the start smaller and keeps every safety rule. A lean worker:

- gets only the Bash, Read, Edit, Write, Glob and Grep tools from Claude Code,
- gets only Corvid's MCP server, and no MCP servers from the project's `.mcp.json`,
- gets no skills and no slash commands,
- posts in the plain board voice, whatever **Board voice** says,
- gets the short version of [What Corvid is](../getting-started/what-corvid-is.md),
- gets no agent pings, and no connector drafts,
- cannot rewrite or delete notes, or read board attachments.

A lean worker keeps everything that keeps you safe: the board and approval rules, the rules about secrets, the git
and merge rules, the rules for the Corvid project, the done post, the files agents may not read, and Claude Code's
permission prompts.

Before each start, Corvid adds up the start: Claude Code's prompt (13,600 tokens for full, about 10,000 for lean),
Corvid's prompts and tools, the project's `CLAUDE.md`, and the max output tokens. If that is more than 70% of the
context, the start is refused with a message like this:

```text
Qwen 27B (local) has a context of 16,384 tokens, and a worker on #12 needs about 14,000 just to start plus 4,096 for
its answers, more than the 70% (11,468) Corvid allows. Give the server a bigger context (-c) and the entry with it, or
pick another model for #12.
```

The lean number for Claude Code's prompt is an estimate until it is measured on a real run.

## Health messages

Before every start on your model, Corvid asks the server for its model list (`GET /v1/models`) and waits up to 3
seconds. **Test** runs the same check. It only reads. If the list does not say the context, Corvid also asks
`/props`.

| What happened | What Corvid says |
|---|---|
| The server answers | "Qwen 27B (local) is answering at http://localhost:8080 with a context of 32,768 tokens." |
| The server does not answer in time | "Qwen 27B (local) isn't answering at http://localhost:8080. Start its server, then start #12 again." |
| The server runs with a smaller context than the entry | "Qwen 27B (local)'s server at http://localhost:8080 runs with a context of 8,192 tokens, but its entry says 32,768." It then says to start the server with a bigger `-c` or to lower the entry's context. |
| The model is not in **Settings** → **Models** any more | "No agent started for #12: its model "qwen-local" isn't in Settings → Models any more." |

A refused start starts nothing. The reason shows where a failed start always shows: a notice on the board and the
error from the start.

While a worker on your model runs, Corvid also reads its terminal output. When it finds trouble, it posts one notice
on the board and shows an amber line on the agent's card, once for each kind:

| What happened | What the notice says |
|---|---|
| The conversation grew past the context | "#12's model ran out of context (32k, Qwen 27B (local)). Its work so far is on its branch. Restart it on a bigger model, or split the task." |
| The server stopped answering | "#12 lost its model: http://localhost:8080 stopped answering (Qwen 27B (local))." It then says to start the server again and restart #12. |
| The server sent another error | "#12's model sent an error (Qwen 27B (local))", with the error line. |
| Claude Code asks whether you trust the folder | It names the prompt and says to answer it in the worker's terminal in **Agents**, or to run **Set up**. |
| Claude Code asks its first-run questions | The same, for the first-run set-up. |
| Claude Code shows an update notice | It says to answer it in the worker's terminal in **Agents**. |

Corvid never moves a task from your model to a Claude model, because that would spend plan usage you did not choose.
To go on, start the server again, or pick another model for the task, and start the worker again.

## Corvid itself on your model

Corvid, the assistant, can run on your model as an experiment. Choose the model in **Model** in **Settings** →
**Corvid and models**. Only models with a context of 64,000 tokens or more can be chosen. Smaller ones show as
"(workers only: under 64k context)".

While Corvid runs on your model:

- Corvid works in **Plan & ask**, whatever the mode switch says. It proposes workers, and you approve them.
- Corvid's own session counts toward the model's **Sessions at once**. With a limit of 1, no worker starts on it.
- Corvid runs the same server check before it starts. If the check fails, Corvid shows as offline with the reason
  and a **Run Corvid on Haiku instead** button. Only your click switches the model.

A switch between a Claude model and your own model starts a new conversation with Corvid.

## Sessions and usage

Sessions on your models show in **Sessions** and **Live** like other sessions. Their cost shows as $0.00, because
they use no plan usage.

Their tokens are not counted in the plan figures on the **Usage** page. Under **All indexed time**, **Usage** shows
one line for each of your models, for example "Qwen 27B (local): 1.2M tokens this week, no plan usage". The line
shows only when the model ran in the last 7 days.

## Troubleshooting

For the notices Corvid posts itself, see [Health messages](#health-messages).

- **`llama-server.exe` does not start, or the file is 0 bytes.** The unzip went wrong. Delete the folder, then unzip
  both zips into it again and check that the `.exe` has a size.
- **Claude Code shows `System message must be at the beginning`.** The model's chat template refuses a second system
  message, which Claude Code sends. Start the server with a changed template: a copy of the model's template where a
  later system message is shown in its place instead of raising the error. Pass it with `--chat-template-file`.
  Other models can need a different fix.
- **The server does not see an environment variable.** A variable set with `setx` reaches only windows opened after
  it. Open a new command window, then start the server.
- **A worker looks stuck and the server is idle.** Claude Code waits at a prompt in its terminal: an update notice,
  its first-run questions or whether you trust the folder. Answer it in the worker's terminal in **Agents**, or run
  **Set up** once.
- **The first answer is slow.** The server reads the whole prompt first. In the tested setup, the first turn took
  about 16 seconds to read Claude Code's 13,600-token prompt. Later turns reuse the server's cache and start in 2 to 3
  seconds. After that, the writing speed sets the pace (about 18 tokens per second there). The server window shows
  both speeds for each request.
- **The model calls the wrong tool or sends broken arguments.** Try a bigger model, or a quantization with more bits.
  Give the worker a smaller, clearer task.

Every safety rule applies the same way on your own models. See [Safety and privacy](../help/safety-and-privacy.md).
