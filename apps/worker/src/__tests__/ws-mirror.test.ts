// SPDX-License-Identifier: Apache-2.0

// D1 mirror tests for the ChatRoom DO write-through path. The DO is the
// source of truth for the live state; `messages` in D1 is the queryable
// mirror that ingest, scrollback, and the daily-log cron rely on.

import { SELF, env } from "cloudflare:test";
import { PROTOCOL_VERSION } from "@loomwiki/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const sessions: WsSession[] = [];
afterEach(() => {
  while (sessions.length > 0) {
    sessions.pop()?.close();
  }
});

async function bootstrap(slug: string): Promise<{ jwt: string; roomId: string; userId: string }> {
  const jwt = await fixture.mint({ email: "alice@example.com" });
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
  return { jwt, roomId: room.data.room.id, userId: meBody.data.user.id };
}

async function readMessageFromD1(messageId: string): Promise<{ body: string } | null> {
  const row = await env.DB.prepare("SELECT body FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ body: string }>();
  return row;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // Tight poll — vitest-pool-workers' D1 is in-process, so 25ms is plenty.
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("ChatRoom → D1 mirror", () => {
  it("a sent message is visible in D1 `messages` within 1 second", async () => {
    const { jwt, roomId } = await bootstrap("general");
    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "m1", body: "mirrored?" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");

    const row = await waitFor(() => readMessageFromD1(ack.messageId), 1500);
    expect(row.body).toBe("mirrored?");
  });

  it("an edited message updates the D1 row body", async () => {
    const { jwt, roomId } = await bootstrap("general");
    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "m1", body: "v1" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");
    await waitFor(() => readMessageFromD1(ack.messageId));

    ws.send({ kind: "edit", messageId: ack.messageId, body: "v2" });
    await ws.next(); // consume the edited broadcast

    const row = await waitFor(async () => {
      const r = await readMessageFromD1(ack.messageId);
      return r && r.body === "v2" ? r : null;
    }, 1500);
    expect(row.body).toBe("v2");
  });

  it("a deleted message updates D1 deleted_at", async () => {
    const { jwt, roomId } = await bootstrap("general");
    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "m1", body: "doomed" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");
    await waitFor(() => readMessageFromD1(ack.messageId));

    ws.send({ kind: "delete", messageId: ack.messageId });
    await ws.next();

    await waitFor(async () => {
      const r = await env.DB.prepare("SELECT deleted_at FROM messages WHERE id = ?")
        .bind(ack.messageId)
        .first<{ deleted_at: number | null }>();
      return r && r.deleted_at !== null ? r : null;
    }, 1500);
  });
});
