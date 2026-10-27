---
title: Database connections
summary: How to set up a connection to a database.
section: connections
order: 6
---

# Database connections

A database connection lets agents run SQL (Structured Query Language) on a database. Corvid signs in with the
password only it holds, runs the statement and returns the rows. The agent never gets the password or a connection
string.

Corvid has four database connectors: **PostgreSQL**, **MySQL / MariaDB**, **SQL Server** and **SQLite file**.

## Give agents their own database user

Make a database user for agents, with the fewest rights that work. Read-only is best where you can. The connection
form shows an example for your database, with a **Copy example** button. Change the names and the password before
you run it.

This is the PostgreSQL example:

```sql
CREATE ROLE corvid_agent LOGIN PASSWORD 'choose-a-long-random-password';
GRANT CONNECT ON DATABASE mydb TO corvid_agent;
GRANT USAGE ON SCHEMA public TO corvid_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO corvid_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO corvid_agent;
ALTER ROLE corvid_agent SET default_transaction_read_only = on;
```

SQLite has no users. If agents should only read, point the connection at a copy of the file.

WARNING: the database user's rights are the real limit. Corvid's checks are a second layer. On SQL Server they are
the only guard for reads, because SQL Server has no read-only transaction.

## Add a database connection

1. Open the Connections tab and click **Add connection**.
2. Click the database connector. You see the **Settings** step.
3. Type a **Name**. Fill in **Host**, **Port**, **Database** and **User name**. For SQLite, fill in the
   **Database file** instead. The file must already exist. Corvid never creates one.
4. Pick the Transport Layer Security (TLS) setting under **TLS**, then **Agents may** and the other settings below.
5. Click **Next**. Type the **Database password**. If your server uses a private certificate authority, paste its
   certificate too.
6. Click **Next**, pick a safety level and the linked projects.
7. Click **Next**, read the summary, and click **Add connection**.

Click **Test** on the card to check it. The expanded card has the same check as **Test connection**. The test signs in and runs `SELECT 1` in a read-only transaction.

## Settings

- **TLS**: **Automatic: verify for remote hosts, off for localhost** is the default.
  The other choices are **Verify: encrypted, certificate checked**, **No verify: encrypted, certificate not checked**
  and **Off: unencrypted**.
- **Agents may**: **Read only (queries)**, **Read and write (also insert, update, delete)** (the default) or
  **Admin (also schema, users and grants; always asks)**. Corvid refuses a statement above this at every safety
  level.
- **Masked columns**: column name patterns, where `*` matches anything. Values in these columns show as `[masked]`.
  The default is `*password*, *passwd*, *secret*, *token*, *api_key*, *apikey*, *ssn*`.
- **Most rows per call**: default 500, at most 5000.
- **Statement timeout (seconds)**: default 30, at most 120.
- **Largest response (KB)**: default 1024, which is 1 megabyte (MB). At most 4096 (4 MB).
- **Calls at once**: default and most 4.

WARNING: **No verify** and **Off** on a remote host let anyone between Corvid and the database read the password.
The approval dialog warns about both.

NOTE: masking goes by column name only. `SELECT password AS x`, or a value computed from a masked column, is not
masked. Use database rights for anything that must stay hidden.

## Operations

| Operation | Class | What it does |
|---|---|---|
| `query` | Read | Runs statements that only read. |
| `describe` | Read | Lists the tables, or the columns of one table. |
| `sample_rows` | Read | Returns up to 20 rows of one table. |
| `execute` | Write | Inserts, updates, deletes and merges. It commits only if every statement succeeds. |
| `admin` | Admin | Schema, users, grants, procedures and settings. |

## How Corvid classes a statement

Corvid reads each statement itself and does not trust the operation name. A call with several statements gets the
class of the most dangerous one.

- **Read**: `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `DESCRIBE` and plain `EXPLAIN`.
- **Write**: `INSERT`, `UPDATE`, `DELETE`, `MERGE` and `REPLACE`, a read that contains one of them, and
  `SELECT ... FOR UPDATE`.
- **Admin**: schema changes, `GRANT` and `REVOKE`, transactions, `SET`, procedure calls, and any statement Corvid
  does not recognise.

Reads run in a transaction that is always rolled back. On PostgreSQL and MySQL it is a read-only transaction. SQLite
opens the file read-only.

## Refused at every level

Some statements never run, at any safety level and with any approval. They reach files, programs or other servers.
For example:

- PostgreSQL: `COPY`, `pg_read_file`, `lo_import`, `dblink`, `CREATE EXTENSION`, `ALTER SYSTEM`.
- MySQL and MariaDB: `LOAD_FILE`, `INTO OUTFILE`, `LOAD DATA`, `SET GLOBAL`, `SHUTDOWN`.
- SQL Server: `xp_cmdshell` and every `xp_` procedure, `OPENROWSET`, linked servers, `BACKUP`, `RESTORE`.
- SQLite: `ATTACH`, `load_extension`, `VACUUM INTO`.

A column with one of these names must be quoted, like `"copy"` or `[backup]`.

## Approval and audit

On **Strict**, and for writes and admin on **Approve writes**, the approval dialog shows the exact statement and its
class. The audit log keeps the statement (cut to 1000 characters, with secret-looking text masked), the class, the
row count, the duration and the decision. It never keeps result rows or the password.

Corvid cannot reach a database through an SSH tunnel yet.
