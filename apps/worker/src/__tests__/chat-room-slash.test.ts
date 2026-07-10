// SPDX-License-Identifier: Apache-2.0

// ChatRoom DO slash-command tests (v0.1 M9): /task, /event, /done.
// Harness copied from chat-room.test.ts; see that file for the rationale on
// why bootstrapMember/joinAsMember drive through SELF.fetch rather than
// hitting the DO directly.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { ErrorCodes, PROTOCOL_VERSION, type ServerMsg } from "@loomwiki/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatRoom } from "../do/ChatRoom.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";
import { type WsSession, openWs } from "./__fixtures__/ws.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

beforeEach(async () => {
  await resetDb();
});

const openSessions: WsSession[] = [];
afterEach(() => {
  while (openSessions.length > 0) {
    const s = openSessions.pop();
    s?.close();
  }
});

interface RoomBootstrap {
  jwt: string;
  userId: string;
  roomId: string;
}

async function bootstrapMember(email: string, slug: string): Promise<RoomBootstrap> {
  const jwt = await fixture.mint({ email });
  const me = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const meBody = (await me.json()) as {
    data: { user: { id: string }; workspace: { id: string } };
  };

  const create = await SELF.fetch(
    `https://api.local/api/workspaces/${meBody.data.workspace.id}/rooms`,
    {
      method: "POST",
      headers: {
        "CF-Access-Jwt-Assertion": jwt,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug, name: slug }),
    },
  );
  const room = (await create.json()) as { data: { room: { id: string } } };
  return { jwt, userId: meBody.data.user.id, roomId: room.data.room.id };
}

async function joinAsMember(jwt: string, roomId: string): Promise<string> {
  // Bootstrap user via /me so the row exists, then add to room_members
  // directly via D1 (the public room-join API lands later — for now this
  // is the test seam).
  const me = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const meBody = (await me.json()) as { data: { user: { id: string } } };
  await env.DB.prepare(
    "INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')",
  )
    .bind(roomId, meBody.data.user.id)
    .run();
  return meBody.data.user.id;
}

async function track<T extends WsSession>(s: T): Promise<T> {
  openSessions.push(s);
  return s;
}

async function connect(roomId: string, jwt: string): Promise<WsSession> {
  const ws = await track(await openWs(roomId, jwt));
  ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
  const welcome = await ws.next();
  expect(welcome.kind).toBe("welcome");
  return ws;
}

/** Send a slash command and consume the happy-path frame pair (ack, note). */
async function sendAndSettle(
  ws: WsSession,
  tempId: string,
  body: string,
): Promise<{ ack: ServerMsg; note: ServerMsg }> {
  ws.send({ kind: "send", tempId, body });
  const ack = await ws.next();
  const note = await ws.next();
  return { ack, note };
}

describe("ChatRoom slash commands", () => {
  it("/task creates a D1 task with chat provenance and confirms in-room", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    const { ack, note } = await sendAndSettle(ws, "t1", "/task Fix login bug due:2026-07-20");
    expect(ack.kind).toBe("ack");
    if (ack.kind !== "ack") throw new Error("unreachable");
    expect(note.kind).toBe("message");
    if (note.kind !== "message") throw new Error("unreachable");
    expect(note.message.body).toContain('created task "Fix login bug"');

    const row = await env.DB.prepare("SELECT * FROM tasks").first<{
      title: string;
      status: string;
      room_id: string;
      due_at: number;
      origin_message_id: string;
      created_by: string;
    }>();
    expect(row?.title).toBe("Fix login bug");
    expect(row?.status).toBe("todo");
    expect(row?.room_id).toBe(alice.roomId);
    expect(row?.due_at).toBe(Date.parse("2026-07-20T00:00:00Z") / 1000);
    expect(row?.origin_message_id).toBe(ack.messageId);
    expect(row?.created_by).toBe(alice.userId);
  });

  it("resolves @assignee by email local-part among room members", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    const bobId = await joinAsMember(bobJwt, alice.roomId);
    const ws = await connect(alice.roomId, alice.jwt);

    const { note } = await sendAndSettle(ws, "t1", "/task Review PR @bob");
    expect(note.kind).toBe("message");
    const row = await env.DB.prepare("SELECT assignee_id FROM tasks").first<{
      assignee_id: string;
    }>();
    expect(row?.assignee_id).toBe(bobId);
  });

  it("unknown @assignee → sender-only error, no task, no message persisted", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    ws.send({ kind: "send", tempId: "t1", body: "/task x @nobody" });
    const ack = await ws.next();
    expect(ack.kind).toBe("ack"); // command message itself persists (provenance)
    const err = await ws.next();
    expect(err.kind).toBe("error");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("bad syntax → error envelope with tempId, nothing persisted at all", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    ws.send({ kind: "send", tempId: "t9", body: "/task" });
    const err = await ws.next();
    expect(err.kind).toBe("error");
    if (err.kind !== "error") throw new Error("unreachable");
    expect(err.tempId).toBe("t9");

    const stub = env.CHAT_ROOM.get(
      env.CHAT_ROOM.idFromName(alice.roomId),
    ) as DurableObjectStub<ChatRoom>;
    const count = await runInDurableObject(stub, (instance: ChatRoom) =>
      instance.localMessageCount(),
    );
    expect(count).toBe(0);
  });

  it("/event creates an all-day event; timed variant sets ends via duration", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    await sendAndSettle(ws, "t1", "/event Team offsite 2026-07-24");
    await sendAndSettle(ws, "t2", "/event Standup 2026-07-24 09:30 +30m");

    const rows = await env.DB.prepare(
      "SELECT title, starts_at, ends_at, all_day FROM events ORDER BY starts_at",
    ).all<{
      title: string;
      starts_at: number;
      ends_at: number | null;
      all_day: number;
    }>();
    const offsite = rows.results[0];
    const standup = rows.results[1];
    expect(offsite?.title).toBe("Team offsite");
    expect(offsite?.all_day).toBe(1);
    expect(offsite?.starts_at).toBe(Date.parse("2026-07-24T00:00:00Z") / 1000);
    expect(standup?.all_day).toBe(0);
    expect(standup?.starts_at).toBe(Date.parse("2026-07-24T09:30:00Z") / 1000);
    expect(standup?.ends_at).toBe(Date.parse("2026-07-24T10:00:00Z") / 1000);
  });

  it("/done closes the unique open title match; ambiguity errors", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    await sendAndSettle(ws, "t1", "/task Unique thing");
    const { note } = await sendAndSettle(ws, "t2", "/done unique THING");
    expect(note.kind).toBe("message");
    if (note.kind !== "message") throw new Error("unreachable");
    expect(note.message.body).toContain("done");
    const row = await env.DB.prepare(
      "SELECT status, completed_at FROM tasks WHERE title = 'Unique thing'",
    ).first<{ status: string; completed_at: number | null }>();
    expect(row?.status).toBe("done");
    expect(row?.completed_at).not.toBeNull();

    await sendAndSettle(ws, "t3", "/task Dup");
    await sendAndSettle(ws, "t4", "/task Dup");
    ws.send({ kind: "send", tempId: "t5", body: "/done Dup" });
    await ws.next(); // ack for the command message
    const err = await ws.next();
    expect(err.kind).toBe("error");
  });

  it("unknown slash commands pass through as normal messages", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    ws.send({ kind: "send", tempId: "t1", body: "/ask what did we decide?" });
    const ack = await ws.next();
    expect(ack.kind).toBe("ack");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("invoking command message is durable in D1 before the FK-bearing INSERT", async () => {
    // tasks.origin_message_id has a FK REFERENCES messages(id). The normal
    // mirror is fire-and-forget (waitUntil), so the command message must be
    // forced durable in D1 *before* execSlashCommand runs the dependent
    // INSERT. Assert both: the task's origin_message_id is populated and the
    // referenced message row is present in D1 once the confirmation arrives.
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    const { ack, note } = await sendAndSettle(ws, "t1", "/task Fix login bug");
    expect(ack.kind).toBe("ack");
    if (ack.kind !== "ack") throw new Error("unreachable");
    expect(note.kind).toBe("message");

    const task = await env.DB.prepare("SELECT origin_message_id FROM tasks").first<{
      origin_message_id: string | null;
    }>();
    expect(task?.origin_message_id).not.toBeNull();
    expect(task?.origin_message_id).toBe(ack.messageId);

    const msg = await env.DB.prepare("SELECT id FROM messages WHERE id = ?")
      .bind(task?.origin_message_id)
      .first<{ id: string }>();
    expect(msg?.id).toBe(ack.messageId);
  });

  it("exec-layer DB error yields a sender error frame, not a hung socket", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    const stub = env.CHAT_ROOM.get(
      env.CHAT_ROOM.idFromName(alice.roomId),
    ) as DurableObjectStub<ChatRoom>;

    // Break ONLY execSlashCommand's `INSERT INTO tasks` on the live instance,
    // leaving the synchronous message mirror (`INSERT INTO messages`) and the
    // workspace SELECT intact. This isolates the Part B guard: the exec throws
    // *after* the invoking message was already acked. Without the dispatch
    // guard the throw escapes webSocketMessage and the socket hangs with no
    // `message` and no `error` frame. Injected via runInDurableObject, the
    // same live-instance seam pattern ws-mirror.test.ts uses for `_mirrorFn`.
    await runInDurableObject(stub, (instance: ChatRoom) => {
      const holder = instance as unknown as { env: Record<string, unknown> };
      const realDb = holder.env.DB as { prepare: (sql: string) => unknown };
      const brokenDb = new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("INSERT INTO tasks")) {
                throw new Error("injected tasks INSERT failure");
              }
              return realDb.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      holder.env = { ...holder.env, DB: brokenDb };
    });

    ws.send({ kind: "send", tempId: "t1", body: "/task Fix login bug" });
    const ack = await ws.next();
    expect(ack.kind).toBe("ack");
    // The guard must turn the exec throw into an error frame within the
    // ws.next() timeout — a hang would reject here instead.
    const err = await ws.next();
    expect(err.kind).toBe("error");
    if (err.kind !== "error") throw new Error("unreachable");
    expect(err.code).toBe(ErrorCodes.INTERNAL_ERROR);
  });
});
