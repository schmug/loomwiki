// SPDX-License-Identifier: Apache-2.0

// Vitest setup file. Pulls in jest-dom matchers (toBeInTheDocument,
// toHaveTextContent, ...) for component tests, and unmounts every
// React tree between tests so DOM lookups don't bleed across cases.
// (Auto-cleanup only fires when vitest's `globals: true` is on, and
// we keep that off to avoid polluting the test scope.)

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
