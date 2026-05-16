// SPDX-License-Identifier: Apache-2.0

// RoomView pins the wiring of the "Run ingest" button:
//   - clicking calls triggerIngest(roomId)
//   - 202 lock_held → toast.info immediately
//   - ApiError      → toast.error("<code>: <message>") + button re-enabled
//   - button is disabled while the trigger request is in-flight
//   - 200 running   → polls getRunStatus; shows toast.success on "succeeded"
//                     or toast.error on "failed"
//
// useChat is mocked because the real hook opens a WebSocket on mount;
// happy-dom has no WebSocket, and the chat plumbing is already covered
// by useChat.test.tsx. We're testing the ingest path here.

import { ApiError } from "@/lib/api";
import * as apiInbox from "@/lib/api-inbox";
import type {
  IngestRunStatus,
  SerializedIngestRun,
  SerializedRoom,
  SerializedUser,
} from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomView } from "./RoomView";

vi.mock("./useChat", () => ({
  useChat: () => ({
    status: "connected" as const,
    messages: [],
    hasOlderHistory: false,
    lastError: null,
    loadOlder: vi.fn(),
    send: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
  }),
}));

const ROOM_ID = "01900000-0000-7000-8000-000000000001";
const USER_ID = "01900000-0000-7000-8000-0000000000aa";

const ROOM: SerializedRoom = {
  id: ROOM_ID,
  workspace_id: "01900000-0000-7000-8000-000000000000",
  slug: "test",
  name: "test",
  topic: null,
  created_by: USER_ID,
  created_at: "2026-01-01T00:00:00.000Z",
};

const USER: SerializedUser = {
  id: USER_ID,
  email: "cory@example.com",
  display_name: "Cory",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

function makeRun(status: IngestRunStatus, error: string | null = null): SerializedIngestRun {
  return {
    id: "run-1",
    room_id: ROOM_ID,
    triggered_by: USER_ID,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: status !== "running" ? "2026-01-01T00:01:00.000Z" : null,
    last_message_id: null,
    status,
    summary: null,
    error,
  };
}

describe("RoomView — Run ingest button", () => {
  let triggerIngestSpy: ReturnType<typeof vi.spyOn>;
  let getRunStatusSpy: ReturnType<typeof vi.spyOn>;
  let toastSuccess: ReturnType<typeof vi.spyOn>;
  let toastInfo: ReturnType<typeof vi.spyOn>;
  let toastError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    triggerIngestSpy = vi.spyOn(apiInbox, "triggerIngest");
    getRunStatusSpy = vi.spyOn(apiInbox, "getRunStatus");
    toastSuccess = vi.spyOn(toast, "success").mockImplementation(() => "id");
    toastInfo = vi.spyOn(toast, "info").mockImplementation(() => "id");
    toastError = vi.spyOn(toast, "error").mockImplementation(() => "id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the Run ingest button in the room header", () => {
    render(<RoomView room={ROOM} currentUser={USER} />);
    expect(screen.getByRole("button", { name: /run ingest/i })).toBeInTheDocument();
  });

  it("calls triggerIngest with the room id then polls and shows success toast on succeeded", async () => {
    triggerIngestSpy.mockResolvedValue({ run_id: "run-1", status: "running" });
    getRunStatusSpy.mockResolvedValue({ run: makeRun("succeeded") });

    render(<RoomView room={ROOM} currentUser={USER} />);
    fireEvent.click(screen.getByRole("button", { name: /run ingest/i }));

    await waitFor(() => expect(triggerIngestSpy).toHaveBeenCalledWith(ROOM_ID));
    // Success toast comes from the poll, not the trigger response.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]?.[0]).toMatch(/completed/i);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows error toast with run.error when the run fails", async () => {
    triggerIngestSpy.mockResolvedValue({ run_id: "run-1", status: "running" });
    getRunStatusSpy.mockResolvedValue({
      run: makeRun("failed", "missing LLM config — set AI_GATEWAY_ID and CF_ACCOUNT_ID"),
    });

    render(<RoomView room={ROOM} currentUser={USER} />);
    fireEvent.click(screen.getByRole("button", { name: /run ingest/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toMatch(/ingest failed/i);
    expect(toastError.mock.calls[0]?.[0]).toMatch(/missing LLM config/i);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows an info toast when the lock is already held", async () => {
    triggerIngestSpy.mockResolvedValue({ run_id: "run-1", status: "lock_held" });
    render(<RoomView room={ROOM} currentUser={USER} />);

    fireEvent.click(screen.getByRole("button", { name: /run ingest/i }));

    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(toastInfo.mock.calls[0]?.[0]).toMatch(/already in progress/i);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast with code:message on ApiError and re-enables the button", async () => {
    triggerIngestSpy.mockRejectedValue(
      new ApiError("RATE_LIMITED", "Daily ingest cap reached", 429),
    );
    render(<RoomView room={ROOM} currentUser={USER} />);

    const button = screen.getByRole("button", { name: /run ingest/i });
    fireEvent.click(button);

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toBe("RATE_LIMITED: Daily ingest cap reached");
    // Button should not be stuck in the "Starting…" state.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run ingest/i })).not.toBeDisabled(),
    );
  });

  it("disables the button while the trigger request is in flight", async () => {
    let resolve: ((v: { run_id: string; status: "running" }) => void) | undefined;
    triggerIngestSpy.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<RoomView room={ROOM} currentUser={USER} />);

    const button = screen.getByRole("button", { name: /run ingest/i });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled());

    getRunStatusSpy.mockResolvedValue({ run: makeRun("succeeded") });
    resolve?.({ run_id: "run-1", status: "running" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run ingest/i })).not.toBeDisabled(),
    );
  });
});
