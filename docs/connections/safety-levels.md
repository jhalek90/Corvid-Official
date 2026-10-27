---
title: Safety levels
summary: The three safety levels and what each one lets an agent do.
section: connections
order: 2
---

# Safety levels

Each connection has a safety level. It decides which calls run at once and which wait for your approval. A new
connection starts on **Strict**.

## Classes of operation

Every operation has a class:

- **Read**: it only looks. For example a `GET` request, a `SELECT` statement, or a plain inspection command on a
  server.
- **Write**: it changes data. For example a `POST` request, an `UPDATE` statement, or any server command that is not
  a plain inspection command.
- **Admin**: it changes structure or access. For example a request under an administrative path, a `GRANT`
  statement, or a command run as root.

Corvid sets the class itself, from the connector's definition and the call. For databases it reads the Structured Query Language (SQL)
statement. It does not trust the operation name an agent picks.

## The three levels

| Level | Reads | Writes | Admin |
|---|---|---|---|
| **Strict** | Ask | Ask | Ask |
| **Approve writes** | Run | Ask | Ask |
| **Free** | Run | Run | Ask, unless you allow it |

- **Strict**: every operation waits for you and shows exactly what will run. Use it for anything that matters.
- **Approve writes**: reads run at once. Anything that changes data waits for you.
- **Free**: reads and changes run without asking. Use it only for test systems you can throw away.

On **Free**, a connector with admin operations shows the box **Run administrative operations without asking too**.
It is off by default.

WARNING: on **Free** an agent can change or delete data on the target without asking you. With the admin box ticked
it can also change users, grants or the schema, or run commands as root. Corvid cannot undo a change on the target.

Some limits apply at every level. A database connection's **Agents may** setting refuses statements above it. Some
statements and HTTP paths are refused or always ask. See [Database connections](database.md) and
[HTTP API connections](http.md).

## Change a connection's level

1. Open the Connections tab and expand the connection's card.
2. Under **Safety level**, click **Strict**, **Approve writes** or **Free**. A line under the buttons says what the
   level does.
3. Click **Save**.

The new level applies to the next call.

## Calls that wait

A call that needs approval opens Corvid's approval dialog. See [Approvals](approvals.md).
