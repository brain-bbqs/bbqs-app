// Guard: a service-role caller is recognised by the platform, never by byte equality.
//
// WHY. On 2026-11-04 onboarding-stuck-digest refused the project's own legacy service_role key —
// the one the dashboard shows and cron_invoke sends from the vault — with "Not authenticated". It
// compared the bearer with SUPABASE_SERVICE_ROLE_KEY, and on this project that variable is not that
// key. Fifteen functions made the same comparison, so none of them could be called by cron or a DB
// trigger. isServiceRole() asks the platform instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FUNCS = join(ROOT, "supabase", "functions");

const tsFiles = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
const files = tsFiles(FUNCS).map((p) => ({ path: relative(ROOT, p).replace(/\\/g, "/"), src: readFileSync(p, "utf8") }));

const SERVICE_KEY = String.raw`(?:serviceKey|serviceRoleKey|SERVICE_ROLE_KEY|Deno\.env\.get\(\s*["']SUPABASE_SERVICE_ROLE_KEY["']\s*\))`;
const EQUALITY = new RegExp(String.raw`(?:===|!==)\s*${SERVICE_KEY}(?![\w$])|(?<![\w$])${SERVICE_KEY}\s*(?:===|!==)`);

// isServiceRole may short-circuit on the injected key; it is the one place that also asks the platform.
test("no function recognises the service role by comparing with SUPABASE_SERVICE_ROLE_KEY", () => {
  const offenders = files
    .filter((f) => !f.path.endsWith("_shared/auth.ts") && EQUALITY.test(f.src))
    .map((f) => f.path);
  assert.deepEqual(offenders, [], `use isServiceRole() from _shared/auth.ts in: ${offenders.join(", ")}`);
});

test("isServiceRole asks the platform", () => {
  const auth = files.find((f) => f.path.endsWith("_shared/auth.ts")).src;
  assert.match(auth, /export async function isServiceRole\(/, "_shared/auth.ts must export isServiceRole");
  assert.match(auth, /\/auth\/v1\/admin\/users/, "isServiceRole must ask an endpoint only the service role may call");
});

test("requireService is awaited at every call site", () => {
  const bare = files
    .filter((f) => /(?<!(?:await|function)\s+)\brequireService\(\s*req/.test(f.src))
    .map((f) => f.path);
  assert.deepEqual(bare, [], `requireService is async; await it in: ${bare.join(", ")}`);
});
