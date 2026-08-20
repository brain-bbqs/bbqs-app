// Guard: the provenance guard's coverage can only be narrowed on purpose, and in writing.
//
// WHY. Coverage is default-ON — every public table with a uuid id is guarded, minus
// provenance_excluded_tables(). That design has exactly one soft spot: adding a name to the
// exclusion list is a one-line edit that silently removes a table from oversight, and the obvious
// moment to reach for it is when the guard refuses a write someone wanted to succeed. That is
// precisely when it should NOT be reached for.
//
// So every exclusion must be justified in the migration's own header. Not a strong check on its
// own — but it means a silent exclusion is impossible: you either write down why, or the suite
// fails. The rationale block groups them (the mechanism itself, append-only logs, derived bulk,
// pipeline state, personal preferences, billing, external snapshots); a name that fits none of
// those probably belongs under the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not url.pathname: this repo lives under "MIT Dropbox" and pathname leaves the
// spaces percent-encoded, which makes every readdir ENOENT.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const sqlFiles = () =>
  readdirSync(MIGRATIONS)
    .filter((f) => extname(f) === ".sql")
    .sort()
    .map((f) => join(MIGRATIONS, f))
    .filter((f) => statSync(f).isFile());

/** The exclusion list as it now stands, from the newest migration that defines it. */
function exclusions() {
  let names = null;
  let file = null;
  for (const f of sqlFiles()) {
    const sql = readFileSync(f, "utf8");
    const m = sql.match(
      /CREATE OR REPLACE FUNCTION public\.provenance_excluded_tables\(\)[\s\S]*?SELECT ARRAY\[([\s\S]*?)\]::text\[\]/,
    );
    if (!m) continue;
    names = [...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]);
    file = f;
  }
  return { names, file };
}

test("every excluded table is justified in the migration that excludes it", () => {
  const { names, file } = exclusions();
  assert.ok(names, "provenance_excluded_tables() not found in any migration");

  // Only the RATIONALE LIST counts, not the whole header. Scoping this to the header let
  // 'investigators' pass unnoticed during a probe, because the word appears in the prose above
  // explaining what the guard protects — an incidental mention is not a justification.
  const sql = readFileSync(file, "utf8");
  const from = sql.indexOf("DEFAULT ON, opt out by name");
  const to = sql.indexOf("Anything not named here is guarded");
  assert.ok(from !== -1 && to > from, "the migration must carry a rationale block for its exclusions");
  const header = sql.slice(from, to);
  const undocumented = names.filter((n) => {
    // Keep the ones that are NOT justified. A name is justified if the header mentions it, or names
    // its family with a wildcard (analytics_* covers analytics_clicks and analytics_pageviews).
    if (header.includes(n)) return false;
    const family = n.replace(/_[a-z0-9]+$/, "");
    return !header.includes(`${family}_*`);
  });

  assert.deepEqual(
    undocumented,
    [],
    "Excluded from the provenance guard with no stated reason: " +
      undocumented.join(", ") +
      ". Say why in the migration header, or let the guard cover it.",
  );
});

test("the guard is table-agnostic — no table name is hardcoded in it", () => {
  let body = null;
  for (const f of sqlFiles()) {
    const sql = readFileSync(f, "utf8");
    const i = sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_field_provenance()");
    if (i === -1) continue;
    const end = sql.indexOf("$fn$;", sql.indexOf("$fn$", i) + 4);
    body = sql.slice(i, end);
  }
  assert.ok(body, "enforce_field_provenance() not found");

  assert.match(
    body,
    /TG_TABLE_NAME/,
    "The guard must take its table from TG_TABLE_NAME so it works on every table.",
  );
  // The original version wrote the literal 'projects' into entity_table, which is why it protected
  // one table and nothing else. If that reappears, coverage has silently collapsed to one table.
  assert.ok(
    !/'projects'/.test(body),
    "enforce_field_provenance() hardcodes 'projects' — it is meant to be table-agnostic.",
  );
});

test("coverage is attached by a function, not by hand per table", () => {
  const all = sqlFiles().map((f) => readFileSync(f, "utf8")).join("\n");
  assert.match(all, /CREATE OR REPLACE FUNCTION public\.provenance_attach_all\(\)/,
    "provenance_attach_all() is what makes coverage self-maintaining.");
  // Two mechanisms on purpose: instant where privileges allow, nightly where they do not.
  assert.match(all, /CREATE EVENT TRIGGER trg_provenance_guard_new_tables/,
    "the event trigger gives immediate coverage of new tables");
  assert.match(all, /cron\.schedule\('provenance-attach-all'/,
    "the cron job is the portable fallback when event triggers are not permitted");
});
