// SPDX-License-Identifier: Apache-2.0

// Serialize, deserialize, and validate wiki page content.
//
// Wire format on disk: a YAML frontmatter block followed by the
// markdown body, separated by `---` fences (gray-matter's default).
// The frontmatter shape is enforced by `WikiPageFrontmatterSchema`
// (packages/schema). The body is plain markdown that goes through the
// shared sanitizer pipeline (`@loomwiki/shared`'s renderMarkdown).
//
// Validation is staged to keep error messages informative:
//   1. path  — caught at the route layer before this module ever sees
//              a payload (via validateWikiPath).
//   2. body length — cheap byte-cap check (64 KB).
//   3. frontmatter — Zod parse with strict shape.
//   4. render-pass — non-empty body that sanitizes to empty string is
//      rejected as "would render blank" — typically a body that is
//      *only* a script tag or a forbidden HTML block. An empty body
//      (stub page) is allowed.

import { WIKI_BODY_MAX_BYTES, type WikiPageFrontmatter } from "@loomwiki/schema";
import { parseWikiFrontmatter } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, renderMarkdown } from "@loomwiki/shared";
import matter from "gray-matter";

/**
 * gray-matter parses YAML date scalars (`2026-05-04`) into JS Date
 * instances by default. Our frontmatter schema requires those fields
 * to be ISO-8601 strings. Walk the parsed object and convert any Date
 * values back to YYYY-MM-DD strings.
 */
function coerceYamlDates(obj: unknown): unknown {
  if (obj instanceof Date) {
    return obj.toISOString().slice(0, 10);
  }
  if (Array.isArray(obj)) return obj.map(coerceYamlDates);
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = coerceYamlDates(v);
    return out;
  }
  return obj;
}

/** Encoded SHA prefix in KV metadata so a stored row carries its own hash. */
export interface SerializedPage {
  /** Full file contents (frontmatter + body) as written to KV/git. */
  raw: string;
  /** SHA-256 of `raw`, hex-lowercase. The optimistic-locking token. */
  sha: string;
}

export interface DeserializedPage {
  frontmatter: WikiPageFrontmatter;
  body: string;
  sha: string;
  raw: string;
}

/**
 * Serialize a frontmatter + body pair to the on-disk format. Uses
 * gray-matter for the YAML stringify so round-tripping with parse()
 * produces identical output for the same logical content.
 */
export async function serializePage(
  frontmatter: WikiPageFrontmatter,
  body: string,
): Promise<SerializedPage> {
  // gray-matter.stringify expects (content, data, options).
  const raw = matter.stringify(body.trimStart(), frontmatter as unknown as Record<string, unknown>);
  const sha = await sha256Hex(raw);
  return { raw, sha };
}

/**
 * Parse a stored page. Throws LoomwikiError("VALIDATION_FAILED") if the
 * frontmatter doesn't conform — this protects route consumers from a
 * vault edited externally with bad YAML.
 */
export async function deserializePage(raw: string): Promise<DeserializedPage> {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (cause) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Failed to parse YAML frontmatter", {
      status: 400,
      cause,
    });
  }
  const frontmatter = parseWikiFrontmatter(coerceYamlDates(parsed.data));
  // gray-matter strips one leading newline after the closing fence;
  // trimStart() makes round-tripping byte-stable for our serializer.
  const body = parsed.content.replace(/^\n/, "");
  const sha = await sha256Hex(raw);
  return { frontmatter, body, sha, raw };
}

/**
 * Validate a page payload before write. Throws on any failure with
 * code VALIDATION_FAILED so the route layer maps to 400.
 */
export function validatePagePayload(input: { frontmatter: unknown; body: string }): {
  frontmatter: WikiPageFrontmatter;
  body: string;
} {
  if (typeof input.body !== "string") {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "body must be a string", { status: 400 });
  }
  const byteLen = utf8ByteLength(input.body);
  if (byteLen > WIKI_BODY_MAX_BYTES) {
    throw new LoomwikiError(
      ErrorCodes.VALIDATION_FAILED,
      `body exceeds ${WIKI_BODY_MAX_BYTES} bytes (${byteLen} bytes provided)`,
      { status: 400 },
    );
  }
  const frontmatter = parseWikiFrontmatter(input.frontmatter);

  // Render-pass guard: catch a body that isn't empty but produces empty
  // sanitized HTML. Stub pages (empty body) are legitimate per
  // vault-template/AGENTS.md §4.1 ("Stub is fine"); we explicitly allow
  // those by skipping the render check when body has no markdown content.
  const trimmed = input.body.trim();
  if (trimmed.length > 0) {
    let html = "";
    try {
      html = renderMarkdown(trimmed);
    } catch (cause) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        "body could not be rendered as markdown",
        { status: 400, cause },
      );
    }
    if (html.replace(/\s/g, "") === "") {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        "body would render as blank HTML after sanitization (likely contains only stripped tags)",
        { status: 400 },
      );
    }
  }

  return { frontmatter, body: input.body };
}

function utf8ByteLength(s: string): number {
  // TextEncoder is a Web standard; available in workerd and node 22+.
  return new TextEncoder().encode(s).byteLength;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}
