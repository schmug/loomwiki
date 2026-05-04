// SPDX-License-Identifier: Apache-2.0

// Modal for creating a new room. Hits POST /api/workspaces/:wid/rooms.
// Slug is derived from the name on first edit unless the user
// explicitly typed one; once the user touches the slug field, we stop
// auto-deriving (resolved-decisions standard pattern).

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiPost } from "@/lib/api";
import type { CreateRoomRequest, SerializedRoom } from "@/lib/types";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

export interface CreateRoomDialogProps {
  workspaceId: string;
  onCreated: (room: SerializedRoom) => void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function CreateRoomDialog({ workspaceId, onCreated }: CreateRoomDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const canSubmit =
    name.trim().length > 0 && /^[a-z][a-z0-9-]{0,59}$/.test(effectiveSlug) && !submitting;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body: CreateRoomRequest = { slug: effectiveSlug, name: name.trim() };
      if (topic.trim().length > 0) body.topic = topic.trim();
      const data = await apiPost<{ room: SerializedRoom }>(
        `/api/workspaces/${workspaceId}/rooms`,
        body,
      );
      onCreated(data.room);
      reset();
      setOpen(false);
      toast.success(`Room #${data.room.slug} created`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT") {
        toast.error(`Slug "${effectiveSlug}" is already taken in this workspace.`);
      } else {
        const msg = err instanceof Error ? err.message : "Could not create room";
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function reset(): void {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setTopic("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start">
          <Plus className="size-4" />
          Create room
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a room</DialogTitle>
          <DialogDescription>
            Rooms are chat channels. Slugs are unique within a workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="room-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="room-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="General"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="room-slug" className="text-sm font-medium">
              Slug
            </label>
            <Input
              id="room-slug"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="general"
              pattern="^[a-z][a-z0-9-]{0,59}$"
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits, dashes. Used in URLs (e.g. /r/{effectiveSlug || "…"}).
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="room-topic" className="text-sm font-medium">
              Topic <span className="text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="room-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What's this room for?"
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Creating…" : "Create room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
