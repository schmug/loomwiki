// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSettings } from "./WorkspaceSettings";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("WorkspaceSettings", () => {
  it("loads existing settings, lets the user change timezone, and saves", async () => {
    const user = userEvent.setup();
    const { calls } = recordingFetch((url, init) => {
      if (url === "/api/settings/workspace" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          ok: true,
          data: {
            settings: {
              workspace_id: "ws",
              timezone: "UTC",
              default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
              updated_at: 1_700_000_000,
              updated_by: "u1",
            },
          },
        });
      }
      if (url === "/api/settings/byok") {
        return jsonResponse({ ok: true, data: { keys: [] } });
      }
      if (url === "/api/settings/workspace" && init?.method === "PUT") {
        return jsonResponse({
          ok: true,
          data: {
            settings: {
              workspace_id: "ws",
              timezone: "America/Los_Angeles",
              default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
              updated_at: 1_700_000_999,
              updated_by: "u1",
            },
          },
        });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<WorkspaceSettings />);

    const tzSelect = (await screen.findByLabelText(/Timezone/)) as HTMLSelectElement;
    await waitFor(() => {
      expect(tzSelect.value).toBe("UTC");
    });

    await user.selectOptions(tzSelect, "America/Los_Angeles");
    expect(tzSelect.value).toBe("America/Los_Angeles");

    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const putCall = calls.find(
        (c) => c.url === "/api/settings/workspace" && c.init?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      expect(putCall?.init?.body).toBe(
        JSON.stringify({
          timezone: "America/Los_Angeles",
          default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        }),
      );
    });
  });

  it("disables byok:* options when the matching key is not configured", async () => {
    recordingFetch((url) => {
      if (url === "/api/settings/workspace") {
        return jsonResponse({
          ok: true,
          data: {
            settings: {
              workspace_id: "ws",
              timezone: "UTC",
              default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
              updated_at: 1_700_000_000,
              updated_by: "u1",
            },
          },
        });
      }
      if (url === "/api/settings/byok") {
        return jsonResponse({
          ok: true,
          data: {
            keys: [
              {
                workspace_id: "ws",
                provider: "anthropic",
                has_key: true,
                created_at: 1_700_000_000,
                created_by: "u1",
                last_used_at: null,
              },
            ],
          },
        });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<WorkspaceSettings />);
    const select = (await screen.findByLabelText(/Default model/)) as HTMLSelectElement;

    await waitFor(() => {
      const anthropicOption = Array.from(select.options).find((o) => o.value === "byok:anthropic");
      expect(anthropicOption?.disabled).toBe(false);
    });

    const openaiOption = Array.from(select.options).find((o) => o.value === "byok:openai");
    expect(openaiOption?.disabled).toBe(true);
  });
});
