// Guard: the provenance guard's coverage can only be narrowed on purpose, and in writing.
//
// WHY. Coverage is default-ON — every public table with a uuid id is guarded, minus
// provenance_excluded_tables(). That design has exactly one soft spot: adding a name to the
// exclusion list is a one-line edit that silently removes a table from oversight, and the obvious
// moment to reach for it is when the guard refuses a write someone wanted to succeed. That is
// precisely when it should NOT be reached for.
//
// So every exclusion must sit under a stated reason, right next to the names it covers. Not a strong
// check on its own — nothing stops a bad reason — but it makes a SILENT exclusion impossible: you
// either write down why, or the suite fails. In practice the reason is a group heading (the mechanism
// itself, append-only logs, pipeline output, configuration, opinion, billing, external mirrors), and
// a name that fits none of those probably belongs under the guard.
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

/** The exclusion list as it now stands, from the newest migration that defines it, kept as LINES so
 *  each name can be checked against the comment it sits under. */
function exclusions() {
  let body = null;
  let file = null;
  for (const f of sqlFiles()) {
    const sql = readFileSync(f, "utf8");
    const m = sql.match(
      /CREATE OR REPLACE FUNCTION public\.provenance_excluded_tables\(\)[\s\S]*?SELECT ARRAY\[([\s\S]*?)\]::text\[\]/,
    );
    if (!m) continue;
    body = m[1];
    file = f;
  }
  if (!body) return { names: null, file: null, lines: null };
  return {
    names: [...body.matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]),
    lines: body.split("\n"),
    file,
  };
}

test("every excluded table sits under a stated reason", () => {
  const { names, lines, file } = exclusions();
  assert.ok(names, "provenance_excluded_tables() not found in any migration");

  // The reason must be CO-LOCATED with the names it covers: a comment line introducing the group,
  // within a few lines above. Two earlier versions of this check were worse in opposite ways —
  // one scanned the whole migration header, so 'investigators' passed a probe because the word
  // appeared in unrelated prose; the next demanded two exact marker phrases in a prose block, and
  // broke the moment a migration put its reasons inline next to the names, which is the better
  // place for them. Proximity is the thing actually worth enforcing.
  const LOOKBACK = 6;
  const unexplained = [];
  for (const [idx, line] of lines.entries()) {
    for (const m of line.matchAll(/'([a-z_0-9]+)'/g)) {
      const explained = lines
        .slice(Math.max(0, idx - LOOKBACK), idx + 1)
        .some((l) => /--\s*\S/.test(l));
      if (!explained) unexplained.push(m[1]);
    }
  }

  assert.deepEqual(
    unexplained,
    [],
    `Excluded from the provenance guard with no reason stated nearby: ${unexplained.join(", ")}. ` +
      `Group it under a "-- why" comment in ${file?.split(/[\/]/).pop()}, or let the guard cover it.`,
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
