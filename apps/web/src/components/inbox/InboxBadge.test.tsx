// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxBadge } from "./InboxBadge";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("InboxBadge", () => {
  it("renders the count when > 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { status: "pending", count: 4 } })),
    );
    render(<InboxBadge />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("4");
    });
  });

  it("renders nothing when the count is 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { status: "pending", count: 0 } })),
    );
    const { container } = render(<InboxBadge />);
    // Initial render → null (count starts at null). Wait a tick for poll.
    await waitFor(() => {
      // After the fetch resolves count is 0, badge stays unmounted.
      expect(container.querySelector('[role="status"]')).toBeNull();
    });
  });

  it("caps the display at 99+ for high counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { status: "pending", count: 250 } })),
    );
    render(<InboxBadge />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("99+");
    });
  });

  it("uses the SSR-supplied initial count for first paint", () => {
    // Don't stub fetch so the poll is the only post-mount activity.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Promise<Response>(() => {})),
    );
    render(<InboxBadge initialCount={3} />);
    expect(screen.getByRole("status")).toHaveTextContent("3");
  });
});
