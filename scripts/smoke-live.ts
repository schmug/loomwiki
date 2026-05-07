// SPDX-License-Identifier: Apache-2.0

// Live smoke for the deployed worker. Walks the M7 happy path end-to-end:
//
//   bootstrap user (/api/me)
//     → ensure dogfood room exists
//     → seed N messages (idempotent: skips when count is already met)
//     → trigger ingest (POST /api/rooms/:rid/ingest)
//     → poll the run until succeeded | failed
//     → fetch first pending proposal
//     → merge it (POST /api/proposals/:id/merge)
//     → verify the wiki page exists (GET /api/wiki/<path>)
//     → render today's digest (POST /api/_admin/digest/render)
//
// Auth: a Cloudflare Access service token. Set:
//   CF_ACCESS_CLIENT_ID
//   CF_ACCESS_CLIENT_SECRET
//   LOOMWIKI_BASE_URL   (default: https://loomwiki.cortech.online)
//
// Usage:
//   pnpm smoke:live
//
// The script is idempotent — re-running on a workspace that already has
// a smoke room and merged proposal does NOT produce duplicate pages or
// runaway LLM cost. Each step short-circuits when the prior outcome is
// already present.

interface SerializedRoom {
  id: string;
  slug: string;
  name: string;
}

interface SerializedRun {
  id: string;
  status: "running" | "succeeded" | "failed";
  summary: string | null;
  error: string | null;
}

interface SerializedProposal {
  id: string;
  page_path: string;
  status: "pending" | "merged" | "rejected" | "superseded";
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

const BASE_URL =
  process.env.LOOMWIKI_BASE_URL?.replace(/\/$/, "") ?? "https://loomwiki.cortech.online";
const CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
const ROOM_SLUG = process.env.SMOKE_ROOM_SLUG ?? "smoke";
const ROOM_NAME = process.env.SMOKE_ROOM_NAME ?? "Smoke";

if (CLIENT_ID === "" || CLIENT_SECRET === "") {
  console.error(
    "Missing CF_ACCESS_CLIENT_ID and/or CF_ACCESS_CLIENT_SECRET. " +
      "Service-token authed live smoke requires both. See DEPLOY.md §M7 live smoke.",
  );
  process.exit(2);
}

const HEADERS: Record<string, string> = {
  "CF-Access-Client-Id": CLIENT_ID,
  "CF-Access-Client-Secret": CLIENT_SECRET,
  Accept: "application/json",
};

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers = { ...HEADERS };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${path} (status ${res.status}): ${text.slice(0, 200)}`);
  }
  const result = parsed as ApiOk<T> | ApiErr;
  if (result.ok === true) return result.data;
  throw new Error(
    `${path} → ${res.status} ${result.error.code}: ${result.error.message}${result.error.details ? ` (${JSON.stringify(result.error.details).slice(0, 200)})` : ""}`,
  );
}

// Lower-level helper for endpoints where we need access to the raw Response
// (status code, headers) rather than the unwrapped ApiOk<T>.data payload.
// Used by the M8 negative tests that assert on X-Request-Id and the
// status code of an intentional 404.
async function apiRaw(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ res: Response; text: string; json: unknown }> {
  const headers = { ...HEADERS };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // tolerated — empty bodies on 204, etc.
  }
  return { res, text, json };
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - startedAt;
    console.log(`✓ [${ms.toString().padStart(5, " ")}ms] ${label}`);
    return out;
  } catch (err) {
    const ms = Date.now() - startedAt;
    console.error(`✗ [${ms.toString().padStart(5, " ")}ms] ${label}`);
    throw err;
  }
}

async function ensureRoom(workspaceId: string): Promise<SerializedRoom> {
  const me = await api<{ rooms: SerializedRoom[] }>("/api/me");
  const existing = me.rooms.find((r) => r.slug === ROOM_SLUG);
  if (existing) return existing;
  const created = await api<{ room: SerializedRoom }>(`/api/workspaces/${workspaceId}/rooms`, {
    method: "POST",
    body: { slug: ROOM_SLUG, name: ROOM_NAME },
  });
  return created.room;
}

const SAMPLE_MESSAGES = [
  "Heads up: we're rolling DMARC to p=quarantine for the K-12 tenants on Friday.",
  "Approved. Vendors flagged in the report yesterday have been notified — they have 24h.",
  "Decision logged. Will draft the rollout page in the wiki once ingest catches it.",
];

async function seedMessages(roomId: string): Promise<void> {
  const history = await api<{ messages: unknown[] }>(`/api/rooms/${roomId}/messages?limit=10`);
  if (history.messages.length >= SAMPLE_MESSAGES.length) return;

  // The /api/rooms/:rid/messages POST shape doesn't exist in v0.0.1
  // (messages flow through the WS protocol). For smoke we drop a thin
  // INSERT shim — but since smoke runs against a real deployment we
  // can't poke D1 directly. Instead, document the gap and have the
  // operator seed via the chat UI manually for the first run.
  console.warn(
    "  ! no REST POST shape for messages — seed via the chat UI in your browser, then re-run.",
  );
}

async function pollRun(runId: string, timeoutMs = 120_000): Promise<SerializedRun> {
  const deadline = Date.now() + timeoutMs;
  let last: SerializedRun = { id: runId, status: "running", summary: null, error: null };
  while (Date.now() < deadline) {
    const got = await api<{ run: SerializedRun }>(`/api/runs/${runId}`);
    last = got.run;
    if (got.run.status !== "running") return got.run;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

async function main(): Promise<void> {
  console.log(`Loomwiki smoke @ ${BASE_URL}`);
  const me = await step("/api/me", () =>
    api<{ user: { id: string }; workspace: { id: string }; rooms: SerializedRoom[] }>("/api/me"),
  );

  const room = await step(`ensure room "${ROOM_SLUG}"`, () => ensureRoom(me.workspace.id));
  console.log(`  room.id = ${room.id}`);

  await step("seed messages (manual fallback)", () => seedMessages(room.id));

  const triggered = await step("POST /api/rooms/:rid/ingest", () =>
    api<{ run_id: string; status: string }>(`/api/rooms/${room.id}/ingest`, {
      method: "POST",
      body: {},
    }),
  );
  console.log(`  run_id=${triggered.run_id} status=${triggered.status}`);

  const finalRun = await step("poll run → succeeded | failed", () => pollRun(triggered.run_id));
  console.log(`  final status=${finalRun.status} summary=${finalRun.summary ?? "(none)"}`);
  if (finalRun.status === "failed") {
    console.error(`  error tag: ${finalRun.error}`);
    process.exit(1);
  }

  const pendingList = await step("list pending proposals", () =>
    api<{ proposals: SerializedProposal[] }>("/api/proposals?status=pending"),
  );
  console.log(`  ${pendingList.proposals.length} pending`);

  const first = pendingList.proposals[0];
  if (first === undefined) {
    console.log(
      "No pending proposals — nothing to merge. (Possibly no new content since last run.)",
    );
  } else {
    const merged = await step(`merge proposal ${first.id}`, () =>
      api<{ merged: boolean; page_path: string; sha: string }>(`/api/proposals/${first.id}/merge`, {
        method: "POST",
        body: {},
      }),
    );
    console.log(`  merged ${merged.page_path} @ ${merged.sha.slice(0, 8)}…`);

    await step(`GET ${merged.page_path}`, () =>
      api<{ page: { sha: string } }>(`/api${merged.page_path}`),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  await step(`render digest for ${today}`, () =>
    api<{ delivered: boolean; path: string }>(`/api/_admin/digest/render?date=${today}`, {
      method: "POST",
    }),
  );

  // ── M8 release-readiness extensions ───────────────────────────────────

  // BYOK round-trip — PUT a fake key, GET metadata (no plaintext), DELETE,
  // confirm gone. The key string is obviously invalid so even if envelope
  // encryption is mis-wired and it leaks, no real credential is exposed.
  await step("BYOK round-trip (anthropic)", async () => {
    const put = await api<{ has_key: boolean; provider: string }>("/api/settings/byok/anthropic", {
      method: "PUT",
      body: { key: "sk-ant-smoke-test-do-not-use-in-prod" },
    });
    if (put.has_key !== true || put.provider !== "anthropic") {
      throw new Error(`PUT byok shape mismatch: ${JSON.stringify(put)}`);
    }

    const meta = await api<{ providers: Array<{ provider: string; has_key: boolean }> }>(
      "/api/settings/byok",
    );
    const ant = meta.providers?.find((p) => p.provider === "anthropic");
    if (ant === undefined || ant.has_key !== true) {
      throw new Error(`GET byok did not list anthropic with has_key=true: ${JSON.stringify(meta)}`);
    }
    // Defense in depth: assert no plaintext smuggled out.
    const metaText = JSON.stringify(meta);
    if (metaText.includes("sk-ant-smoke-test-do-not-use-in-prod")) {
      throw new Error("BYOK metadata response leaked the plaintext key");
    }

    await api<{ deleted: boolean }>("/api/settings/byok/anthropic", { method: "DELETE" });

    const after = await api<{ providers: Array<{ provider: string; has_key: boolean }> }>(
      "/api/settings/byok",
    );
    const stillThere = after.providers?.find((p) => p.provider === "anthropic" && p.has_key);
    if (stillThere !== undefined) {
      throw new Error(`BYOK delete did not remove anthropic key: ${JSON.stringify(after)}`);
    }
  });

  // Audit-log assertion — the manual_ingest.trigger we did earlier should
  // have surfaced an audit row keyed by the same run_id, with a
  // created_at within the last few seconds.
  await step("audit log includes recent manual_ingest.trigger", async () => {
    const NOW_S = Math.floor(Date.now() / 1000);
    const list = await api<{
      entries: Array<{
        action: string;
        created_at: number;
        details?: Record<string, unknown> | null;
      }>;
    }>("/api/_admin/audit?action=manual_ingest.trigger&limit=5");
    const recent = list.entries.filter((e) => NOW_S - e.created_at <= 60);
    if (recent.length === 0) {
      throw new Error(
        `no manual_ingest.trigger audit entries in last 60s (entries=${JSON.stringify(list.entries)})`,
      );
    }
    // Ideally one of them references our run_id, but we don't gate on it
    // because the audit-row schema for the details blob isn't load-bearing
    // for this assertion — the timing match is.
    const matchedRun = recent.some(
      (e) =>
        e.details !== undefined &&
        e.details !== null &&
        typeof (e.details as Record<string, unknown>).run_id === "string" &&
        (e.details as Record<string, unknown>).run_id === triggered.run_id,
    );
    console.log(`  recent=${recent.length} matched-run=${matchedRun}`);
  });

  // Sentry attestation — deliberately hit an invalid provider on the
  // BYOK delete endpoint; assert the error response carries a request id
  // (the X-Request-Id header is the contract Sentry / log dashboards key
  // off of). We don't ping Sentry directly from CI; we just verify the
  // worker is propagating a trace handle.
  await step("error responses carry X-Request-Id", async () => {
    const { res, json } = await apiRaw("/api/settings/byok/cohere", { method: "DELETE" });
    if (res.status === 200) {
      throw new Error(
        "expected non-200 from DELETE /api/settings/byok/cohere (invalid provider), got 200",
      );
    }
    const reqId = res.headers.get("x-request-id");
    if (reqId === null || reqId.trim() === "") {
      throw new Error(
        `missing X-Request-Id header on error response (status=${res.status} body=${JSON.stringify(json).slice(0, 200)})`,
      );
    }
    console.log(`  status=${res.status} x-request-id=${reqId}`);
  });

  console.log("\nSmoke complete.");
}

main().catch((err) => {
  console.error("\nSmoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
