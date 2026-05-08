<!-- SPDX-License-Identifier: Apache-2.0 -->

# Loomwiki release checklist

> Pre-tag checklist for the operator. Mirrors `SPEC.md` §18 (whole-
> product Definition of Done) plus the M8 release-readiness
> additions. Run top-to-bottom against the dogfood deploy before
> tagging a release.

## PR / merge state

- [ ] All M0–M8 PRs merged to `main` (#12, #13, #14, #18, #19, #20,
      #21, #22, #23, #24).
- [ ] No open `security-gap`-tagged issues without a tracking row in
      `docs/SECURITY.md` §11.
- [ ] No `❓ Q-NN` open questions in `SPEC.md` §20 marked
      *Blocking for v0.0.1* without an answer.
- [ ] CI green on `main` for the head commit (lint + typecheck +
      unit + integration).

## SPEC §18 whole-product DoD (run against the dogfood deploy)

- [ ] **§18 #1** — A new user can sign in via Access email OTP and
      reach the workspace home.
- [ ] **§18 #2** — A user can create a room, send a message, and a
      second user in another tab sees it within 200 ms.
- [ ] **§18 #3** — The next morning, the previous day's chat
      appears as `/rooms/{slug}/log/{date}.md` in the Artifacts
      repo (or as the M5 cron output visible in
      `wrangler tail | grep archive_run_complete`).
- [ ] **§18 #4** — A user can create a wiki page via the editor;
      `git clone`-ing the Artifacts repo shows the page.
      *v0.0.1 caveat*: with the M4 KV backend, the cloned repo is
      empty — the UI shows the page but git does not. Mark
      *partial* in the dogfood deploy until M4.5 lands. Document
      the caveat in the release announcement.
- [ ] **§18 #5** — Search bar returns relevant pages for a 3-word
      query in < 500 ms.
- [ ] **§18 #6** — `/ask "what did we decide about X"` in a chat
      room returns a cited answer in < 5 s.
- [ ] **§18 #7** — Manually triggering ingest on a discussion room
      produces ≥ 1 proposal that, when merged, appears as a wiki
      page.
- [ ] **§18 #8** — Sentry shows zero unhandled errors during the
      smoke checklist (`pnpm smoke:live` clean).
- [ ] **§18 #9** — AI Gateway dashboard shows < $0.50 spend across
      the smoke run.
- [ ] **§18 #10** — Total monthly Cloudflare bill for the dogfood
      deploy is < $10 with the dogfood team active.

## CI / local verification

- [ ] `pnpm test` clean (every package, every test file).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` clean (biome).
- [ ] `pnpm smoke:live` clean against the dogfood deploy
      (idempotent — re-running on a workspace with the smoke room
      already present short-circuits each step).
- [ ] Post-deploy verifier green on the most recent push to `main`
      (GitHub Actions, `post-deploy.yml` or equivalent).

## M8 release-readiness additions

- [ ] **Sentry** shows 0 unhandled errors during the smoke run.
      `SENTRY_DSN` is set as a Worker secret; a deliberate
      synthetic exception (e.g. `curl /api/_debug/throw` if the
      route exists, or any 500 path) verifies the wire is up.
- [ ] **Audit log** shows expected entries during the smoke run.
      Run `wrangler d1 execute loomwiki --remote --command "SELECT action, resource_kind, resource_id, created_at FROM audit_log ORDER BY created_at DESC LIMIT 20"`
      and confirm the smoke-run actions are present:
      `manual_ingest.trigger`, `proposal.merge` (and any
      `byok.create` / `byok.delete` / `agentsmd.update` /
      `workspace_settings.update` exercised by the run).
- [ ] **`BYOK_ENCRYPTION_KEY` rotation runbook** is documented in
      `DEPLOY.md` and current. The runbook walks through:
      generate new key → read all `byok_keys` rows → decrypt with
      old, re-encrypt with new, UPDATE → `wrangler secret put`.
- [ ] **Threat model is current** — `docs/SECURITY.md` §14 has a
      changelog row dated to this release with the version tag.
      §11 has rows marked closed for any gap shipped in this
      release. §12 reporting addresses are current and reachable
      (test-email confirms `security@cortech.online` arrives).
- [ ] **README screenshots are current** — or, if the deploy is
      private, the README explicitly notes that screenshots will
      be added once a public demo deploy is available. (Do not
      add screenshots from the live deploy without sign-off.)

## Documentation

- [ ] `docs/RELEASE.md` is updated for this version: "What's in"
      bullets accurate, "Known limitations" rows reflect actual
      shipped state, "Roadmap" rows match what's planned.
- [ ] `RELEASE-CHECKLIST.md` (this file) reflects any new DoD
      additions for the next release.
- [ ] All ADRs referenced in this release exist in `docs/ADR/` and
      none have been silently edited (the "Do not touch" rule from
      `CLAUDE.md`). New decisions get new ADR files; old ones get
      Status updates only.
- [ ] `DEPLOY.md` sections for every M0–M8 surface are present and
      accurate against the current `wrangler.jsonc`.
- [ ] `apps/web/README.md` reflects the current Astro / React /
      Tailwind versions and the M8 settings conventions.

## Operator-facing

- [ ] The `Status:` line in `README.md` matches the released
      version.
- [ ] `LICENSE` is Apache-2.0 (verify file present, not just
      claimed).
- [ ] `vault-template/` is unchanged unless this release explicitly
      bumps the seed (changing it changes the default for every
      self-hoster — `CLAUDE.md` "Do not touch").
- [ ] No `wrangler.jsonc` `migrations` array entries have been
      edited (append-only).
- [ ] No committed migration in `packages/schema/d1-migrations/`
      has been edited (forward-only).

## Final tag

- [ ] Tag is created on the `main` branch HEAD that passed all of
      the above (`git tag v0.0.1 && git push --tags`).
- [ ] GitHub release uses `docs/RELEASE.md`'s body.
- [ ] CHANGELOG (if maintained separately — git-cliff-style) is
      regenerated and committed before the tag.

---

When in doubt, re-run `pnpm test && pnpm typecheck && pnpm lint &&
pnpm smoke:live`. A green run on the deploy is the load-bearing
signal; the rest of this list is what makes "green run" mean what
it should.
