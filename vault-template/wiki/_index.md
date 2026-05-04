---
title: Welcome
kind: concept
created: 2026-05-04
last_updated: 2026-05-04
status: published
---

# Welcome to your Loomwiki

Every conversation in chat that *would* have been lost in scroll lives
here instead — as a markdown page in this vault, version-controlled
through Cloudflare Artifacts, queryable via search, and clone-able at
any time with `git clone`.

## Getting started

- **Talk in chat.** Click any room in the sidebar; everything you type
  is recorded.
- **Trigger ingest** (M7) — the AI agent reads recent messages, drafts
  pages, and queues them as **proposals** for human review.
- **Review proposals** in the inbox; merging commits the page to this
  vault.
- **Edit a page directly** by clicking the pencil icon on any page. Your
  edit is committed as a separate revision.

## What's here

- `/wiki/_index.md` — this page.
- `/wiki/_open-questions.md` — running list of unresolved questions
  surfaced by ingest. Append-only.
- `/wiki/{kind}/{slug}.md` — the actual knowledge base. Page kinds are
  `entity`, `decision`, `concept`, `open-question`, `glossary`.

## Why a wiki?

Chat is fast and lossy; wiki is slow and durable. The Loomwiki bet is
that you only have to type once if the agent does the converting work
for you. Read more in `AGENTS.md`.
