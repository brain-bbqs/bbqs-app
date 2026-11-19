// Guard: no client can write through a view.
//
// Supabase's default privileges grant ALL on every new table AND view in public to anon and
// authenticated. A table is protected by row-level security; a view that runs with its owner's
// rights (security_invoker unset or false) and is simple enough to be automatically updatable
// passes INSERT, UPDATE and DELETE through to its base table AS THE OWNER, which row-level security
// does not stop. On 2026-11-17, on a replica of this schema, an anonymous visitor rewrote a job
// through public_jobs and deleted a feature suggestion through feature_suggestions_public, and a
// signed-in user renamed another person through investigators_public and investigator_directory.
// 20261117174500_revoke_writes_through_views revoked every write privilege on every view that
// existed. This guard holds every LATER migration that creates a view to revoke them as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const FIX = "20261117174500_revoke_writes_through_views.sql";
const WRITES = ["INSERT", "UPDATE", "DELETE"];

/** SQL with comments removed (CRLF-safe), so a commented-out CREATE VIEW or REVOKE does not count. */
export function stripComments(sql) {
  return sql.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Views in schema public that a migration creates (lower-case names, no schema). */
export function viewsCreated(sql) {
  const names = new Set();
  const re = /\bcreate\s+(?:or\s+replace\s+)?(temp\s+|temporary\s+)?(?:recursive\s+)?view\s+(?:if\s+not\s+exists\s+)?("?[\w]+"?\s*\.\s*)?("?[\w]+"?)/gi;
  for (const m of stripComments(sql).matchAll(re)) {
    if (m[1]) continue;                                            // a temporary view is the session's own
    const schema = m[2] ? m[2].replace(/["\s.]/g, "").toLowerCase() : "public";
    if (schema === "public") names.add(m[3].replace(/"/g, "").toLowerCase());
  }
  return [...names];
}

/** Does the migration take INSERT, UPDATE and DELETE on `view` away from both anon and authenticated? */
export function writesRevoked(sql, view) {
  const text = stripComments(sql);
  // the one-off sweep: a loop that revokes the write privileges on every view (relkind 'v')
  const sweep = /relkind\s*=\s*'v'/i.test(text)
    && /revoke\s+insert\s*,\s*update\s*,\s*delete[^;]*from\s+anon\s*,\s*authenticated/i.test(text);
  if (sweep) return true;
  const covered = { anon: false, authenticated: false };
  const re = /\brevoke\s+([\w\s,]+?)\s+on\s+(?:table\s+)?("?[\w]+"?\s*\.\s*)?("?[\w]+"?)\s+from\s+([^;]+);/gi;
  for (const m of text.matchAll(re)) {
    if (m[3].replace(/"/g, "").toLowerCase() !== view) continue;
    if (m[2] && m[2].replace(/["\s.]/g, "").toLowerCase() !== "public") continue;
    const privileges = m[1].toUpperCase().split(/\s*,\s*/).map(p => p.trim());
    const all = privileges.some(p => p === "ALL" || p === "ALL PRIVILEGES");
    if (!all && !WRITES.every(w => privileges.includes(w))) continue;
    // FROM PUBLIC alone is not enough: anon and authenticated hold their own grants (Supabase's
    // default privileges), which a revoke from PUBLIC leaves in place.
    const grantees = m[4].toLowerCase();
    for (const role of Object.keys(covered)) if (new RegExp(`\\b${role}\\b`).test(grantees)) covered[role] = true;
  }
  return covered.anon && covered.authenticated;
}

test("the detector finds a view that leaves writes open, and passes one that revokes them", () => {
  const open = "CREATE OR REPLACE VIEW public.people_public AS SELECT id, name FROM public.people;";
  assert.deepEqual(viewsCreated(open), ["people_public"]);
  assert.equal(writesRevoked(open, "people_public"), false);
  assert.equal(writesRevoked(open + "\nREVOKE UPDATE ON public.people_public FROM anon, authenticated;", "people_public"), false,
    "revoking UPDATE alone leaves INSERT and DELETE");
  assert.equal(writesRevoked(open + "\nREVOKE INSERT, UPDATE, DELETE ON public.people_public FROM anon;", "people_public"), false,
    "revoking from anon alone leaves authenticated");
  assert.equal(writesRevoked(open + "\nREVOKE ALL ON public.people_public FROM PUBLIC, anon, authenticated;\nGRANT SELECT ON public.people_public TO anon;", "people_public"), true);
  assert.equal(writesRevoked(open + "\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE people_public FROM anon, authenticated;", "people_public"), true);
  assert.equal(writesRevoked(open + "\n-- REVOKE ALL ON public.people_public FROM anon, authenticated;", "people_public"), false,
    "a commented-out REVOKE does not count");
  assert.deepEqual(viewsCreated("CREATE TEMP VIEW scratch AS SELECT 1; CREATE VIEW other_schema.v AS SELECT 1;"), []);
});

test("20261117174500 revokes every write privilege on every view from anon and authenticated", () => {
  const sql = stripComments(readFileSync(join(MIGRATIONS, FIX), "utf8"));
  assert.match(sql, /relkind\s*=\s*'v'/i, "the sweep must cover every view, not a hand-written list");
  assert.match(sql, /revoke\s+insert\s*,\s*update\s*,\s*delete\s*,\s*truncate[^;]*from\s+anon\s*,\s*authenticated/i);
  assert.doesNotMatch(sql, /revoke[^;]*\bselect\b/i, "reading through the views must stay as it is");
});

test("every migration after the sweep that creates a view revokes writes on it", () => {
  const later = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql") && f > FIX).sort();
  const open = [];
  for (const file of later) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const view of viewsCreated(sql)) if (!writesRevoked(sql, view)) open.push(`${file}: ${view}`);
  }
  assert.deepEqual(open, [],
    "These views would let anon and authenticated write through them (Supabase grants ALL by default). "
    + "Add, after the CREATE VIEW: REVOKE ALL ON public.<view> FROM PUBLIC, anon, authenticated; "
    + "then GRANT SELECT ON public.<view> TO anon, authenticated; (only the roles that should read it).");
});
