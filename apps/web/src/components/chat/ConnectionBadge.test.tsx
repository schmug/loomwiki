// SPDX-License-Identifier: Apache-2.0

// ConnectionBadge — a11y baseline plus copy-mapping smoke.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionBadge } from "./ConnectionBadge";

describe("ConnectionBadge", () => {
  it.each([
    ["connected", "Connected"],
    ["connecting", "Connecting…"],
    ["reconnecting", "Reconnecting…"],
    ["disconnected", "Disconnected"],
  ] as const)("renders %s state with the right copy", (status, copy) => {
    render(<ConnectionBadge status={status} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("uses an output element with aria-live=polite for screen readers", () => {
    const { container } = render(<ConnectionBadge status="connected" />);
    const output = container.querySelector("output");
    expect(output).not.toBeNull();
    expect(output?.getAttribute("aria-live")).toBe("polite");
  });
});
