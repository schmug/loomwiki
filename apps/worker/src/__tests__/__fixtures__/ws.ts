// SPDX-License-Identifier: Apache-2.0

// WebSocket test helper. Opens a session through `SELF.fetch` (so auth +
// route + DO upgrade all run as one unit) and exposes a Promise-based
// queue of inbound `ServerMsg` envelopes.

import { SELF } from "cloudflare:test";
import { type ServerMsg, ServerMsgSchema } from "@loomwiki/shared";

export interface WsSession {
  ws: WebSocket;
  /** Resolves with the next inbound ServerMsg, or rejects on timeout. */
  next(timeoutMs?: number): Promise<ServerMsg>;
  /** Drain inbound queue for ~`waitMs` and return everything seen. */
  collect(waitMs?: number): Promise<ServerMsg[]>;
  send(envelope: unknown): void;
  close(): void;
}

interface PendingResolver {
  resolve(msg: ServerMsg): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export async function openWs(roomId: string, jwt: string): Promise<WsSession> {
  const res = await SELF.fetch(`https://api.local/api/rooms/${roomId}/ws`, {
    headers: {
      Upgrade: "websocket",
      "CF-Access-Jwt-Assertion": jwt,
    },
  });
  if (res.status !== 101 || !res.webSocket) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`ws upgrade failed: status=${res.status} body=${body}`);
  }
  const ws = res.webSocket;

  const queue: ServerMsg[] = [];
  const waiters: PendingResolver[] = [];

  ws.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    let parsed: ServerMsg;
    try {
      const json: unknown = JSON.parse(data);
      const result = ServerMsgSchema.safeParse(json);
      if (!result.success) {
        console.warn("[ws-test] unexpected envelope shape", result.error.issues);
        return;
      }
      parsed = result.data;
    } catch (err) {
      console.warn("[ws-test] non-JSON frame", err);
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
    } else {
      queue.push(parsed);
    }
  });

  ws.accept();

  return {
    ws,
    async next(timeoutMs = 1500): Promise<ServerMsg> {
      const buffered = queue.shift();
      if (buffered !== undefined) return buffered;
      return new Promise<ServerMsg>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`ws.next() timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
    async collect(waitMs = 200): Promise<ServerMsg[]> {
      await new Promise((r) => setTimeout(r, waitMs));
      const drained = queue.splice(0, queue.length);
      return drained;
    },
    send(envelope: unknown): void {
      ws.send(JSON.stringify(envelope));
    },
    close(): void {
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}
