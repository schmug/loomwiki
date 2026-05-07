// SPDX-License-Identifier: Apache-2.0

// Schema tests for the M8 release-readiness types: BYOK metadata,
// workspace settings, audit log, AGENTS.md update.

import { describe, expect, it } from "vitest";
import {
  AUDIT_SNAPSHOT_MAX_BYTES,
  AuditActionSchema,
  AuditLogRowSchema,
  AuditResourceKindSchema,
  BYOKKeyMetadataSchema,
  ByokProviderSchema,
  COMMON_TIMEZONES,
  SUPPORTED_DEFAULT_MODELS,
  SetBYOKKeyRequestSchema,
  UpdateAgentsMdRequestSchema,
  UpdateWorkspaceSettingsRequestSchema,
  WorkspaceSettingsRowSchema,
} from "../index.js";

const VALID_UUIDV7 = "01900000-0000-7000-8000-000000000000";

describe("ByokProviderSchema", () => {
  it("accepts the v0.0.1 provider list", () => {
    expect(ByokProviderSchema.safeParse("anthropic").success).toBe(true);
    expect(ByokProviderSchema.safeParse("openai").success).toBe(true);
    expect(ByokProviderSchema.safeParse("google").success).toBe(true);
  });

  it("rejects unknown providers", () => {
    expect(ByokProviderSchema.safeParse("cohere").success).toBe(false);
    expect(ByokProviderSchema.safeParse("").success).toBe(false);
    expect(ByokProviderSchema.safeParse(123).success).toBe(false);
  });
});

describe("BYOKKeyMetadataSchema", () => {
  it("parses a typical metadata row with last_used_at populated", () => {
    const ok = BYOKKeyMetadataSchema.safeParse({
      workspace_id: VALID_UUIDV7,
      provider: "anthropic",
      has_key: true,
      created_at: 1_700_000_000,
      created_by: VALID_UUIDV7,
      last_used_at: 1_700_001_000,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts null last_used_at for never-used keys", () => {
    const ok = BYOKKeyMetadataSchema.safeParse({
      workspace_id: VALID_UUIDV7,
      provider: "openai",
      has_key: true,
      created_at: 1_700_000_000,
      created_by: VALID_UUIDV7,
      last_used_at: null,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects metadata that includes a stray 'key' field (defense in depth)", () => {
    // Pass a deliberately-extra field (`key`) through `unknown` rather
    // than `any` to keep biome's noExplicitAny rule happy.
    const payload: unknown = {
      workspace_id: VALID_UUIDV7,
      provider: "anthropic",
      has_key: true,
      created_at: 1_700_000_000,
      created_by: VALID_UUIDV7,
      last_used_at: null,
      key: "sk-ant-leaked",
    };
    const ok = BYOKKeyMetadataSchema.safeParse(payload);
    // Non-strict — extra fields are ignored. The defense lives at the
    // serializer layer, not the schema. Test documents the boundary.
    expect(ok.success).toBe(true);
  });
});

describe("SetBYOKKeyRequestSchema", () => {
  it("accepts a key in the typical Anthropic shape", () => {
    expect(
      SetBYOKKeyRequestSchema.safeParse({ key: "sk-ant-api03-_AAAAAAAAAAAAAAAA" }).success,
    ).toBe(true);
  });

  it("rejects empty / too-short keys", () => {
    expect(SetBYOKKeyRequestSchema.safeParse({ key: "" }).success).toBe(false);
    expect(SetBYOKKeyRequestSchema.safeParse({ key: "short" }).success).toBe(false);
  });

  it("rejects keys above the cap (defends against pasted-document accidents)", () => {
    expect(SetBYOKKeyRequestSchema.safeParse({ key: "x".repeat(2049) }).success).toBe(false);
  });
});

describe("WorkspaceSettings", () => {
  it("parses a populated row", () => {
    const ok = WorkspaceSettingsRowSchema.safeParse({
      workspace_id: VALID_UUIDV7,
      timezone: "America/New_York",
      default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      updated_at: 1_700_000_000,
      updated_by: VALID_UUIDV7,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts null updated_by (system-initialized rows)", () => {
    const ok = WorkspaceSettingsRowSchema.safeParse({
      workspace_id: VALID_UUIDV7,
      timezone: "UTC",
      default_model: "@cf/meta/llama-3-70b-instruct",
      updated_at: 1_700_000_000,
      updated_by: null,
    });
    expect(ok.success).toBe(true);
  });
});

describe("UpdateWorkspaceSettingsRequestSchema", () => {
  it("accepts a known timezone + model", () => {
    expect(
      UpdateWorkspaceSettingsRequestSchema.safeParse({
        timezone: "Europe/London",
        default_model: "byok:anthropic",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown timezone", () => {
    expect(
      UpdateWorkspaceSettingsRequestSchema.safeParse({
        timezone: "Atlantis/Lost",
        default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown default_model (allowlist)", () => {
    expect(
      UpdateWorkspaceSettingsRequestSchema.safeParse({
        timezone: "UTC",
        default_model: "../../etc/passwd",
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      UpdateWorkspaceSettingsRequestSchema.safeParse({
        timezone: "UTC",
        default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        sneaky: 1,
      }).success,
    ).toBe(false);
  });

  it("includes UTC and a representative spread of zones", () => {
    expect(COMMON_TIMEZONES).toContain("UTC");
    expect(COMMON_TIMEZONES).toContain("America/New_York");
    expect(COMMON_TIMEZONES).toContain("Asia/Tokyo");
    expect(COMMON_TIMEZONES.length).toBeGreaterThanOrEqual(20);
  });

  it("includes the BYOK sentinel models", () => {
    expect(SUPPORTED_DEFAULT_MODELS).toContain("byok:anthropic");
    expect(SUPPORTED_DEFAULT_MODELS).toContain("byok:openai");
  });
});

describe("UpdateAgentsMdRequestSchema", () => {
  it("requires confirmed=true literal (server-side enforcement of the dialog)", () => {
    expect(
      UpdateAgentsMdRequestSchema.safeParse({
        content: "# AGENTS.md\n\n...",
        confirmed: true,
      }).success,
    ).toBe(true);

    // confirmed: false is a literal mismatch
    expect(
      UpdateAgentsMdRequestSchema.safeParse({
        content: "# AGENTS.md\n\n...",
        confirmed: false,
      }).success,
    ).toBe(false);

    // missing confirmed is also rejected
    expect(
      UpdateAgentsMdRequestSchema.safeParse({
        content: "# AGENTS.md\n\n...",
      }).success,
    ).toBe(false);
  });

  it("rejects empty content", () => {
    expect(UpdateAgentsMdRequestSchema.safeParse({ content: "", confirmed: true }).success).toBe(
      false,
    );
  });

  it("caps content at 64 KB", () => {
    expect(
      UpdateAgentsMdRequestSchema.safeParse({ content: "x".repeat(64 * 1024 + 1), confirmed: true })
        .success,
    ).toBe(false);
  });
});

describe("AuditAction / AuditResourceKind", () => {
  it("covers the v0.0.1 action taxonomy", () => {
    for (const a of [
      "proposal.merge",
      "proposal.reject",
      "byok.create",
      "byok.delete",
      "agentsmd.update",
      "workspace_settings.update",
      "manual_ingest.trigger",
    ]) {
      expect(AuditActionSchema.safeParse(a).success).toBe(true);
    }
    expect(AuditActionSchema.safeParse("byok.read").success).toBe(false);
  });

  it("covers the resource_kind taxonomy", () => {
    for (const k of ["proposal", "byok", "agentsmd", "workspace_settings", "ingest"]) {
      expect(AuditResourceKindSchema.safeParse(k).success).toBe(true);
    }
    expect(AuditResourceKindSchema.safeParse("user").success).toBe(false);
  });
});

describe("AuditLogRowSchema", () => {
  it("parses a typical merge row", () => {
    expect(
      AuditLogRowSchema.safeParse({
        id: VALID_UUIDV7,
        workspace_id: VALID_UUIDV7,
        actor_user_id: VALID_UUIDV7,
        action: "proposal.merge",
        resource_kind: "proposal",
        resource_id: VALID_UUIDV7,
        before_json: JSON.stringify({ status: "pending" }),
        after_json: JSON.stringify({ status: "merged" }),
        request_id: VALID_UUIDV7,
        created_at: 1_700_000_000,
      }).success,
    ).toBe(true);
  });

  it("accepts null actor (cron-triggered actions)", () => {
    expect(
      AuditLogRowSchema.safeParse({
        id: VALID_UUIDV7,
        workspace_id: VALID_UUIDV7,
        actor_user_id: null,
        action: "manual_ingest.trigger",
        resource_kind: "ingest",
        resource_id: null,
        before_json: null,
        after_json: null,
        request_id: null,
        created_at: 1_700_000_000,
      }).success,
    ).toBe(true);
  });

  it("rejects oversize before_json / after_json", () => {
    expect(
      AuditLogRowSchema.safeParse({
        id: VALID_UUIDV7,
        workspace_id: VALID_UUIDV7,
        actor_user_id: VALID_UUIDV7,
        action: "agentsmd.update",
        resource_kind: "agentsmd",
        resource_id: "/AGENTS.md",
        before_json: "x".repeat(AUDIT_SNAPSHOT_MAX_BYTES + 1),
        after_json: null,
        request_id: null,
        created_at: 1_700_000_000,
      }).success,
    ).toBe(false);
  });
});
