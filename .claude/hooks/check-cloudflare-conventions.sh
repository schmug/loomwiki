#!/bin/sh
# PreToolUse guard: blocks the two Cloudflare DO regressions CLAUDE.md warns
# about in prose ("regressed twice" failure mode) before they ever land in a
# file. Exit 2 = block; stderr is fed back to Claude so it can self-correct.
#
# Guards (see CLAUDE.md > Cloudflare conventions):
#   1. Legacy WS pattern   — ws.addEventListener('message'|'close', ...) in
#      worker code. Must use the Hibernation API instead.
#   2. Legacy DO storage   — ctx/state/this.storage.{put,get,delete,list}().
#      Must use ctx.storage.sql (SQLite) instead.
#
# This is intentionally narrow: it only fires on .ts/.tsx writes, scopes the
# WS check to apps/worker, and matches `.storage.` (not `.put(` broadly) so
# KV (env.CACHE) and R2 (env.ATTACHMENTS) calls are never false-positived.

# jq is required to parse the hook payload. If it's missing, degrade to a
# no-op (non-blocking) rather than spewing "jq: command not found" on every
# Edit/Write — a contributor without jq shouldn't be stonewalled by a guard.
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
case "$tool" in
  Edit | Write | MultiEdit) ;;
  *) exit 0 ;;
esac

path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
case "$path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

# Test code legitimately uses the patterns this hook forbids: WS *client*
# fixtures call ws.addEventListener (the Hibernation rule is about the DO
# *server*), and tests may stub storage. Skip them.
case "$path" in
  *__tests__* | *__fixtures__* | *.test.ts | *.test.tsx | *.spec.ts | *.spec.tsx) exit 0 ;;
esac

# New content across Write (.content), Edit (.new_string), MultiEdit (.edits[]).
content=$(printf '%s' "$input" | jq -r '
  [ .tool_input.content?,
    .tool_input.new_string?,
    ( .tool_input.edits[]?.new_string? )
  ] | map(select(. != null)) | join("\n")')

violations=""

case "$path" in
  *apps/worker*)
    if printf '%s' "$content" | grep -qE '\.addEventListener\(\s*["'\''](message|close)["'\'']'; then
      violations="${violations}
- Legacy WebSocket pattern: use the Hibernation API (ctx.acceptWebSocket(ws) + webSocketMessage() + webSocketClose()), not ws.addEventListener. See CLAUDE.md > Cloudflare conventions."
    fi
    ;;
esac

if printf '%s' "$content" | grep -qE '\.storage\.(put|get|delete|deleteAll|list)\('; then
  violations="${violations}
- Legacy Durable Object storage API: use ctx.storage.sql (SQLite-backed), not ctx.storage.put/get. See CLAUDE.md > Cloudflare conventions."
fi

if [ -n "$violations" ]; then
  printf 'Blocked: Cloudflare convention violation in %s%s\n' "$path" "$violations" >&2
  exit 2
fi

exit 0
