// SPDX-License-Identifier: Apache-2.0

// MessageBubble pins:
//   - markdown sanitization (no <script> in rendered DOM)
//   - tombstone display (deleted_at !== null → "[deleted]")
//   - edit/delete buttons gated by user_id === currentUserId
//   - retry button only on failed bubbles

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "./useChat";

const ROOM_ID = "01900000-0000-7000-8000-000000000001";
const MY_USER_ID = "01900000-0000-7000-8000-0000000000aa";
const OTHER_USER_ID = "01900000-0000-7000-8000-0000000000bb";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "01900000-0000-7000-8000-000000000010",
    room_id: ROOM_ID,
    user_id: OTHER_USER_ID,
    body: "hello",
    parent_id: null,
    created_at: 1_700_000_000,
    edited_at: null,
    deleted_at: null,
    deliveryStatus: "delivered",
    ...overrides,
  };
}

describe("MessageBubble — markdown sanitization", () => {
  it("renders bold and links from markdown", () => {
    render(
      <MessageBubble
        message={makeMessage({ body: "**bold** [example](https://example.com)" })}
        authorDisplayName="Bob"
        currentUserId={MY_USER_ID}
      />,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "example" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("rel", "noopener noreferrer ugc");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("strips <script> tags from message bodies", () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({ body: "hi <script>alert(1)</script> bye" })}
        authorDisplayName="Bob"
        currentUserId={MY_USER_ID}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent ?? "").toContain("hi");
    expect(container.textContent ?? "").toContain("bye");
  });
});

describe("MessageBubble — tombstone", () => {
  it('renders "[deleted]" when deleted_at is set, regardless of body content', () => {
    render(
      <MessageBubble
        message={makeMessage({ body: "secret should not appear", deleted_at: 1_700_000_999 })}
        authorDisplayName="Bob"
        currentUserId={MY_USER_ID}
      />,
    );
    expect(screen.getByText("[deleted]")).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).toBeNull();
  });
});

describe("MessageBubble — author actions", () => {
  it("shows Edit and Delete buttons when message.user_id === currentUserId", () => {
    render(
      <MessageBubble
        message={makeMessage({ user_id: MY_USER_ID })}
        authorDisplayName="Me"
        currentUserId={MY_USER_ID}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /edit message/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete message/i })).toBeInTheDocument();
  });

  it("hides Edit/Delete when message.user_id !== currentUserId", () => {
    render(
      <MessageBubble
        message={makeMessage({ user_id: OTHER_USER_ID })}
        authorDisplayName="Bob"
        currentUserId={MY_USER_ID}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /edit message/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete message/i })).toBeNull();
  });

  it("shows the failed indicator and a Retry button when deliveryStatus is failed", () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        message={makeMessage({ deliveryStatus: "failed", tempId: "tmp-1" })}
        authorDisplayName="Bob"
        currentUserId={MY_USER_ID}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByLabelText(/failed to send/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
