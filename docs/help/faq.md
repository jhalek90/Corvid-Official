---
title: FAQ
summary: Short answers to common questions.
section: help
order: 4
---

# FAQ

## Is Corvid made by Anthropic?

No. Corvid is an independent personal project. Anthropic does not make it, endorse it or support it. "Claude" is
Anthropic's name.

## Do I need an API key?

No. Corvid uses your own Claude Code program and your own sign-in. Every session it starts counts against your own
Claude plan. Corvid has no API keys or accounts of its own.

## Does Corvid replace Claude Code?

No. Corvid needs Claude Code installed and signed in. It runs Claude Code for you and shows what it does. It is not
a hosted service and not a code editor.

## Which platforms does it run on?

Windows 10 and 11 every day. macOS and Linux are in beta. See [Windows](../platforms/windows.md) for the tested
status of each platform.

## Does Corvid send my data anywhere?

Only through your own Claude Code, and to Anthropic's speech service while you dictate. It has no telemetry. See
[Safety and privacy](safety-and-privacy.md).

## Can an agent see my saved passwords?

No. Corvid keeps secrets and makes calls for the agent. The agent gets only the result. See
[Safety and privacy](safety-and-privacy.md#saved-secrets).

## Why did all my agents stop?

Corvid restarted. A deploy, an update, a restore from backup and a rollback all restart Corvid. A restart ends every
agent that runs inside it. Closing the window to the tray does not stop agents, and neither does **Reload window**.

## Are the cost figures exact?

No. Cost figures are estimates.

## Why are my usage numbers wrong or missing?

Corvid reads your quota from the text of Claude Code's `/usage` command. If Claude Code changes that text, the
numbers can break until Corvid is updated.

## Does voice work on macOS or Linux?

Not yet. Voice is Windows only. It also needs a claude.ai sign-in, and Windows must allow desktop apps to use the
microphone.

## Is Corvid open source?

It is source-available, under the Functional Source License 1.1 with the Apache 2.0 future license (FSL-1.1-ALv2):

- You can use it for free for any purpose except competing with it. This includes use at work.
- You can change it, and share it and your changes for non-commercial use.
- You may not sell it, host it as a paid service or rebrand it.
- Each version becomes Apache License 2.0 two years after its release.

The [license file](../../LICENSE) is the legal text.

## Does Corvid have releases?

No. You install it from source and update through git. See [Updates](../platforms/updates.md).
