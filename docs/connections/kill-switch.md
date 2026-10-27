---
title: The kill switch
summary: How to stop every connector, or one, at once.
section: connections
order: 4
---

# The kill switch

The kill switch stops every connector at once. Agents get a refusal for every call until you turn connectors back
on. You can also switch off one connector.

## Stop every connector

1. Open the Connections tab.
2. Click **Disable all connectors** in the header. A dialog asks **Disable all connectors?**
3. Click **Disable all**. The header shows **All connectors are disabled** and a **Turn back on** button.

While the switch is on:

- every agent call is refused, `run_on` included,
- calls that waited for approval are declined,
- results of calls that are still running are held back from the agent,
- held pages of long results are dropped,
- agents cannot propose or test new connectors,
- the **Send a request** panel cannot send.

CAUTION: the kill switch does not stop a command that already started on a server. It keeps running there until it
ends or times out. An upload in progress is cut off, which can leave a partial file on the server.

## Turn connectors back on

Click **Turn back on** in the header. Agents can call connections again at once.

## Stop one connector

1. Open the Connections tab and click **Connectors**.
2. Find the connector and click **Disable**.

Every connection of that connector stops. Its cards show **disabled**. Click **Enable** to turn it back on.
