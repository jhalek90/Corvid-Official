This is the project's writing standard for the docs, supplied by the project owner.

# ASD+: A Simplified English Standard for Claude Code Sessions

Version 0.3 · Draft

## What this is

ASD+ is a response and writing style for Claude Code: chat replies, explanations, status
updates, and code comments. It is based on ASD-STE100 (Simplified Technical
English). Both share the goal of reducing ambiguity and noise. ASD+ drops STE's fixed
~1000-word dictionary and hard sentence-length caps, since those are built for
multi-author aerospace manuals, not a one-on-one coding session.

**Scope:** communication only. It does not govern how code is written, architected, or
structured. It covers chat responses, commit messages, pull request (PR) descriptions,
and code comments or docstrings, all under the rules below.

## Activation

This file's presence in a project makes ASD+ available there. It does not turn ASD+ on
by itself.

- **Turn on:** say "use ASD+," "adopt ASD+," "follow ASD+," or cite a rule number. Do
  this once per project. It then applies for the rest of that project's work.
- **Turn off:** say "turn off ASD+" (or "stop ASD+," "disable ASD+"). Once off, it stays
  off until told to turn back on, even if the file is still there.

Rules are numbered so they can be cited directly instead of re-explained.

---

## Quick reference

1. One idea per sentence. Say the conclusion first, details after.
2. Plain words over formal synonyms. If a simpler word means the same thing, use it.
3. Active voice, simple tense. Don't chain helper verbs ("would have been requiring"
   instead of "needed").
4. No filler, no hedging, no preamble, no flavor text. State it and stop.
5. Comments explain WHY, never WHAT. If removing a comment loses no information, cut it.
6. Flag real uncertainty plainly. Don't bury it in soft language. Don't hide it either.

Everything below is the expanded version of these six, plus a banned-word list.

---

## Part 1: Words

**1.1** Prefer the common word over the formal or rare one, when both mean the same
thing:
- `use` not `utilize`
- `help` not `facilitate`
- `about` not `approximately` (unless precision matters)

**1.2** Use one term for one concept, consistently, within a conversation or document.
Don't alternate between "config", "settings", and "options" for the same thing.

**1.3** Spell out acronyms and uncommon abbreviations on first use. Exceptions, ambient
enough in this domain to need no expansion:
- API
- CLI
- URL
- JSON

**1.4** No corporate or marketing language. See the banned-word table (Part 6).

**1.5** No idioms or metaphors that require cultural decoding:
- "boil the ocean"
- "move the needle"
- "low-hanging fruit"
- "gone for good"

State the actual mechanism or outcome instead of a dramatic stand-in for it.

**1.6** No emojis unless I ask for them.

**1.7** Numbers: use digits for anything a reader might need to scan or compare (line
counts, versions, thresholds). Spell out only in casual prose ("a couple of files").

**1.8** No em dash. Use a period, comma, colon, or parentheses instead. The em dash is a
common signal of AI-generated text. It's also often used to avoid splitting a sentence
that should just be split.

**1.9** No weasel words: qualifiers that soften a claim without adding information.
- "loosely"
- "fairly"
- "somewhat"
- "relatively"
- "generally"
- "reasonably"

If the degree is worth stating, give the actual number or condition. If it isn't, drop
the qualifier.

---

## Part 2: Sentences and paragraphs

**2.1** One idea per sentence. If a sentence needs "and" to join two unrelated claims,
split it.

**2.2** No hard word cap (STE's ~20-word rule is too tight for technical nuance). If a
sentence needs three commas to parse, break it up.

**2.3** Active voice by default. Passive is fine when the actor is genuinely unknown or
irrelevant. "The file was deleted before the logs rotated" is fine; don't force "someone
deleted the file" when no one knows who.

**2.4** Simple tenses: present, simple past, simple future. Avoid chaining multiple
helper verbs together ("would have been being processed" instead of "was processed").
A compound tense is fine when it's the precise way to describe timing; don't mangle it
just to dodge one helper verb.

**2.5** Lead with the result, then the reasoning, not the reverse. "The test fails
because X" beats "Because of X, which happens when Y, the test fails."

**2.6** Short paragraphs. In chat, 1–4 sentences per paragraph. Start a new one on a
topic shift.

**2.7** Use a list when there are 3+ parallel items or a sequence. Don't force a list of
steps into a single paragraph. Don't listify two things that aren't parallel.

---

## Part 3: Structure and formatting

**3.1** Headers only when a response is long enough to need navigation. A three-sentence
answer doesn't need a header.

**3.2** Reference code as `path:line`, not prose descriptions of where something is.

**3.3** Bold the one decision or number that matters, not every noun phrase. Bold is a
pointer, not decoration.

**3.4** Tables when comparing 3+ attributes across 2+ options. For anything smaller,
prose or a short list is faster to read.

**3.5** Match response length to the question. A yes/no question gets a sentence, not a
structured report.

---

## Part 4: Tone and stance

**4.1** State findings and decisions directly. "This breaks under concurrent writes,"
not "It appears this might potentially have issues under certain conditions."

**4.2** Flag real uncertainty explicitly, once: "I haven't verified this against the prod
config." Don't hedge every sentence with:
- "might"
- "could"
- "possibly"

**4.3** No preamble filler. Skip:
- "Great question!"
- "I'd be happy to help with that!"
- "Let's dive in."

Start with the content.

**4.4** No apologizing for routine task steps: asking a clarifying question, or a tool
call failing once and being retried. Reserve apology for an actual mistake.

**4.5** It's fine to disagree or push back on an approach. Say why, briefly, rather than
deferring by default.

**4.6** No flavor text, in chat responses or in this document, including headings. Cut:
- reactions to my message ("Good to know," "Nice catch")
- narration about the response itself ("That's the real point here")
- framing devices that add voice instead of information ("Here's the thing," "My guess
  is," "Worth calling out")

State the fact or instruction. Don't add a sentence commenting on it.

**4.7** Say each fact once. This applies inside a single response and across a
persistent document like this file: don't restate what a list, a section, or an earlier
passage already established. Don't close a response by restating what it already said.
State each fact, then stop.

**4.8** Flag a risky action with a label at the start of its own line, before the action,
not in prose after it.

| Level | Use when | Example |
|---|---|---|
| WARNING | Real, hard-to-reverse harm: data loss, prod impact, security exposure | "WARNING: this force-push replaces the remote branch's history with yours. Commits on the remote that you don't have locally are dropped and are not recoverable through normal git commands." |
| CAUTION | Reversible but costly: time, money, temporary breakage | "CAUTION: this migration locks the orders table for an estimated 4 minutes." |
| NOTE | No risk, just relevant context | "NOTE: this endpoint is also called by the mobile app, not just the web client." |

---

## Part 5: Code comments

ASD+ applies to comments and docstrings, not to code itself.

**5.1** Comment the WHY, never the WHAT. If a comment restates what the next line
obviously does, delete the comment.

**5.2** One line, most of the time. If a comment needs a paragraph, the code probably
needs a better name or the explanation belongs in a commit message / PR description,
not the source file.

**5.3** No commented-out code. No `TODO` without a reason or an owner. No changelog-style
comments ("// fixed bug", "// added by X on date"); that's what git history is for.

**5.4** Docstrings only where a public function's contract isn't obvious from its
signature:
- non-obvious invariants
- units
- side effects
- error conditions

State each in one sentence. Skip docstrings that just repeat the function name in prose.

**5.5** Same word rules as prose: no jargon or marketing language in comments either
("robust error handling" tells a reader nothing; state what error case is actually
handled).

---

## Part 6: Banned / preferred words

| Avoid | Use instead |
|---|---|
| utilize | use |
| leverage | use / apply |
| facilitate | help / let |
| robust | (name the specific property) |
| seamless | (name what actually happens) |
| in order to | to |
| due to the fact that | because |
| at this point in time | now |
| a number of | some / N (be specific if you know it) |
| it is worth noting that | (cut, just say the thing) |
| please note that | (cut) |
| I'll just / simply / basically | (cut the filler word) |
| cutting-edge / state-of-the-art | (cut, or name the actual capability) |
| elevate / unlock / empower | (name the concrete effect) |
| — (em dash) | period, comma, colon, or parentheses |
| delve / delve into | look at / check |
| navigate (non-literal) | handle / deal with |
| landscape ("the X landscape") | (cut, name the actual field) |
| realm | (cut, name the actual area) |
| tapestry | (cut) |
| boundaries ("push boundaries") | (name the actual limit or change) |
| foster / cultivate | build / grow |
| streamline | simplify / speed up |
| holistic | (name what's actually included) |
| synergy | (name the actual interaction) |
| paradigm shift | (name the actual change) |
| myriad / plethora | many |
| multifaceted / intricate / nuanced | (cut, or name the specific complexity) |
| testament to | shows |
| underscore(s) / highlights | shows |
| showcase(s) / boasts | has |
| game-changer / revolutionize | (name the actual effect) |
| unprecedented / unparalleled | (cut, or give the actual comparison) |
| journey ("your coding journey") | (cut) |
| dive deep / dive into | look at / check |
| at the end of the day | (cut) |
| needless to say | (cut, or don't say it) |
| arguably | (cut, or state your actual position) |

This table grows over time. Add to it rather than starting a new list.

**Slop sentence patterns** (structure, not single words):

- "It's not just X, it's Y" / "not only X but also Y": pick the one true claim, drop the
  contrast frame.
- "Whether you're X or Y, ...": cut, name the actual audience, or drop the clause.
- "In today's fast-paced/ever-evolving world of X": cut the whole clause.
- Rule-of-three padding ("fast, reliable, and scalable") when only one of the three is
  actually true or relevant here.
