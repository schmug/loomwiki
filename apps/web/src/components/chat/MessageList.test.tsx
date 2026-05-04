// SPDX-License-Identifier: Apache-2.0

// MessageList pins:
//   - empty state when no messages and no older history
//   - "Load older messages" affordance when hasOlderHistory
//   - clicking the affordance fires onLoadOlder
//   - date separator headings appear once per calendar day

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";
import type { ChatMessage } from "./useChat";

const ROOM_ID = "01900000-0000-7000-8000-000000000001";
const USER_ID = "01900000-0000-7000-8000-0000000000aa";

function makeMessage(id: string, createdAtSec: number, body = "hi"): ChatMessage {
  return {
    id,
    room_id: ROOM_ID,
    user_id: USER_ID,
    body,
    parent_id: null,
    created_at: createdAtSec,
    edited_at: null,
    deleted_at: null,
    deliveryStatus: "delivered",
  };
}

function names(): Map<string, string> {
  return new Map([[USER_ID, "Cory"]]);
}

describe("MessageList — empty state", () => {
  it('renders the "No messages yet" copy when there are no messages and no older history', () => {
    render(
      <MessageList
        messages={[]}
        currentUserId={USER_ID}
        authorDisplayNames={names()}
        hasOlderHistory={false}
        onLoadOlder={vi.fn()}
      />,
    );
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });
});

describe("MessageList — load older affordance", () => {
  it("renders the button when hasOlderHistory is true", () => {
    render(
      <MessageList
        messages={[]}
        currentUserId={USER_ID}
        authorDisplayNames={names()}
        hasOlderHistory={true}
        onLoadOlder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /load older messages/i })).toBeInTheDocument();
  });

  it("does NOT render the button when hasOlderHistory is false", () => {
    render(
      <MessageList
        messages={[makeMessage("01900000-0000-7000-8000-000000000a01", 1_700_000_000, "hi")]}
        currentUserId={USER_ID}
        authorDisplayNames={names()}
        hasOlderHistory={false}
        onLoadOlder={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull();
  });

  it("calls onLoadOlder when clicked", () => {
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageList
        messages={[]}
        currentUserId={USER_ID}
        authorDisplayNames={names()}
        hasOlderHistory={true}
        onLoadOlder={onLoadOlder}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /load older messages/i }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});

describe("MessageList — date separators", () => {
  it("renders one heading per calendar day", () => {
    // Use timestamps in two distinct UTC days far in the past so the
    // formatter renders absolute day names rather than "Today" or
    // "Yesterday" (which depend on the test machine's clock).
    const day1 = Math.floor(new Date("2020-05-01T12:00:00Z").getTime() / 1000);
    const day2 = Math.floor(new Date("2020-05-03T12:00:00Z").getTime() / 1000);
    const messages: ChatMessage[] = [
      makeMessage("01900000-0000-7000-8000-000000000a01", day1, "morning"),
      makeMessage("01900000-0000-7000-8000-000000000a02", day1, "later"),
      makeMessage("01900000-0000-7000-8000-000000000a03", day2, "next day"),
    ];

    render(
      <MessageList
        messages={messages}
        currentUserId={USER_ID}
        authorDisplayNames={names()}
        hasOlderHistory={false}
        onLoadOlder={vi.fn()}
      />,
    );

    // Two distinct headings — once per calendar day.
    const headings = screen.getAllByText(
      /Friday|Sunday|Monday|Tuesday|Wednesday|Thursday|Saturday/,
    );
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("morning")).toBeInTheDocument();
    expect(screen.getByText("later")).toBeInTheDocument();
    expect(screen.getByText("next day")).toBeInTheDocument();
  });
});
