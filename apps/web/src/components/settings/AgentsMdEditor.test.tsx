// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsMdEditor } from "./AgentsMdEditor";

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

describe("AgentsMdEditor", () => {
  it("loads existing AGENTS.md content into the textarea", async () => {
    recordingFetch((url) => {
      if (url === "/api/settings/agentsmd") {
        return jsonResponse({
          ok: true,
          data: { content: "# Hello agents", sha: "abc" },
        });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<AgentsMdEditor />);
    const textarea = (await screen.findByLabelText(/AGENTS\.md content/)) as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Hello agents");
  });

  it("save opens confirm dialog; confirming submits content with confirmed=true", async () => {
    const user = userEvent.setup();
    const { calls } = recordingFetch((url, init) => {
      if (url === "/api/settings/agentsmd" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ ok: true, data: { content: "old", sha: "abc" } });
      }
      if (url === "/api/settings/agentsmd" && init?.method === "PUT") {
        return jsonResponse({ ok: true, data: { saved: true, sha: "def" } });
      }
      return jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 500);
    });

    render(<AgentsMdEditor />);
    const textarea = (await screen.findByLabelText(/AGENTS\.md content/)) as HTMLTextAreaElement;
    expect(textarea.value).toBe("old");

    // Edit content.
    await user.clear(textarea);
    await user.type(textarea, "new content");
    expect(textarea.value).toBe("new content");

    // Click Save changes button (top-level, not the dialog one yet).
    const saveButtons = screen.getAllByRole("button", { name: /Save changes/ });
    await user.click(saveButtons[0]!);

    // Confirm dialog appears.
    expect(await screen.findByText(/Update AGENTS\.md\?/)).toBeInTheDocument();

    // Click Save changes inside the dialog (now there are two; pick the
    // visible one that's NOT the original — both render, so click the
    // last one which is the dialog button).
    const dialogSave = screen.getAllByRole("button", { name: /Save changes/ }).at(-1);
    expect(dialogSave).toBeDefined();
    await user.click(dialogSave!);

    await waitFor(() => {
      const putCall = calls.find(
        (c) => c.url === "/api/settings/agentsmd" && c.init?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      expect(putCall?.init?.body).toBe(JSON.stringify({ content: "new content", confirmed: true }));
    });
  });
});
