// SPDX-License-Identifier: Apache-2.0

// shadcn's `cn()` helper. clsx flattens conditional class lists; tailwind-merge
// resolves last-wins conflicts (e.g. `px-2 px-4` → `px-4`). Single source of
// truth for combining className lists across the app.

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
