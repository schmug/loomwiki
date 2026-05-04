// SPDX-License-Identifier: Apache-2.0

// Page-level wrapper for AskBox. Sits in the AppShell main slot.

import { AskBox } from "./AskBox";

export function AskPage() {
  return (
    <div className="flex h-full flex-col">
      <AskBox />
    </div>
  );
}
