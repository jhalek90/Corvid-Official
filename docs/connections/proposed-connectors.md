---
title: Connectors proposed by agents
summary: How an agent can suggest a new connector, and how you review it.
section: connections
order: 8
---

# Connectors proposed by agents

An agent that needs a service with no connector can propose one. A proposal is a draft. It does nothing until you
approve it. Agents can never create a connection, enter a secret, pick a safety level, link a project or approve
anything.

## What an agent can propose

A proposal is data only: a connector definition that one of Corvid's built-in runtimes runs. Agents cannot propose
code. Corvid enforces these rules itself:

- The runtime is HTTP, PostgreSQL, MySQL or SQL Server. Only you can add SSH and SQLite connectors.
- Every target is a fixed public host name. Corvid refuses wildcards, Internet Protocol (IP) addresses, `localhost` and local names.
- HTTP drafts use `https` on port 443 or 8443. Database drafts use the database's standard port.
- Every HTTP operation names one method and a specific path. A draft cannot allow any path.
- A draft cannot change the host, loosen the address rules, skip certificate checks or keep cookies.
- Limits are capped: at most 30 seconds a call, 5 megabytes (MB) a response and 120 calls a minute.
- A draft is at most 16 kilobytes (KB). An agent can make at most 5 proposals an hour. A project can have at most 20 open drafts.

The HTTP runtime still checks every address on every call. A public name that points at a private address is refused
there.

## Review a proposal

When a proposal arrives, you get a desktop notification and a notice on the board. The **Proposals** tab shows a
count.

1. Open the Connections tab and click **Proposals**. Each card shows who proposed it (agent, task and project), why,
   and where the agent says the hosts came from.
2. Check the hosts under **Reaches**. A host that no approved connector reaches yet is marked as new.
3. Read the summary, the operations by class, the secret labels and the test result. Click **View manifest** to read
   the full definition. For a new version, the changes against the approved one are shown.
4. Click **Review and approve…** to approve, or **Decline…** to refuse. A decline can include a reason, which the
   agent can read.
5. In the approval dialog, pick **For** *project* **only (recommended)** or **For all projects**, and confirm.

WARNING: check every host before you approve. The agent says where the hosts came from, but Corvid cannot confirm
that. A wrong host can send your data, and later your credential, to someone else.

An approved draft is a connector like any other. It still needs a connection, set up by you, before agents can use
it. A connector approved for one project can only be linked to that project. **Make available to all projects** on
the connector's card lifts that.

## Tests

An agent can test an HTTP draft against a mock server that Corvid starts on your computer for that test. The test
never reaches the real host and never uses a secret. A draft whose tests did not pass shows **Tests not passed**.

## Expiry

A draft that nobody touches for 14 days expires. **Keep longer** gives it 14 more days. **Delete** removes it.

## Requests for a connection

An agent can also ask you to set up a connection for a connector that exists. The request shows under
**Connections agents asked for** on the **Proposals** tab, with **Set it up…**, **Mark done** and **Dismiss**. An agent
can make at most 5 such requests an hour.

## Turn proposals off

Turn off **Agents can propose connectors** in **Settings** → **Connections and safety**. The change applies to agents
started after it. Agents that already run get a refusal.

The kill switch also refuses proposals and tests while it is on.
