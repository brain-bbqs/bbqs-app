// Guard: edge functions that act on the consortium's behalf must check who is calling.
//
// WHY. The 2026-10-29 MCP audit found that the MCP's tier gate was the only check in front of several
// functions a caller can reach directly: send-welcome-email (and two sibling mailers) sent
// BBQS-branded mail to any address for anyone holding the public anon key; nih-grants wrote the KG
// with the service role for callers with no key at all; and requireAdmin treated every @mit.edu
// account as an admin. The MCP tier is a first layer, never the authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FUNCS = join(ROOT, "supabase", "functions");
const src = (name) => readFileSync(join(FUNCS, name, "index.ts"), "utf8");
const functions = readdirSync(FUNCS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(FUNCS, d.name, "index.ts")))
  .map((d) => d.name);

// Mailers whose recipient is fixed in code, so the worst a caller can do is send the admins a copy.
const FIXED_RECIPIENT_MAILERS = new Set(["notify-access-request", "security-audit", "report-critical-error"]);
const checksCaller = (s) =>
  /requireCuratorOrService\(|requireAdmin\(/.test(s) ||
  /SUPABASE_SERVICE_ROLE_KEY[\s\S]{0,800}(Unauthorized|status: 401|, 401\))/.test(s);

test("a function that sends email to a caller-chosen address checks the caller", () => {
  const open = functions.filter((f) => {
    const s = src(f);
    return s.includes("api.resend.com") && !FIXED_RECIPIENT_MAILERS.has(f) && !checksCaller(s);
  });
  assert.deepEqual(open, [], `mailers with no caller check: ${open.join(", ")}`);
});

test("interpolated names in welcome/approval/reminder mail are escaped", () => {
  for (const f of ["send-welcome-email", "send-access-approved-email", "send-onboarding-reminder"]) {
    assert.match(src(f), /escapeHtml\(/, `${f} interpolates caller text into HTML without escapeHtml`);
  }
});

test("nih-grants refuses every ?action= without the service-role key or a curator", () => {
  const s = src("nih-grants");
  const gate = s.indexOf("requireCuratorOrService(req");
  assert.ok(gate > 0, "nih-grants has no caller check");
  assert.ok(gate < s.indexOf('action === "reconcile"'), "the check must run before the first action");
});

test("an email domain is never an admin credential", () => {
  const auth = readFileSync(join(FUNCS, "_shared", "auth.ts"), "utf8");
  assert.doesNotMatch(auth, /endsWith\(\s*["']@/, "requireAdmin must check user_roles, not an email domain");
});

// verify_jwt=false lets a request with no key at all reach the function. Each one listed here was
// either reviewed or predates the audit (see the audit notes); a new one must be added deliberately.
const NO_JWT_REVIEWED = new Set([
  "github-roadmap", "create-github-issue", "ember-dandiset-sync", "nih-grants", "import-grant-publications",
  "bbqs-api", "bbqs-mcp", "resolve-scholar-ids", "discovery-chat", "metadata-suggest", "seed-metadata",
  "suggest-related", "gap-analysis", "normalize-tags", "metadata-chat", "paper-extract", "globus-auth",
  "notify-access-request", "embed-knowledge", "sync-member-groups", "analytics-summary", "metadata-validate",
  "elevenlabs-conversation-token", "state-privacy-scan", "verify-affiliations", "auth-notify", "security-audit",
  "assistant-router", "harvester-tick", "personality-score-worker", "interactional-terms",
  "cohort-mental-model-summary", "relational-cohesion", "device-knowledge-seed",
]);

test("no new function turns off JWT verification without review", () => {
  const toml = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
  const off = [...toml.matchAll(/\[functions\.([a-z0-9-]+)\][^[]*?verify_jwt\s*=\s*false/g)].map((m) => m[1]);
  const added = off.filter((f) => !NO_JWT_REVIEWED.has(f));
  assert.deepEqual(added, [], `verify_jwt=false added without review: ${added.join(", ")}`);
});

test("every bbqs-mcp tool is in exactly one tier (an unlisted tool would be public)", () => {
  const s = src("bbqs-mcp");
  const tools = [...s.matchAll(/^\s*T\("([a-z_]+)"/gm)].map((m) => m[1]);
  const tier = (n) => new Set([...s.split(`const ${n} = new Set([`)[1].split("]);")[0].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  const sets = ["PUBLIC_TOOLS", "MEMBER_TOOLS", "CURATOR_TOOLS"].map(tier);
  const bad = tools.filter((t) => sets.filter((x) => x.has(t)).length !== 1);
  assert.ok(tools.length > 20, "found too few tools; the T( pattern changed");
  assert.deepEqual(bad, [], `tools not in exactly one tier: ${bad.join(", ")}`);
});
