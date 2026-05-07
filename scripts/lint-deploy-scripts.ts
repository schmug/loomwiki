// SPDX-License-Identifier: Apache-2.0
//
// Catches the `pnpm deploy` collision PR #24 had to fix. pnpm reserves
// `deploy` as a builtin command (`pnpm deploy <out-dir>` for monorepo
// production-pruning). When a script does `pnpm --filter <pkg> deploy`
// without a `run` (or `exec`) verb in front, pnpm runs the BUILTIN — not
// the package's `deploy` script — and the worker never ships.
//
// Rule:
//   - any `pnpm --filter <something> <token>` chain MUST have `run` or
//     `exec` as the token after the package name. Anything else is a
//     misuse — `deploy`, `build`, etc. need `run` in front because they
//     are package scripts, not pnpm builtins (well, `build` isn't
//     reserved today, but using `run` is the safe convention).
//   - any `pnpm deploy` invocation in a script (without `--filter` AND
//     without a `run`/`exec` verb) is the original PR #24 footgun and
//     must fail.

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

interface Failure {
  pkg: string;
  scriptName: string;
  scriptValue: string;
  reason: string;
}

const failures: Failure[] = [];
const checked: Array<{ pkg: string; script: string; value: string }> = [];

function collectAppPackageJsons(): string[] {
  const out: string[] = [resolve(REPO_ROOT, "package.json")];
  const appsDir = resolve(REPO_ROOT, "apps");
  try {
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      out.push(resolve(appsDir, entry.name, "package.json"));
    }
  } catch {
    // apps dir missing — treat as no apps.
  }
  return out;
}

function tokenize(s: string): string[] {
  // Cheap shell-ish splitter. Good enough for npm-script values, which are
  // small one-line shells — we don't care about quoted whitespace because
  // the patterns we're checking ("pnpm", "--filter", "<pkg>", "<verb>")
  // don't have spaces inside their tokens.
  return s.split(/\s+/).filter((t) => t.length > 0);
}

function checkScriptValue(pkg: string, name: string, value: string): void {
  checked.push({ pkg, script: name, value });

  // Walk the token stream and look for any `pnpm` / `pnpm.cmd` invocation.
  const tokens = tokenize(value);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok !== "pnpm" && tok !== "pnpx") continue;

    // 1. `pnpm --filter <pkg> <verb> ...` — verb must be `run` or `exec`.
    const next1 = tokens[i + 1];
    if (next1 === "--filter" || next1 === "-F") {
      // Skip past optional flag value(s). After --filter the very next
      // token is the package selector.
      const verbIdx = i + 3;
      const verb = tokens[verbIdx];
      if (verb === undefined) {
        // truncated; skip — likely something like ending mid-line.
        continue;
      }
      if (verb !== "run" && verb !== "exec") {
        failures.push({
          pkg,
          scriptName: name,
          scriptValue: value,
          reason: `pnpm --filter <pkg> "${verb}" — expected "run" or "exec" before script name (pnpm builtin collision risk; e.g. "deploy" runs pnpm's builtin deploy command, not your package script)`,
        });
      }
      continue;
    }

    // 2. Bare `pnpm deploy` — the marquee PR #24 regression.
    if (next1 === "deploy") {
      failures.push({
        pkg,
        scriptName: name,
        scriptValue: value,
        reason: `bare "pnpm deploy" invokes pnpm's BUILTIN deploy command (monorepo prune), not a package script. Use "pnpm --filter <pkg> run deploy" or "pnpm exec wrangler deploy".`,
      });
    }
  }
}

interface PackageJsonShape {
  name?: unknown;
  scripts?: unknown;
}

function lintPackage(file: string): void {
  let parsed: PackageJsonShape;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as PackageJsonShape;
  } catch (err) {
    failures.push({
      pkg: file,
      scriptName: "(parse)",
      scriptValue: "",
      reason: `package.json parse error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const pkgName = typeof parsed.name === "string" ? parsed.name : file;
  const scripts = parsed.scripts;
  if (scripts === undefined || scripts === null || typeof scripts !== "object") return;

  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    checkScriptValue(pkgName, name, value);
  }
}

function main(): void {
  console.log("lint-deploy-scripts: scanning package.json scripts for pnpm-deploy footgun …");
  const files = collectAppPackageJsons();
  for (const f of files) lintPackage(f);

  console.log(
    `Inspected ${checked.length} script value(s) across ${files.length} package.json file(s).`,
  );

  if (failures.length > 0) {
    console.error(
      `\nlint-deploy-scripts FAILED (${failures.length} issue${failures.length === 1 ? "" : "s"}):`,
    );
    for (const f of failures) {
      console.error(`  - [${f.pkg}] scripts.${f.scriptName} = "${f.scriptValue}"`);
      console.error(`      ${f.reason}`);
    }
    process.exit(1);
  }
  console.log("lint-deploy-scripts OK");
}

main();
