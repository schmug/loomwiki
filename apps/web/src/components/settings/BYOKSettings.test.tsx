// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BYOKSettings } from "./BYOKSettings";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(handler: (url: string, init?: RequestInit) => Response): {
  fn: ReturnType<typeof vi.fn>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("BYOKSettings", () => {
  it("renders providers from listBYOK", async () => {
    recordingFetch((url) => {
      if (url === "/api/settings/byok") {
        return jsonResponse({
          ok: true,
          data: {
            keys: [
              {
                workspace_id: "ws",
                provider: "anthropic",
                has_key: true,
                created_at: Math.floor(Date.now() / 1000) - 60,
                created_by: "u1",
                last_used_at: null,
              },
            ],
          },
        });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<BYOKSettings />);

    // Both v0.0.1 visible providers render.
    expect(await screen.findByText(/Anthropic \(Claude\)/)).toBeInTheDocument();
    expect(screen.getByText(/^OpenAI$/)).toBeInTheDocument();

    // Anthropic is configured, OpenAI is not.
    await waitFor(() => {
      expect(screen.getByText(/Configured: yes/)).toBeInTheDocument();
      expect(screen.getByText(/Configured: no/)).toBeInTheDocument();
    });
  });

  it("clears the textarea after save and never displays the typed key", async () => {
    const user = userEvent.setup();
    recordingFetch((url, init) => {
      if (url === "/api/settings/byok" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ ok: true, data: { keys: [] } });
      }
      if (url === "/api/settings/byok/anthropic" && init?.method === "PUT") {
        return jsonResponse({
          ok: true,
          data: {
            workspace_id: "ws",
            provider: "anthropic",
            has_key: true,
            created_at: Math.floor(Date.now() / 1000),
            created_by: "u1",
            last_used_at: null,
          },
        });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<BYOKSettings />);

    // Wait for load.
    const addButtons = await screen.findAllByRole("button", { name: /Add key/ });
    // Click the Anthropic Add Key button (first card).
    const [firstAddBtn] = addButtons;
    if (!firstAddBtn) throw new Error("Expected at least one Add key button");
    await user.click(firstAddBtn);

    const textarea = screen.getByLabelText(/Paste API key/);
    const SECRET = "sk-ant-test-XYZ-do-not-leak";
    await user.type(textarea, SECRET);
    expect((textarea as HTMLTextAreaElement).value).toBe(SECRET);

    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    // After save: the success banner appears...
    await waitFor(() => {
      expect(screen.getByText(/Saved. The key is encrypted at rest./)).toBeInTheDocument();
    });

    // ...and the typed key is not in the DOM anywhere.
    expect(document.body.textContent).not.toContain(SECRET);

    // The form is collapsed (no textarea).
    expect(screen.queryByLabelText(/Paste API key/)).toBeNull();
  });

  it("cancel clears the typed key and closes the form", async () => {
    const user = userEvent.setup();
    recordingFetch((url) => {
      if (url === "/api/settings/byok") {
        return jsonResponse({ ok: true, data: { keys: [] } });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<BYOKSettings />);
    const addButtons = await screen.findAllByRole("button", { name: /Add key/ });
    const [firstAddBtnCancel] = addButtons;
    if (!firstAddBtnCancel) throw new Error("Expected at least one Add key button");
    await user.click(firstAddBtnCancel);
    const textarea = screen.getByLabelText(/Paste API key/);
    await user.type(textarea, "sk-secret-cancelled");
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.queryByLabelText(/Paste API key/)).toBeNull();
    expect(document.body.textContent).not.toContain("sk-secret-cancelled");
  });

  it("remove flow opens a confirm dialog and then DELETEs", async () => {
    const user = userEvent.setup();
    const { calls } = recordingFetch((url, init) => {
      if (url === "/api/settings/byok" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          ok: true,
          data: {
            keys: [
              {
                workspace_id: "ws",
                provider: "anthropic",
                has_key: true,
                created_at: Math.floor(Date.now() / 1000),
                created_by: "u1",
                last_used_at: null,
              },
            ],
          },
        });
      }
      if (url === "/api/settings/byok/anthropic" && init?.method === "DELETE") {
        return jsonResponse({
          ok: true,
          data: { deleted: true, provider: "anthropic" },
        });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<BYOKSettings />);

    const removeButton = await screen.findByRole("button", { name: /^Remove$/ });
    await user.click(removeButton);

    // Confirm dialog visible.
    expect(await screen.findByText(/Remove the Anthropic \(Claude\) key\?/)).toBeInTheDocument();

    // Confirm.
    const dialogRemove = screen
      .getAllByRole("button", { name: /^Remove$/ })
      .find((b) => b !== removeButton);
    expect(dialogRemove).toBeDefined();
    if (!dialogRemove) throw new Error("Expected dialog Remove button to exist");
    await user.click(dialogRemove);

    await waitFor(() => {
      const deleteCall = calls.find(
        (c) => c.url === "/api/settings/byok/anthropic" && c.init?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
    });
  });
});
