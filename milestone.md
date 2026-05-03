---
name: Milestone
about: Self-contained POC work chunk sized for one Claude Code session at xhigh
title: "M?: <short description>"
labels: ["milestone"]
assignees: []
---

<!--
  This template mirrors SPEC.md §19. Fill in every section before assigning to
  Claude Code. The "Required reading" block is what Opus 4.7 needs in turn 1
  to produce strong output without progressive clarification.
-->

## Milestone

- **ID**: M?
- **SPEC reference**: §19, milestone M?
- **Estimated**: 1 Claude Code session at xhigh effort

## Intent

<!-- One paragraph: what this milestone delivers and why it matters. -->

## Required reading (paste into Claude Code first turn)

Load all of these in turn 1. Do not drip context across turns — Opus 4.7 reasons more after each user turn, so batching is cheaper.

- `CLAUDE.md` (root)
- `SPEC.md` §4 — Architecture overview
- `SPEC.md` §5 — Cloudflare bindings (`wrangler.jsonc`)
- `SPEC.md` §6 — Repo structure
- `SPEC.md` §19 → milestone **M?** (this milestone)
- <!-- Add any other SPEC sections relevant to the work, e.g. §7 (data model), §9 (ChatRoom DO), §10 (ingest agent) -->

## Deliverables

<!-- Concrete file changes. Use checkboxes so progress is visible. -->

- [ ] 
- [ ] 
- [ ] 

## Acceptance criteria (Definition of Done)

<!-- Testable conditions. Each must be verifiable by `pnpm test`, `wrangler dev`, or a documented manual smoke step. -->

- [ ] 
- [ ] 
- [ ] 
- [ ] `pnpm test && pnpm typecheck && pnpm lint` all pass
- [ ] PR opened, linked to this issue, CI green

## Open questions touched

<!-- List any SPEC §20 questions this milestone needs resolved, OR "none". -->
<!-- If a Q is touched but you proceed with an assumption, document it in the PR description. -->

- 

## Subagent guidance

<!-- Copy from SPEC §19 milestone subsection, or "none". -->
<!-- Opus 4.7 is conservative about fan-out by default — override explicitly when fan-out helps. -->

## Out of scope

<!-- Things this milestone deliberately does NOT do. Prevents scope creep mid-session. -->

- 
- 

## Notes for Claude Code

- Effort: **xhigh** (default; do not change unless explicitly told).
- Branch: `m{N}-{short-description}`.
- Commit style: imperative (e.g., "add ChatRoom DO with hibernation").
- One logical change per commit; tests in the same commit.
- PR title mirrors this issue title; PR body references `Closes #<this-issue-number>`.
