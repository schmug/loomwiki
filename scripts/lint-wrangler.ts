// SPDX-License-Identifier: Apache-2.0
//
// Lints the two wrangler.jsonc files in this repo for the categories of
// foot-guns PR #24 ran into during the cortech.online dogfood deploy:
//
//   1. `<TBD>` placeholder strings left in the file (you forgot to swap in
//      the real D1 / KV id after `wrangler ... create`).
//   2. `d1_databases` / `kv_namespaces` entries with an empty or missing id
//      (would deploy successfully then 500 on first request).
//   3. Comment-disabled binding blocks (e.g., `// "ai_search":`) lacking any
//      re-enable instructions nearby — operators inheriting the repo would
//      have no idea why a binding is off or how to flip it back on.
//
// Runs on the current repo and is expected to PASS — i.e. PR #24 already
// fixed the historical regressions. If this script ever fails on `main`,
// either the script has a bug or a regression slipped through.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const TARGETS = [
  resolve(REPO_ROOT, "wrangler.jsonc"),
  resolve(REPO_ROOT, "apps/web/wrangler.jsonc"),
];

// Known binding keys that, when found in a `// "<key>":` comment, mark the
// start of a comment-disabled binding block. This is intentionally narrow
// to avoid matching arbitrary commented prose.
const KNOWN_BINDING_KEYS = [
  "ai_search",
  "artifacts",
  "d1_databases",
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "services",
  "vectorize",
  "queues",
  "hyperdrive",
  "ai",
];

const REENABLE_PHRASES = ["uncomment", "re-enable", "to enable"];

interface LintFailure {
  file: string;
  message: string;
}

const failures: LintFailure[] = [];

function logCheck(file: string, name: string, ok: boolean, detail?: string): void {
  const tag = ok ? "PASS" : "FAIL";
  const suffix = detail !== undefined && detail !== "" ? ` — ${detail}` : "";
  console.log(`[${tag}] ${file} :: ${name}${suffix}`);
}

// Try comment-json first; fall back to a permissive JSONC stripper so this
// script keeps working in environments where comment-json isn't installed.
async function parseJsoncTolerant(raw: string): Promise<unknown> {
  try {
    const mod = (await import("comment-json")) as { parse: (s: string) => unknown };
    return mod.parse(raw);
  } catch {
    // Strip /* … */ then // … then trailing commas. Good enough for wrangler
    // configs we control; not a general-purpose JSONC parser.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/([^:])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  }
}

function checkNoTbd(file: string, raw: string): void {
  // Match `<TBD>` (the literal placeholder convention used in this repo).
  const matches = raw.match(/<TBD>/g);
  if (matches !== null) {
    logCheck(file, "no <TBD> placeholders", false, `${matches.length} occurrence(s)`);
    failures.push({ file, message: `<TBD> placeholder still present (${matches.length}×)` });
  } else {
    logCheck(file, "no <TBD> placeholders", true);
  }
}

function checkBindingIds(file: string, parsed: unknown): void {
  if (parsed === null || typeof parsed !== "object") {
    logCheck(file, "binding ids", false, "config did not parse to object");
    failures.push({ file, message: "config did not parse to an object" });
    return;
  }
  const cfg = parsed as Record<string, unknown>;

  for (const sectionName of ["d1_databases", "kv_namespaces"] as const) {
    const section = cfg[sectionName];
    if (section === undefined) continue;
    if (!Array.isArray(section)) {
      logCheck(file, `${sectionName} structure`, false, "expected array");
      failures.push({ file, message: `${sectionName} is not an array` });
      continue;
    }

    section.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object") {
        logCheck(file, `${sectionName}[${i}]`, false, "entry not an object");
        failures.push({ file, message: `${sectionName}[${i}] is not an object` });
        return;
      }
      const e = entry as Record<string, unknown>;
      const idCandidate = e.id ?? e.database_id;
      const binding = typeof e.binding === "string" ? e.binding : `(no binding label, index ${i})`;
      if (typeof idCandidate !== "string" || idCandidate.trim() === "") {
        logCheck(file, `${sectionName}[${binding}] id`, false, "missing or empty");
        failures.push({
          file,
          message: `${sectionName}[${binding}] missing id/database_id`,
        });
      } else {
        logCheck(file, `${sectionName}[${binding}] id`, true, `${idCandidate.slice(0, 8)}…`);
      }
    });
  }
}

function checkCommentDisabledBindings(file: string, raw: string): void {
  const lines = raw.split(/\r?\n/);
  let foundAnyBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^\s*\/\/\s*"([a-z_]+)"\s*:/);
    if (m === null) continue;
    const key = m[1] ?? "";
    if (!KNOWN_BINDING_KEYS.includes(key)) continue;

    foundAnyBlock = true;

    // Look up to 5 lines BEFORE and 5 lines AFTER for a re-enable phrase.
    // Operators tend to put the explanation in a leading comment block, so
    // checking both directions catches the realistic styles.
    const windowStart = Math.max(0, i - 5);
    const windowEnd = Math.min(lines.length, i + 6);
    const windowText = lines.slice(windowStart, windowEnd).join("\n").toLowerCase();
    const hasPhrase = REENABLE_PHRASES.some((p) => windowText.includes(p));

    if (hasPhrase) {
      logCheck(
        file,
        `comment-disabled "${key}" block @ line ${i + 1}`,
        true,
        "re-enable instructions present",
      );
    } else {
      logCheck(
        file,
        `comment-disabled "${key}" block @ line ${i + 1}`,
        false,
        `no "uncomment"/"re-enable"/"to enable" phrase within 5 lines`,
      );
      failures.push({
        file,
        message: `comment-disabled "${key}" block @ line ${i + 1} lacks re-enable instructions`,
      });
    }
  }

  if (!foundAnyBlock) {
    logCheck(file, "comment-disabled binding blocks", true, "none present (skipped)");
  }
}

async function lintFile(file: string): Promise<void> {
  if (!existsSync(file)) {
    console.log(`[SKIP] ${file} — file does not exist`);
    return;
  }
  const raw = readFileSync(file, "utf8");
  console.log(`\n--- ${file} ---`);

  checkNoTbd(file, raw);

  let parsed: unknown;
  try {
    parsed = await parseJsoncTolerant(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logCheck(file, "JSONC parse", false, msg);
    failures.push({ file, message: `JSONC parse error: ${msg}` });
    return;
  }
  logCheck(file, "JSONC parse", true);

  checkBindingIds(file, parsed);
  checkCommentDisabledBindings(file, raw);
}

async function main(): Promise<void> {
  console.log("lint-wrangler: checking wrangler.jsonc files for placeholders / missing ids …");
  for (const t of TARGETS) {
    await lintFile(t);
  }

  console.log();
  if (failures.length > 0) {
    console.error(
      `lint-wrangler FAILED (${failures.length} issue${failures.length === 1 ? "" : "s"}):`,
    );
    for (const f of failures) {
      console.error(`  - ${f.file}: ${f.message}`);
    }
    process.exit(1);
  }
  console.log("lint-wrangler OK");
}

main().catch((err) => {
  console.error("lint-wrangler crashed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
