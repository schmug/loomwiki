// SPDX-License-Identifier: Apache-2.0
// Adapted from shadcn/ui (MIT).

import { cn } from "@/lib/utils";
import type * as React from "react";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
