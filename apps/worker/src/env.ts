// SPDX-License-Identifier: Apache-2.0

// Mirrors the bindings declared in wrangler.jsonc (SPEC §5). Update both together.
//
// Most bindings are declared but not consumed in M0 — the typed shape exists so
// later milestones can import a stable Env without churn.

import type {
  AnalyticsEngineDataset,
  D1Database,
  DurableObjectNamespace,
  Fetcher,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";

export interface VersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export interface Env {
  // Durable Objects
  CHAT_ROOM: DurableObjectNamespace;

  // Storage
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  CACHE: KVNamespace;

  // AI
  AI: Fetcher;

  // Version metadata (populated by CF in production deploys; may be undefined in dev)
  CF_VERSION_METADATA?: VersionMetadata;

  // Analytics (placeholder for M8)
  ANALYTICS?: AnalyticsEngineDataset;

  // Vars
  WORKSPACE_NAME: string;
  DEFAULT_LLM_MODEL: string;
  EMBEDDING_MODEL: string;
  ARTIFACTS_REPO: string;
  AI_SEARCH_INSTANCE: string;
  GIT_COMMIT?: string;

  // Secrets — undefined locally unless set via .dev.vars
  SENTRY_DSN?: string;
  BYOK_ENCRYPTION_KEY?: string;
  ARTIFACTS_TOKEN?: string;
  AI_GATEWAY_TOKEN?: string;
}
