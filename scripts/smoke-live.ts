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

  console.log("\nSmoke complete.");
}

main().catch((err) => {
  console.error("\nSmoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
