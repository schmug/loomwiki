// SPDX-License-Identifier: Apache-2.0

// Workspace-wide preferences. v0.0.1 surfaces:
//   - timezone (used to render the daily digest cutoff in the operator's
//     local time and the ingest cron schedule explanation).
//   - default_model (the workspace fallback when a user hasn't set their
//     own per-tab override). byok:* options are gated on the matching
//     BYOK key existing — listBYOK() is used purely to decide which
//     options are selectable.

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import {
  type BYOKKeyMetadata,
  type WorkspaceSettings as WorkspaceSettingsT,
  getWorkspaceSettings,
  listBYOK,
  setWorkspaceSettings,
} from "@/lib/api-settings";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Helsinki",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Karachi",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Manila",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

const MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3-70b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "byok:anthropic",
  "byok:openai",
] as const;

const MODEL_LABEL: Record<(typeof MODELS)[number], string> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B (Workers AI, fast)",
  "@cf/meta/llama-3-70b-instruct": "Llama 3 70B (Workers AI)",
  "@cf/meta/llama-3.1-8b-instruct-fast": "Llama 3.1 8B (Workers AI, fast)",
  "byok:anthropic": "BYOK — Anthropic",
  "byok:openai": "BYOK — OpenAI",
};

export function WorkspaceSettings() {
  const [settings, setSettings] = useState<WorkspaceSettingsT | null>(null);
  const [keys, setKeys] = useState<BYOKKeyMetadata[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string>("UTC");
  const [defaultModel, setDefaultModel] = useState<string>(MODELS[0]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getWorkspaceSettings(), listBYOK()])
      .then(([s, k]) => {
        if (cancelled) return;
        setSettings(s);
        setKeys(k);
        setTimezone(s.timezone);
        setDefaultModel(s.default_model);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load workspace settings");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byokConfigured = useMemo(() => {
    const set = new Set<string>();
    for (const k of keys ?? []) set.add(k.provider);
    return set;
  }, [keys]);

  function isModelDisabled(model: string): boolean {
    if (model === "byok:anthropic") return !byokConfigured.has("anthropic");
    if (model === "byok:openai") return !byokConfigured.has("openai");
    return false;
  }

  async function handleSave(): Promise<void> {
    setSubmitting(true);
    try {
      const updated = await setWorkspaceSettings({ timezone, default_model: defaultModel });
      setSettings(updated);
      toast.success("Workspace settings saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save workspace settings";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="p-6 text-sm text-destructive" role="alert">
        Failed to load workspace settings: {loadError}
      </div>
    );
  }

  if (settings === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground" aria-busy="true">
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Workspace</h1>
        <p className="text-sm text-muted-foreground">
          Workspace-wide defaults. Affects all members until overridden per-tab.
        </p>
      </header>

      <form
        className="max-w-md space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <div className="space-y-1">
          <label htmlFor="ws-timezone" className="text-sm font-medium">
            Timezone
          </label>
          <select
            id="ws-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Used for the daily-digest schedule and any human-readable times in the wiki UI.
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="ws-default-model" className="text-sm font-medium">
            Default model
          </label>
          <select
            id="ws-default-model"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
          >
            {MODELS.map((m) => {
              const disabled = isModelDisabled(m);
              return (
                <option key={m} value={m} disabled={disabled}>
                  {MODEL_LABEL[m]}
                  {disabled ? " — set BYOK key first" : ""}
                </option>
              );
            })}
          </select>
          <p className="text-xs text-muted-foreground">
            BYOK options are disabled until the matching key is configured.
          </p>
        </div>

        <div>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>

      <Toaster />
    </div>
  );
}
