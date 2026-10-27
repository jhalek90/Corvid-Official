---
title: Voice input
summary: How to dictate into the message box.
section: board-and-corvid
order: 7
---

# Voice input

You can speak a message into the board's message box instead of typing it. Voice input works on Windows only.

Before you start, sign in to claude.ai in Claude Code: run `claude`, then `/login`. Voice input uses that sign-in.

## Dictate a message

1. Click in the board's message box.
2. Press Ctrl+D once, or click the microphone button next to the box. The button shows level bars while it records.
3. Speak. Your words show in the box.
4. Press Ctrl+D again, or click the button again, to stop.
5. Check the text, then press Enter to send it.

To talk only while you hold the key, hold Ctrl+D (or hold the microphone button) and let go when you finish.

Recording stops by itself after 15 seconds with no speech, or after 2 minutes in total.

## Where your voice goes

Corvid streams the microphone audio to Anthropic's speech-to-text service, signed with your claude.ai sign-in. The
Claude Code extension for Visual Studio Code does it the same way. The text comes back into the message box.

## If voice input does not work

| What you see | What to do |
|---|---|
| "Voice dictation needs a claude.ai sign-in" | Run `claude`, then `/login`, and try again. |
| "Microphone access denied" | Allow Corvid to use the microphone in your system's privacy settings. |
| "No audio detected from microphone" | Check that the right microphone is selected, and that Corvid may use it. |
| "Voice input isn't available on this platform yet" | Voice input works on Windows only. |

On macOS and Linux, the microphone button is greyed out and Ctrl+D does nothing in the message box. Corvid never
asks for the microphone there, and never reads your sign-in for voice.
