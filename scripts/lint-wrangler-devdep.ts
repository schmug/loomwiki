// SPDX-License-Identifier: Apache-2.0
//
// Catches the "missing wrangler devDep" regression PR #24 hit. If an app
// has a `deploy` script (which on this stack always shells out to
// wrangler), it MUST declare `wrangler` in its devDependencies — otherwise
// `pnpm --filter <app> run deploy` from a clean install crashes because
// the binary isn't on PATH.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

interface PkgShape {
  name?: unknown;
  scripts?: unknown;
  devDependencies?: unknown;
  dependencies?: unknown;
}

interface Failure {
  pkg: string;
  reason: string;
}

const failures: Failure[] = [];

function lintApp(appDir: string): void {
  const pkgPath = resolve(appDir, "package.json");
  if (!existsSync(pkgPath)) return;
  let parsed: PkgShape;
  try {
    parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as PkgShape;
  } catch (err) {
    failures.push({
      pkg: pkgPath,
      reason: `package.json parse error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const name = typeof parsed.name === "string" ? parsed.name : pkgPath;
  const scripts = (parsed.scripts ?? {}) as Record<string, unknown>;
  const deploy = scripts.deploy;
  if (typeof deploy !== "string") {
    console.log(`[SKIP] ${name} — no "deploy" script`);
    return;
  }

  const devDeps = (parsed.devDependencies ?? {}) as Record<string, unknown>;
  const deps = (parsed.dependencies ?? {}) as Record<string, unknown>;

  if (typeof devDeps.wrangler === "string") {
    console.log(`[PASS] ${name} — wrangler@${devDeps.wrangler} in devDependencies`);
    return;
  }
  if (typeof deps.wrangler === "string") {
    // Allow it as a runtime dep too; not the recommended location, but
    // functionally fine for a deploy script.
    console.log(
      `[PASS] ${name} — wrangler@${deps.wrangler} (in dependencies; consider devDependencies)`,
    );
    return;
  }

  failures.push({
    pkg: name,
    reason: `has "deploy" script ("${deploy}") but no "wrangler" in devDependencies`,
  });
}

function main(): void {
  console.log("lint-wrangler-devdep: every app with a deploy script must ship wrangler …");
  const appsDir = resolve(REPO_ROOT, "apps");
  let scanned = 0;
  try {
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      lintApp(resolve(appsDir, entry.name));
      scanned++;
    }
  } catch (err) {
    console.error(`apps/ not readable: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  console.log(`Scanned ${scanned} app package(s).`);

  if (failures.length > 0) {
    console.error(
      `\nlint-wrangler-devdep FAILED (${failures.length} issue${failures.length === 1 ? "" : "s"}):`,
    );
    for (const f of failures) {
      console.error(`  - ${f.pkg}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log("lint-wrangler-devdep OK");
}

main();
