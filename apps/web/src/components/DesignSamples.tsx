// SPDX-License-Identifier: Apache-2.0

// Single React component that composes every M3 primitive in one tree.
// Lives as a React component (not split across .astro and .jsx) because
// Radix UI primitives use React context that does NOT cross the
// .astro/.jsx boundary in Astro SSR — Avatar/AvatarFallback, Dialog,
// Tooltip, etc. must share a single React tree.
//
// Used by /design only. Not shipped in production routes.

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export interface DesignSamplesProps {
  mode: "light" | "dark";
}

export function DesignSamples({ mode }: DesignSamplesProps) {
  return (
    <div className="space-y-6 rounded-lg border border-border bg-background p-6 text-foreground">
      <h2 className="text-lg font-medium uppercase tracking-wide text-muted-foreground">{mode}</h2>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Buttons</p>
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="accent">Accent</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
        </div>
      </section>

      <Separator />

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Inputs</p>
        <Input placeholder="Single-line input" />
        <Textarea placeholder="Multi-line textarea" rows={3} />
      </section>

      <Separator />

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Avatar &amp; skeleton</p>
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>L</AvatarFallback>
          </Avatar>
          <Skeleton className="h-9 w-32" />
        </div>
      </section>
    </div>
  );
}
