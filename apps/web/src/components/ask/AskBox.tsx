// SPDX-License-Identifier: Apache-2.0

// The /ask surface — textarea on top, streamed answer + citations below,
// previous Q/A pairs above. State is in-memory only (per the M6 brief);
// reload clears history.
//
// The streaming answer renders through SanitizedMarkdown so the LLM
// can use markdown safely. Citations append once `onCitations` fires
// (always after the last token chunk). A 429 surfaces the
// RateLimitBanner with the typed `details` payload.

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SanitizedMarkdown } from "@/components/wiki/SanitizedMarkdown";
import { ApiError, AuthRequiredError } from "@/lib/api";
import { type AskStreamHandle, askStream } from "@/lib/api-ask";
import type { AskCitation, RateLimitDetails } from "@/lib/types";
import { Loader2, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RateLimitBanner } from "../RateLimitBanner";
import { CitationPill } from "./CitationPill";

interface AnswerTurn {
  id: string;
  question: string;
  answer: string;
  citations: AskCitation[];
  status: "streaming" | "done" | "error";
  error: string | null;
}

export function AskBox() {
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<AnswerTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [rateLimit, setRateLimit] = useState<RateLimitDetails | null>(null);
  const handleRef = useRef<AskStreamHandle | null>(null);
  const turnsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the answer pane on each new chunk so the user sees the
  // tail of the stream. We sum answer lengths so the effect re-fires on
  // every token append — depending on `turns.length` alone wouldn't catch
  // mid-stream growth.
  const scrollKey = turns.reduce((n, t) => n + t.answer.length, turns.length);
  useEffect(() => {
    // Read scrollKey to anchor the dependency in biome's analysis;
    // the value itself doesn't matter — the trigger does.
    void scrollKey;
    turnsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [scrollKey]);

  // Defensive: if the component unmounts mid-stream (e.g. SPA nav), abort
  // the fetch so we don't leak a reader.
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
    };
  }, []);

  function submit() {
    const question = draft.trim();
    if (question.length === 0 || streaming) return;
    setDraft("");
    setRateLimit(null);

    const turnId = crypto.randomUUID();
    const turn: AnswerTurn = {
      id: turnId,
      question,
      answer: "",
      citations: [],
      status: "streaming",
      error: null,
    };
    setTurns((prev) => [...prev, turn]);
    setStreaming(true);

    handleRef.current = askStream(question, {
      onDelta(text) {
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, answer: t.answer + text } : t)),
        );
      },
      onCitations(citations) {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, citations } : t)));
      },
      onDone() {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, status: "done" } : t)));
        setStreaming(false);
        handleRef.current = null;
      },
      onError(err) {
        if (err instanceof ApiError && err.code === "RATE_LIMITED") {
          const details = err.details as RateLimitDetails | undefined;
          if (details && typeof details.limit === "number") setRateLimit(details);
        }
        const message =
          err instanceof AuthRequiredError
            ? "You need to sign in again."
            : err instanceof ApiError && err.code === "RATE_LIMITED"
              ? "Daily ask limit reached."
              : err instanceof ApiError && err.code === "ABORTED"
                ? "Stopped."
                : err.message || "Ask failed.";
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, status: "error", error: message } : t)),
        );
        setStreaming(false);
        handleRef.current = null;
      },
    });
  }

  function stop() {
    handleRef.current?.abort();
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘+Enter / Ctrl+Enter to submit; plain Enter still inserts a newline.
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      submit();
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-hidden p-6">
      <div className="flex-1 space-y-6 overflow-y-auto pr-1" data-testid="ask-history">
        {turns.length === 0 && (
          <div className="rounded-md border border-dashed border-border bg-secondary/20 p-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Ask a question.</p>
            <p className="mt-1">
              Answers are grounded in your wiki. Citations link back to the source pages.
            </p>
          </div>
        )}
        {turns.map((turn) => (
          <article key={turn.id} className="space-y-3" data-testid="ask-turn">
            <div className="rounded-md bg-secondary/40 px-4 py-2 text-sm font-medium text-foreground">
              {turn.question}
            </div>
            {turn.status === "error" ? (
              <p className="text-sm text-destructive" role="alert">
                {turn.error}
              </p>
            ) : (
              <div className="space-y-3">
                <div data-testid="ask-answer">
                  {turn.answer.length > 0 ? (
                    <SanitizedMarkdown source={turn.answer} className="prose max-w-none" />
                  ) : (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Thinking…
                    </p>
                  )}
                </div>
                {turn.citations.length > 0 && (
                  <div className="flex flex-wrap gap-2" data-testid="ask-citations">
                    {turn.citations.map((c, i) => (
                      <CitationPill key={`${c.path}-${c.heading_slug ?? ""}-${i}`} citation={c} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </article>
        ))}
        <div ref={turnsEndRef} />
      </div>

      {rateLimit && <RateLimitBanner details={rateLimit} kind="ask" />}

      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          submit();
        }}
        className="space-y-2"
      >
        <Textarea
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything about your wiki…  (⌘+Enter to send)"
          rows={3}
          disabled={streaming}
          data-testid="ask-input"
        />
        <div className="flex items-center justify-end gap-2">
          {streaming ? (
            <Button type="button" variant="outline" onClick={stop} data-testid="ask-stop">
              <Square className="size-3" />
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={draft.trim().length === 0} data-testid="ask-submit">
              <Send className="size-3" />
              Ask
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
