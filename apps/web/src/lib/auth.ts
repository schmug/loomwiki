// SPDX-License-Identifier: Apache-2.0

// React hook around GET /api/me. Returns the current user, workspace,
// and rooms list. JIT user creation happens server-side (M1) so the
// first call after a fresh Access login bootstraps the user row.
//
// On 401 (auth required): the hook surfaces an `error` of
// AuthRequiredError and the AppShell-level error boundary handles the
// Access redirect. We do NOT auto-redirect from inside the hook —
// surface the error and let the page chrome decide.

import { useEffect, useState } from "react";
import { type AuthRequiredError, apiGet } from "./api";
import type { CurrentUserPayload } from "./types";

export interface UseCurrentUserState {
  ready: boolean;
  data: CurrentUserPayload | null;
  error: Error | AuthRequiredError | null;
}

export function useCurrentUser(): UseCurrentUserState {
  const [state, setState] = useState<UseCurrentUserState>({
    ready: false,
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    apiGet<CurrentUserPayload>("/api/me")
      .then((data) => {
        if (cancelled) return;
        setState({ ready: true, data, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ ready: true, data: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
