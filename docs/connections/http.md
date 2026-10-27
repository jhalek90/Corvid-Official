---
title: HTTP API connections
summary: How to set up a connection to a web API.
section: connections
order: 5
---

# HTTP API connections

An HTTP API connection lets agents call a web API. Corvid adds the credential to each request. The agent gives only
the method, the path and the body, and never sees the credential.

## Add an HTTP API connection

Before you start, have the API's base URL and, if it needs one, its key, token or client secret.

1. Open the Connections tab and click **Add connection**.
2. Click **HTTP API**. You see the **Settings** step.
3. Type a **Name** and the **Base URL**, like `https://api.example.com/v1`. Agents give only the path after it.
4. Under **Sign in with**, pick how Corvid adds the credential. The form then shows only the fields that method uses.
5. Click **Next** and type the secret under **Secrets**.
6. Click **Next**, pick a safety level and the linked projects.
7. Click **Next**, read the summary, and click **Add connection**.

Click **Test** on the card to check it. The expanded card has the same check as **Test connection**. The test sends one `GET` to the **Test connection path**
(default `/`) and shows whether it worked.

## Sign in with

| Choice | What Corvid adds |
|---|---|
| **No credentials** | Nothing. For a public API. A new connection starts on this choice. |
| **Bearer token** | An `Authorization: Bearer` header with the **Bearer token** secret. |
| **Basic (user name and password)** | An `Authorization: Basic` header with the user name and the **Password** secret. |
| **API key in a header** | The **API key** secret in the header you name (default `X-API-Key`). |
| **API key in the URL query** | The **API key** secret as the query parameter you name (default `api_key`). |
| **OAuth2 (client credentials)** | An access token that Corvid gets from the token URL with the **OAuth2 client secret**. |

You can combine the header and query choices. Bearer, Basic and OAuth2 each set the `Authorization` header, so
picking one replaces the other.

Under **No credentials**, you can paste a key in the box that starts with **Have a key or token?** Corvid checks its shape, suggests
a method, and saves the key in that method's secret. It does not show the key again.

For OAuth2, Corvid keeps the access token in memory only. It gets a new one 30 seconds before the old one expires.

## Other settings

- **Allowed methods** and **Allowed paths** limit what agents can send. A path pattern uses `*` for one segment and
  `**` for any number. The defaults allow all seven methods and `/**`.
- **Administrative paths** always ask, at every safety level. The default is `/admin, /billing`.
- **Extra hosts for redirects** are hosts a redirect may go to. Corvid never sends the credential to them.
- **Local or internal service** allows private and loopback addresses and plain `http://`. It is off by default.
- **Skip certificate checks** turns off TLS (Transport Layer Security) certificate checks. It is off by default.
- **Keep cookies between calls** keeps cookies in memory for the base address only. It is off by default.

WARNING: **Skip certificate checks** lets anyone between Corvid and the server read the credential. Turn it on only
for your own internal service with a self-signed certificate.

## Classes

- `GET`, `HEAD` and `OPTIONS` are reads.
- `POST`, `PUT`, `PATCH` and `DELETE` are writes.
- Any request under an administrative path is admin.

The [safety level](safety-levels.md) decides which of these ask.

## What Corvid enforces

- **Host.** Every request goes to the base URL's host and port. Corvid refuses a full URL, another host, another
  port or a path that climbs out of the base path, before anything is sent.
- **Redirects.** Corvid follows up to 5 redirects, only to the same host or to an extra host. A redirect to plain
  `http` from `https`, into an administrative path or out of the allowed paths is not followed.
- **Addresses.** Every address the host resolves to must be public, unless the connection is a local service. Cloud
  metadata addresses are refused even then.
- **Headers.** Agents cannot set `Authorization`, `Cookie`, `Host`, `Proxy-*`, `Forwarded`, `X-Forwarded-*` or the
  connection's own credential header. Corvid drops them and says so.
- **Size and rate.** Request bodies are at most 1 megabyte (MB). The built-in connector cuts a response at 1 MB, allows 60
  calls a minute and 4 calls at once per connection.
- **Content.** Corvid returns text and JSON. It describes other content, like images or PDF files, by type and size,
  and does not download it.

## Send a request

**Send a request** on an HTTP connection's card opens a panel where you try the connection and read the full
response. Only you see the response. It does not reach an agent or the board, and Corvid does not write it to disk.
Closing the panel discards it.

1. Expand the HTTP connection's card and click **Send a request**.
2. Pick a method, type a path, and add query parameters, headers and a body if you need them.
3. Click **Send**. You see the status, the time, the size, the headers and the body.

For a write (`POST`, `PUT`, `PATCH` or `DELETE`), Corvid first asks, for example **Send this POST?** The dialog shows
the exact request with the credential's place marked. Click **Send** to send it. For an administrative path, click
**Continue**, and a second dialog asks **Really send to an administrative path?** Click **Send** there.

Reads run at once, at every safety level, because you are the owner.

The panel uses the same runtime and rules as an agent's call. The kill switch, a switched-off connector and an
unapproved connector block it. For a connector that needs approval, the panel offers the same approval dialog as
first use.

The body shows as **Formatted** (a JSON tree) or **Raw**, with a search box and **Copy**. **Save to a note** saves
the response as a note. Corvid masks secrets in it again, caps it at 100 kilobytes (KB), and refuses it if a saved secret is
still in it.

CAUTION: a write sent from this panel changes data on the real API with your credential.

Each request goes into the audit log as `user (send request)`. Database and SSH connections have no such panel.
