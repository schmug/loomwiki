// SPDX-License-Identifier: Apache-2.0

// Scheduled-actions settings surface. Members can view, create, pause/resume,
// and delete scheduled prompts for rooms they belong to.
//
// Design decisions (SPEC §20 / issue #33):
//   - Q-sched-4: 50 active/workspace, 10 active/room (enforced server-side)
//   - Q-sched-6: created_by or workspace owner may pause/edit/delete

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { apiDelete, apiGet, apiPost, request } from "@/lib/api";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface Room {
  id: string;
  slug: string;
  name: string;
  workspace_id: string;
  topic: string | null;
  created_by: string;
  created_at: string;
}

interface ScheduledAction {
  id: string;
  workspace_id: string;
  room_id: string;
  created_by: string;
  kind: "cron" | "once";
  cron_expr: string | null;
  fire_at: number | null;
  prompt: string;
  status: "active" | "paused" | "fired" | "failed";
  failure_count: number;
  last_fired_at: number | null;
  next_fire_at: number;
  created_at: number;
  updated_at: number;
}

interface ScheduledActionsSettingsProps {
  userId: string;
  isOwner: boolean;
}

function epochToLocal(epochS: number): string {
  return new Date(epochS * 1000).toLocaleString();
}

function canModify(action: ScheduledAction, userId: string, isOwner: boolean): boolean {
  return action.created_by === userId || isOwner;
}

export function ScheduledActionsSettings({ userId, isOwner }: ScheduledActionsSettingsProps) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");
  const [actions, setActions] = useState<ScheduledAction[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [createKind, setCreateKind] = useState<"cron" | "once">("cron");
  const [createCronExpr, setCreateCronExpr] = useState("0 9 * * 1-5");
  const [createFireAt, setCreateFireAt] = useState("");
  const [createPrompt, setCreatePrompt] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ workspace: { id: string } }>("/api/me")
      .then((me) => {
        if (cancelled) return;
        return apiGet<{ rooms: Room[] }>(`/api/workspaces/${me.workspace.id}/rooms`);
      })
      .then((data) => {
        if (cancelled || !data) return;
        setRooms(data.rooms);
        if (data.rooms.length > 0 && data.rooms[0]) {
          setSelectedRoomId(data.rooms[0].id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load rooms");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedRoomId) return;
    let cancelled = false;
    setLoading(true);
    apiGet<{ actions: ScheduledAction[]; hasMore: boolean }>(
      `/api/rooms/${selectedRoomId}/scheduled-actions`,
    )
      .then((data) => {
        if (cancelled) return;
        setActions(data.actions);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : "Failed to load scheduled actions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoomId]);

  async function handleCreate(): Promise<void> {
    if (!selectedRoomId) return;
    setCreating(true);
    try {
      let body: Record<string, unknown>;
      if (createKind === "cron") {
        body = { kind: "cron", cron_expr: createCronExpr, prompt: createPrompt };
      } else {
        const fireAtS = Math.floor(new Date(createFireAt).getTime() / 1000);
        if (Number.isNaN(fireAtS)) {
          toast.error("Invalid date/time for one-time action");
          return;
        }
        body = { kind: "once", fire_at: fireAtS, prompt: createPrompt };
      }

      const data = await apiPost<{ action: ScheduledAction }>(
        `/api/rooms/${selectedRoomId}/scheduled-actions`,
        body,
      );
      setActions((prev) => [...prev, data.action]);
      setShowCreate(false);
      setCreatePrompt("");
      toast.success("Scheduled action created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create scheduled action");
    } finally {
      setCreating(false);
    }
  }

  async function handleTogglePause(action: ScheduledAction): Promise<void> {
    const newStatus = action.status === "paused" ? "active" : "paused";
    try {
      const data = await request<{ action: ScheduledAction }>(
        `/api/rooms/${selectedRoomId}/scheduled-actions/${action.id}`,
        { method: "PATCH", body: { status: newStatus } },
      );
      setActions((prev) => prev.map((a) => (a.id === action.id ? data.action : a)));
      toast.success(newStatus === "paused" ? "Paused" : "Resumed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update action");
    }
  }

  async function handleDelete(actionId: string): Promise<void> {
    if (!confirm("Delete this scheduled action?")) return;
    try {
      await apiDelete(`/api/rooms/${selectedRoomId}/scheduled-actions/${actionId}`);
      setActions((prev) => prev.filter((a) => a.id !== actionId));
      toast.success("Deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete action");
    }
  }

  if (loadError) {
    return (
      <div className="p-6 text-sm text-destructive" role="alert">
        Failed to load: {loadError}
      </div>
    );
  }

  if (rooms === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground" aria-busy="true">
        Loading…
      </div>
    );
  }

  if (rooms.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No rooms yet. Create a room first, then add scheduled prompts.
      </div>
    );
  }

  const statusBadge = (s: ScheduledAction["status"]) => {
    const classes: Record<ScheduledAction["status"], string> = {
      active: "bg-green-100 text-green-800",
      paused: "bg-yellow-100 text-yellow-800",
      fired: "bg-blue-100 text-blue-800",
      failed: "bg-red-100 text-red-800",
    };
    return (
      <span
        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${classes[s]}`}
      >
        {s}
      </span>
    );
  };

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Scheduled Prompts</h1>
        <p className="text-sm text-muted-foreground">
          Automated prompts that post into a room on a cron schedule or once at a future time.
          Limit: 50 active per workspace, 10 per room.
        </p>
      </header>

      {/* Room selector */}
      <div className="space-y-1">
        <label htmlFor="room-select" className="text-sm font-medium">
          Room
        </label>
        <select
          id="room-select"
          value={selectedRoomId}
          onChange={(e) => setSelectedRoomId(e.target.value)}
          className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
        >
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.slug} — {r.name}
            </option>
          ))}
        </select>
      </div>

      {/* Action list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scheduled actions for this room yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border">
          {actions.map((action) => (
            <li key={action.id} className="flex flex-col gap-1 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    {statusBadge(action.status)}
                    <span className="text-xs text-muted-foreground">
                      {action.kind === "cron"
                        ? `cron: ${action.cron_expr}`
                        : `once: ${action.fire_at ? epochToLocal(action.fire_at) : "—"}`}
                    </span>
                  </div>
                  <p className="truncate text-sm font-medium">{action.prompt}</p>
                  <p className="text-xs text-muted-foreground">
                    Next fire: {epochToLocal(action.next_fire_at)}
                    {action.last_fired_at !== null
                      ? ` · Last fired: ${epochToLocal(action.last_fired_at)}`
                      : ""}
                    {action.failure_count > 0 ? ` · Failures: ${action.failure_count}` : ""}
                  </p>
                </div>
                {canModify(action, userId, isOwner) && (
                  <div className="flex shrink-0 gap-2">
                    {(action.status === "active" || action.status === "paused") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleTogglePause(action)}
                      >
                        {action.status === "paused" ? "Resume" : "Pause"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void handleDelete(action.id)}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Create form */}
      {showCreate ? (
        <div className="rounded-md border p-4">
          <h2 className="mb-4 text-sm font-semibold">New Scheduled Action</h2>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Kind</legend>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="kind"
                    value="cron"
                    checked={createKind === "cron"}
                    onChange={() => setCreateKind("cron")}
                  />
                  Recurring (cron)
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="kind"
                    value="once"
                    checked={createKind === "once"}
                    onChange={() => setCreateKind("once")}
                  />
                  Once
                </label>
              </div>
            </fieldset>

            {createKind === "cron" ? (
              <div className="space-y-1">
                <label htmlFor="cron-expr" className="text-sm font-medium">
                  Cron expression
                </label>
                <Input
                  id="cron-expr"
                  value={createCronExpr}
                  onChange={(e) => setCreateCronExpr(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Five-field POSIX cron (UTC). Example: 0 9 * * 1-5 = weekdays 09:00 UTC.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <label htmlFor="fire-at" className="text-sm font-medium">
                  Fire at (UTC)
                </label>
                <Input
                  id="fire-at"
                  type="datetime-local"
                  value={createFireAt}
                  onChange={(e) => setCreateFireAt(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Date and time (your local timezone — converted to UTC server-side).
                </p>
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="prompt" className="text-sm font-medium">
                Prompt
              </label>
              <Textarea
                id="prompt"
                value={createPrompt}
                onChange={(e) => setCreatePrompt(e.target.value)}
                placeholder="Post a daily standup reminder…"
                maxLength={4096}
                rows={3}
                required
              />
              <p className="text-xs text-muted-foreground">
                The message text posted into the room. Max 4096 characters.
              </p>
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <Button onClick={() => setShowCreate(true)}>New scheduled action</Button>
      )}

      <Toaster />
    </div>
  );
}
