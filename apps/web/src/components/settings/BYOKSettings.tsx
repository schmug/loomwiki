// SPDX-License-Identifier: Apache-2.0

// BYOK key management. v0.0.1 surfaces Anthropic + OpenAI; Google is
// deferred until the agent supports a Google provider end-to-end.
//
// Security invariants enforced here:
//   - Plaintext key only travels client → worker on PUT. The worker
//     returns metadata only.
//   - The textarea is cleared on save success so the typed key is never
//     re-rendered on the screen after submit.
//   - Cancel also clears the textarea (don't leave a key sitting in
//     state when the user backs out).
//   - GET /api/settings/byok never returns plaintext, so the row's
//     "Configured" state is purely metadata.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import {
  type BYOKKeyMetadata,
  type BYOKProvider,
  deleteBYOK,
  listBYOK,
  setBYOK,
} from "@/lib/api-settings";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const VISIBLE_PROVIDERS: BYOKProvider[] = ["anthropic", "openai"];

const PROVIDER_LABEL: Record<BYOKProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google (Gemini)",
};

export function BYOKSettings() {
  const [keys, setKeys] = useState<BYOKKeyMetadata[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BYOKProvider | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [savedBanner, setSavedBanner] = useState<BYOKProvider | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<BYOKProvider | null>(null);

  useEffect(() => {
    let cancelled = false;
    listBYOK()
      .then((data) => {
        if (cancelled) return;
        setKeys(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load BYOK keys");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function metaFor(provider: BYOKProvider): BYOKKeyMetadata | undefined {
    return keys?.find((k) => k.provider === provider);
  }

  async function handleSave(provider: BYOKProvider): Promise<void> {
    const trimmed = keyInput.trim();
    if (trimmed.length === 0) {
      toast.error("Key is required");
      return;
    }
    setSubmitting(true);
    try {
      const meta = await setBYOK(provider, trimmed);
      // Defensive: clear the input BEFORE updating any state that could
      // re-render the typed key. The metadata response from the worker
      // intentionally has no `key` field.
      setKeyInput("");
      setEditing(null);
      setKeys((prev) => {
        const next = (prev ?? []).filter((k) => k.provider !== provider);
        next.push(meta);
        return next;
      });
      setSavedBanner(provider);
      toast.success(`${PROVIDER_LABEL[provider]} key saved`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save key";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel(): void {
    // Always clear the typed key on cancel so it never sits in
    // component state.
    setKeyInput("");
    setEditing(null);
  }

  async function handleRemove(provider: BYOKProvider): Promise<void> {
    setSubmitting(true);
    try {
      await deleteBYOK(provider);
      setKeys((prev) => (prev ?? []).filter((k) => k.provider !== provider));
      setConfirmingRemove(null);
      toast.success(`${PROVIDER_LABEL[provider]} key removed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to remove key";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="p-6 text-sm text-destructive" role="alert">
        Failed to load BYOK keys: {loadError}
      </div>
    );
  }

  if (keys === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground" aria-busy="true">
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">BYOK keys</h1>
        <p className="text-sm text-muted-foreground">
          Bring your own API keys for premium models. Keys are encrypted at rest with an
          envelope-encryption scheme and only decrypted inside the agent worker.
        </p>
      </header>

      <ul className="divide-y divide-border rounded-md border border-border">
        {VISIBLE_PROVIDERS.map((provider) => {
          const meta = metaFor(provider);
          const isEditing = editing === provider;
          const isSavedBanner = savedBanner === provider;
          return (
            <li key={provider} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{PROVIDER_LABEL[provider]}</p>
                  <p className="text-xs text-muted-foreground">
                    Configured: {meta ? "yes" : "no"}
                    {meta && (
                      <>
                        <span className="mx-2">·</span>
                        Created: {formatRelative(meta.created_at)}
                        <span className="mx-2">·</span>
                        Last used: {meta.last_used_at ? formatRelative(meta.last_used_at) : "never"}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {!isEditing && (
                    <Button
                      type="button"
                      size="sm"
                      variant={meta ? "outline" : "default"}
                      onClick={() => {
                        setSavedBanner(null);
                        setEditing(provider);
                      }}
                    >
                      {meta ? "Replace key" : "Add key"}
                    </Button>
                  )}
                  {meta && !isEditing && (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => setConfirmingRemove(provider)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>

              {isSavedBanner && (
                <output className="block rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs dark:border-emerald-700/50 dark:bg-emerald-950/30">
                  Saved. The key is encrypted at rest. We will never display it again.
                </output>
              )}

              {isEditing && (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSave(provider);
                  }}
                >
                  <label
                    htmlFor={`byok-${provider}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Paste API key
                  </label>
                  <Textarea
                    id={`byok-${provider}`}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder={
                      provider === "anthropic" ? "sk-ant-…" : provider === "openai" ? "sk-…" : ""
                    }
                  />
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={submitting || keyInput.trim().length === 0}
                    >
                      {submitting ? "Saving…" : "Save"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={handleCancel}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={confirmingRemove !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmingRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove the {confirmingRemove ? PROVIDER_LABEL[confirmingRemove] : ""} key?
            </DialogTitle>
            <DialogDescription>
              The agent will fall back to the default workspace model after this is removed. You can
              paste a new key any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmingRemove(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={submitting}
              onClick={() => {
                if (confirmingRemove) void handleRemove(confirmingRemove);
              }}
            >
              {submitting ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster />
    </div>
  );
}

function formatRelative(epochSec: number): string {
  const then = epochSec * 1000;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
