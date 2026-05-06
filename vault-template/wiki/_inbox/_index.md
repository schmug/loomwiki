---
title: Inbox
kind: open-question
created: 2026-05-04
last_updated: 2026-05-04
status: published
---

# Inbox

Daily digest pages for the Loomwiki ingest agent (M7+) live alongside
this README at `/wiki/_inbox/{YYYY-MM-DD}.md`. The most recent digest
links from the workspace's Inbox tab in the UI.

## What lives here

- One markdown file per UTC day the agent ran.
- Pending-proposal lists grouped by chat room.
- Run statistics for the day (count, errors, p50 duration).

## Editing

Operators may edit this README without breaking anything — it's not
read by any automated path. The daily digest pages, however, are
overwritten each time the cron runs (or the admin manual-trigger
fires); editing them by hand is pointless because the next render
will replace your changes.

To keep notes against a specific day's runs, link to or copy the
relevant digest into a regular wiki page under
`/wiki/decisions/` or `/wiki/glossary/`.

## How proposals reach the wiki

1. Chat happens in a room.
2. The ingest agent runs (manually via the room UI or daily at
   03:00 UTC) and produces 0..N proposals — these stay in the
   workspace inbox until an admin reviews them.
3. An admin clicks **Merge** on a proposal; the proposed page is
   committed to the wiki via the same write path as a hand-edited
   page.
4. The next digest reflects the new pending state.

See `/AGENTS.md` for the contract the agent reads on every run.
