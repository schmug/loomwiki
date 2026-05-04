// SPDX-License-Identifier: Apache-2.0

// React hook around ChatClient (apps/web/src/lib/ws.ts).
//
// Owns:
//   - Connection lifecycle (open/close on mount/unmount).
//   - Status: "connecting" | "connected" | "reconnecting" | "disconnected".
//   - Message list — server-acknowledged messages plus optimistic
//     in-flight entries (status: "sending" | "failed"). Reconciled by
//     tempId when the ack lands.
//   - Welcome `hasMore` flag — when set, the UI renders the
//     "Load older messages" affordance and `loadOlder()` fetches the
//     next page from the REST scrollback route.
//   - send / edit / delete / retry methods.
//
// Does NOT own:
//   - Optimistic-UI rendering decisions (auto-scroll, "N new messages"
//     pill) — that's MessageList's concern.
//   - URL routing — the page chrome owns it.

import { apiGet } from "@/lib/api";
import { devEmailIfSet } from "@/lib/dev";
import { ChatClient, type ChatClientEvent } from "@/lib/ws";
import { type ServerMsg, type WireMessage, id as makeId } from "@loomwiki/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export type MessageDeliveryStatus = "delivered" | "sending" | "failed";

export interface ChatMessage extends WireMessage {
  /** Client-only delivery status for optimistic-UI rendering. */
  deliveryStatus: MessageDeliveryStatus;
  /**
   * tempId associated with optimistic entries. Carried through ack
   * reconciliation so retry() can re-send the same logical message.
   */
  tempId?: string;
}

export interface UseChatOptions {
  roomId: string;
  currentUserId: string;
  /** Required so we can build the WS URL. Defaults to same-origin. */
  wsUrlBuilder?: (roomId: string) => string;
  /** Test seams. */
  WebSocketCtor?: typeof WebSocket;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /**
   * Construct the ChatClient. Tests pass a fake; production passes
   * undefined (a real client is constructed inline).
   */
  createClient?: (opts: { url: string }) => ChatClient;
  /**
   * Fetch older messages via REST. Tests pass a fake; production uses
   * apiGet under the hood.
   */
  loadOlderFromApi?: (
    roomId: string,
    beforeId: string,
  ) => Promise<{ messages: WireMessage[]; hasMore: boolean }>;
}

export interface UseChatResult {
  status: ConnectionStatus;
  messages: ChatMessage[];
  hasOlderHistory: boolean;
  send: (body: string, parentId?: string) => string;
  edit: (messageId: string, body: string) => void;
  remove: (messageId: string) => void;
  retry: (tempId: string) => void;
  loadOlder: () => Promise<void>;
  lastError: Error | null;
}

const ACK_TIMEOUT_MS = 5_000;

function defaultWsUrl(roomId: string): string {
  // Browsers can't set custom headers on WebSocket connections, so the
  // local-dev email travels via query string instead. The worker
  // auth middleware reads it (still triple-gated). In production
  // PUBLIC_LOOMWIKI_DEV_EMAIL is unset and Cloudflare Access cookies
  // gate the upgrade.
  const dev = devEmailIfSet();
  const query = dev ? `?devEmail=${encodeURIComponent(dev)}` : "";
  if (typeof location === "undefined") return `/api/rooms/${roomId}/ws${query}`;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/rooms/${roomId}/ws${query}`;
}

async function defaultLoadOlder(
  roomId: string,
  beforeId: string,
): Promise<{ messages: WireMessage[]; hasMore: boolean }> {
  return apiGet<{ messages: WireMessage[]; hasMore: boolean }>(
    `/api/rooms/${roomId}/messages?before=${encodeURIComponent(beforeId)}&limit=50`,
  );
}

export function useChat(options: UseChatOptions): UseChatResult {
  const {
    roomId,
    currentUserId,
    wsUrlBuilder = defaultWsUrl,
    WebSocketCtor,
    setTimer,
    clearTimer,
    createClient,
    loadOlderFromApi = defaultLoadOlder,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);

  // Keep the latest setMessages in a ref so timer callbacks (which
  // capture an old closure) don't end up referencing stale state.
  const ackTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const clientRef = useRef<ChatClient | null>(null);
  const reconnectAttemptsRef = useRef(0);

  // Stable factory invoked exactly once per roomId.
  const url = useMemo(() => wsUrlBuilder(roomId), [wsUrlBuilder, roomId]);

  // Test seams are captured in a ref so the effect dep list stays small
  // and the WS lifecycle isn't torn down whenever a test re-renders.
  const seamsRef = useRef({ WebSocketCtor, setTimer, clearTimer, createClient });
  seamsRef.current = { WebSocketCtor, setTimer, clearTimer, createClient };

  useEffect(() => {
    const { WebSocketCtor: WS, setTimer: ST, clearTimer: CT, createClient: CC } = seamsRef.current;
    const client =
      CC !== undefined
        ? CC({ url })
        : new ChatClient({
            url,
            ...(WS !== undefined ? { WebSocketCtor: WS } : {}),
            ...(ST !== undefined ? { setTimer: ST } : {}),
            ...(CT !== undefined ? { clearTimer: CT } : {}),
          });
    clientRef.current = client;

    const off = client.on((event: ChatClientEvent) => {
      switch (event.kind) {
        case "open":
          reconnectAttemptsRef.current = 0;
          setStatus("connected");
          setLastError(null);
          break;
        case "close":
          // Auto-reconnect is handled inside ChatClient — surface
          // "reconnecting" until "open" arrives again.
          setStatus("reconnecting");
          reconnectAttemptsRef.current += 1;
          break;
        case "error":
          setLastError(event.error);
          break;
        case "server":
          handleServerMessage(event.msg);
          break;
      }
    });

    function handleServerMessage(msg: ServerMsg): void {
      switch (msg.kind) {
        case "welcome": {
          const recent: ChatMessage[] = msg.recentMessages.map((m) => ({
            ...m,
            deliveryStatus: "delivered" as const,
          }));
          setMessages((prev) => mergeOldest(recent, prev));
          setHasOlderHistory(msg.hasMore);
          break;
        }
        case "message": {
          const wire = msg.message;
          setMessages((prev) => appendDelivered(prev, wire));
          break;
        }
        case "ack": {
          const timer = ackTimers.current.get(msg.tempId);
          if (timer) {
            clearTimeout(timer);
            ackTimers.current.delete(msg.tempId);
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.tempId === msg.tempId
                ? { ...m, id: msg.messageId, deliveryStatus: "delivered" }
                : m,
            ),
          );
          break;
        }
        case "edited": {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msg.messageId ? { ...m, body: msg.body, edited_at: msg.editedAt } : m,
            ),
          );
          break;
        }
        case "deleted": {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msg.messageId ? { ...m, body: "", deleted_at: msg.deletedAt } : m,
            ),
          );
          break;
        }
        case "error": {
          setLastError(new Error(`${msg.code}: ${msg.message}`));
          if (msg.tempId) {
            const timer = ackTimers.current.get(msg.tempId);
            if (timer) {
              clearTimeout(timer);
              ackTimers.current.delete(msg.tempId);
            }
            const t = msg.tempId;
            setMessages((prev) =>
              prev.map((m) => (m.tempId === t ? { ...m, deliveryStatus: "failed" } : m)),
            );
          }
          break;
        }
        case "pong":
          // heartbeat; ChatClient already swallows but if we ever see one,
          // ignore.
          break;
      }
    }

    client.connect();

    return () => {
      off();
      client.close();
      clientRef.current = null;
      for (const timer of ackTimers.current.values()) clearTimeout(timer);
      ackTimers.current.clear();
    };
  }, [url]);

  const sendInternal = useCallback(
    (body: string, parentId: string | undefined, tempIdOverride?: string): string => {
      const tempId = tempIdOverride ?? makeId();
      const now = Math.floor(Date.now() / 1000);
      const optimistic: ChatMessage = {
        id: `temp-${tempId}`,
        room_id: roomId,
        user_id: currentUserId,
        body,
        parent_id: parentId ?? null,
        created_at: now,
        edited_at: null,
        deleted_at: null,
        deliveryStatus: "sending",
        tempId,
      };
      setMessages((prev) => [...prev, optimistic]);

      clientRef.current?.sendMessage(tempId, body, parentId);

      // Failure-on-no-ack timer.
      const handle = setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.tempId === tempId && m.deliveryStatus !== "delivered"
              ? { ...m, deliveryStatus: "failed" }
              : m,
          ),
        );
        ackTimers.current.delete(tempId);
      }, ACK_TIMEOUT_MS);
      ackTimers.current.set(tempId, handle);

      return tempId;
    },
    [roomId, currentUserId],
  );

  const send = useCallback(
    (body: string, parentId?: string): string => sendInternal(body, parentId),
    [sendInternal],
  );

  const edit = useCallback((messageId: string, body: string): void => {
    clientRef.current?.edit(messageId, body);
  }, []);

  const remove = useCallback((messageId: string): void => {
    clientRef.current?.delete(messageId);
  }, []);

  const retry = useCallback((tempId: string): void => {
    // Find the failed entry, reset its delivery status, and re-send
    // with the same tempId so the server can dedup if it actually
    // received the original.
    let toResend: ChatMessage | null = null;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.tempId === tempId && m.deliveryStatus === "failed") {
          toResend = m;
          return { ...m, deliveryStatus: "sending" };
        }
        return m;
      }),
    );
    // setState is async; defer to next tick so the optimistic flip
    // renders before we touch the wire.
    queueMicrotask(() => {
      if (!toResend) return;
      clientRef.current?.sendMessage(tempId, toResend.body, toResend.parent_id ?? undefined);
      const handle = setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.tempId === tempId && m.deliveryStatus !== "delivered"
              ? { ...m, deliveryStatus: "failed" }
              : m,
          ),
        );
        ackTimers.current.delete(tempId);
      }, ACK_TIMEOUT_MS);
      ackTimers.current.set(tempId, handle);
    });
  }, []);

  const loadOlder = useCallback(async (): Promise<void> => {
    const oldest = messages.find((m) => m.deliveryStatus === "delivered");
    if (!oldest || !hasOlderHistory) return;
    try {
      const page = await loadOlderFromApi(roomId, oldest.id);
      const prepend: ChatMessage[] = page.messages.map((m) => ({
        ...m,
        deliveryStatus: "delivered" as const,
      }));
      setMessages((prev) => mergeOldest(prepend, prev));
      setHasOlderHistory(page.hasMore);
    } catch (err) {
      setLastError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [hasOlderHistory, loadOlderFromApi, messages, roomId]);

  return {
    status,
    messages,
    hasOlderHistory,
    send,
    edit,
    remove,
    retry,
    loadOlder,
    lastError,
  };
}

// ---------- helpers ----------

/**
 * Merge a page of older messages (`older`) before the existing list.
 * Drops any duplicates by id. Used both for the welcome's
 * recentMessages (when the list was empty) and for the REST scrollback
 * loadOlder() path.
 */
function mergeOldest(older: ChatMessage[], existing: ChatMessage[]): ChatMessage[] {
  if (existing.length === 0) return older;
  const existingIds = new Set(existing.map((m) => m.id));
  const fresh = older.filter((m) => !existingIds.has(m.id));
  return [...fresh, ...existing];
}

/**
 * Append a server-delivered message. If a matching tempId entry exists
 * in the optimistic list, replace it; otherwise append.
 */
function appendDelivered(prev: ChatMessage[], wire: WireMessage): ChatMessage[] {
  // Find by id (already-acknowledged) or by tempId echoed back via ack.
  const existingById = prev.findIndex((m) => m.id === wire.id);
  if (existingById !== -1) {
    return prev.map((m, i) => (i === existingById ? { ...wire, deliveryStatus: "delivered" } : m));
  }
  return [...prev, { ...wire, deliveryStatus: "delivered" }];
}
