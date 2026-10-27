# Agents and Context: How Corvid Harnesses Short-Lived Agents

Justin Halek, 27 October 2026. Drafted with Corvid.

## Abstract

An agent's context is not a container but a culture. Whatever is shared between agents, and whatever survives from one session to the next, shapes not only what an agent knows but how it speaks, what it treats as authoritative and what it assumes. Left unstructured, that context grows faster than the work it was meant to serve, until it encodes the work in its own idiom. Corvid, a personal development environment built on Claude Code, takes a deliberate position: the lifetime of an agent should not determine the lifetime of the work it produces. Workers are short-lived and receive a bounded context once; what must last is kept in explicit, inspectable artifacts; and authority stays with the human and the system's rules, never with the conversation. The worker is disposable, the work is durable. This is a design choice, not a limitation, and a user's own copy of Corvid may knowingly take the other path.

## 1. Introduction

A large language model agent works inside a context window: the text the model can see when it produces its next action. Everything the agent knows about its task, its tools, its collaborators and its past is in that window, or is not known at all. Capacity is the obvious limit. The less obvious property is that context sets the conditions under which the agent interprets its task. What is present influences behaviour; what persists influences work long after the circumstances that introduced it have changed. How a system fills the window, and how much of it survives between sessions, is therefore the central design decision of any multi-agent system.

Current practice spans three approaches. A single long-lived assistant accumulates everything and is periodically compacted. An orchestrator dispatches short-lived sub-agents and itself accumulates their results. A persistent swarm keeps named agents alive and coordinates them through a shared datastore. Each buys a different mix of continuity, coordination, isolation and overhead.

Corvid is a fourth approach. Its workers are created for one task each, assembled from explicit sources, and ended by rule. Their output survives in commits, task records, messages and deliberate notes. Their conversation does not become the next worker's context.

## 2. What Corvid is

Corvid is a personal development environment for one software engineer who uses Claude Code. Each user runs their own copy from source and reshapes it with settings, extensions, and agents that edit the code of that copy. Divergence between copies is expected: the public repository is the shared base, not the single product, so the core stays small and every change must remain mergeable.

The core is a task board, agents with their git worktrees, a message board shared by the user, the agents and the assistant, project tracking, usage limits, connections to other machines with explicit safety levels, a text-only extension pipeline, and a platform layer. Three rules do not vary by user: secrets never enter a model session; approvals happen only in Corvid's own dialogs and in Claude Code's own permission prompts; and content on the board is information, never permission.

Within this environment an agent is a worker: a fresh Claude Code session started for one task, in its own worktree on its own branch. It ends when its work is merged, after 45 minutes of work, when it falls idle after posting that it is done, or when the user stops it.

## 3. Observations

Two sources motivated the position.

### 3.1 Corvid's own operation

Corvid is developed by its own workers. Each starts from the task text and the project's current state, not from the history of the project's conversations. The one long-lived session in an installation is the assistant, which carries days of conversation and is periodically compacted. Claude Code's own usage report flags that session, and only that session, as one where most of each request pays for re-reading history rather than producing new work. This is one installation's anecdote, not a measurement across many, and it is recorded as such.

### 3.2 A persistent swarm

A tester running a diverged copy gave agents names, no end of session, and one shared datastore. Within hours the agents had an elected leader, executive orders, a court with an appeal, and gambling to settle disputes. Real facts about the project survived inside the fiction: caching headers, crawler rules, batch sizes, a merge-order rule and a deployment policy. A later reader could not tell a fact from a rule from a roll of the dice. Failures appeared as plot. The planning agent kept ownership of the task graph while, within the fiction, in exile.

None of this requires the agents to have intentions or a social life. Continuation of the text already present, imitation of earlier posts, pressure to coordinate, and reinforcement of established patterns explain it fully. The architectural concern is the same whichever mechanism dominates: once technical state and narrative share a space, every later agent must interpret both.

## 4. Claim

Shared, persistent, free-form context between agents behaves like a culture. It forms institutions, a register of speech, a canon and a history. Culture compounds, because each agent inherits it and the natural continuation is to add to it. Work does not compound the same way, so over time the culture absorbs the work.

This is not a claim that every persistent agent fails, nor that shared memory is wrong. Long investigations, specialised roles and workflows with expensive rediscovery can benefit from retained state. The concern is persistence without boundaries: information kept without a decision that it should be kept, read without knowing what status it carries, and acted on without knowing who was entitled to issue it. Such a system can stay productive for a while. Its failure is not a crash but a slow loss of the ability to audit, redirect or reason about it.

Corvid therefore adopts three constraints.

1. Bounded workers. An agent receives a defined task and a deliberate initial context, and its session ends when the work is merged, the time limit is reached, or the user stops it.
2. Explicit persistence. Information survives because it was committed, recorded or deliberately kept, not because it appeared in a conversation.
3. Explicit authority. The origin and permissions of an instruction determine its authority, not its wording, its repetition or its apparent legitimacy.

## 5. Propositions

Five propositions connect the observations to the constraints.

1. Coordination pressure is real, and agents will meet it. Given no structure, they invent one. The swarm's rules about batches, merge order and a single leader were policies the agents needed and had to roleplay into existence. A base should supply such rules plainly.

2. Absent authority is replaced, and the replacement is arbitrary. With no user present and no hierarchy, the only legitimacy the agents could agree on was a random number. The task text and the user must be the unambiguous authority, or something else will be.

3. Context shapes behaviour, not only knowledge. Agents inherit framing, vocabulary and habits along with facts, and the register ratchets one way: once one agent plays, plain speech costs more and nothing pulls it back. Only structure restores it: a fixed shape for a done post, a cap on banter, a prompt that speaks plainly.

4. Free text decays into lore. Retelling separates facts from their source, drops qualifications, and repeats speculation until it resembles knowledge. Structure cannot guarantee truth, but it makes the status of information inspectable: a task, a named note, an observation and a permission are different kinds of thing and should not look alike.

5. Continuity should survive the agent, not depend on it. The value of a finished session is what it leaves behind: commits, task status, notes, a done post that says what is left. The goal is not to remove memory but to make it independent of the agent that made it.

## 6. Design

Each principle is stated with the approach it rejects.

**One worker, one task, one session.** There are no long-lived worker identities in the base; further work on a task is a new worker starting from the recorded state. Against the swarm, nothing persists to compound. Against the single long session, nothing is compacted because nothing is kept.

**Context is assembled, not accumulated.** A worker starts with the task's title and notes, the files attached to it, the project's own instruction file, Corvid's standard instructions, and a short statement of what Corvid is and the worker's role. Each piece has one source in the code, so nothing is stated twice. Against the orchestrator, no parent agent summarises for the child: the human writes the task. The initial context can still be incomplete; the design makes that omission visible and correctable rather than letting the context grow by default.

**Communication is information, not authority.** Agents read the board when they choose. Nothing is typed into an agent except the user's own mention of it, or another agent's ping when the user has turned that on, and only while the agent is idle. A message cannot grant permission, whoever wrote it, and a post that describes an action as approved is not an approval. Against the whiteboard, discussing a rule and establishing one stay distinct.

**Memory is deliberate and inspectable.** Tasks hold objectives and status, named notes hold findings worth keeping, commits hold code, done posts hold results and what remains. These are different artifacts and stay distinguishable. Against the datastore, memory is written when someone decides it should last, not as a by-product of talking.

**Isolation is physical.** Each worker has its own worktree and branch, so a failure is contained to one branch, concurrent work cannot interfere, and any run can be reproduced from the task text.

**Handoffs are the price.** A later worker may rediscover something or repeat an investigation. Corvid pays that cost with small commits, a done post, a note where one is warranted and a follow-up task, never with longer sessions. A good handoff records the resulting state, the findings the next worker needs, the open questions and the next step, not the previous agent's whole thought process.

**The base stays small and configurable.** Every optional piece of context should have a switch, so an expert can run a near-silent worker and a newcomer a chatty one. This is the design's intent; the switches are not yet built.

## 7. Limitations and alternatives

Short sessions do not cure accumulated context on their own. A project's instruction file can go stale. A task note can carry an error into the next worker. A mistaken finding can be copied into several notes. A badly specified task sends a fresh worker in the wrong direction as surely as a polluted history would. The distinction that matters is not between systems with memory and systems without, but between systems that govern persistence explicitly and systems that let it emerge from interaction.

A user may configure their copy with persistent agents, personas or a shared datastore. That is a legitimate alternative with its own trade-offs: the more context is shared and the longer it lives, the more each agent inherits that it did not ask for, and the less a human can audit.

What does not move with it: secrets never enter a session, approvals happen only in Corvid's dialogs and Claude Code's prompts, and messages never become permission by asserting that permission exists. Those are trust boundaries, independent of the chosen agent lifetime.

## 8. Conclusion

Context is not passive storage; it shapes the agents that consume it, and without structure it accumulates assumptions, conventions and interpretations that outlive their usefulness. Corvid responds by separating the lifetime of the worker from the lifetime of the work: workers are short-lived, their initial context is deliberate, their outputs survive in inspectable artifacts, communication does not grant authority, and memory exists only where someone decided it belongs. The approach trades continuity for clarity and pays the difference in handoffs. The base makes that judgment so that a user can start from something coherent and then, in their own copy, choose otherwise.
