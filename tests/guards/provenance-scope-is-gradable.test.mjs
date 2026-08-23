// Guard: a provenance chip wired to something the system will never grade renders NOTHING, forever,
// with no error anywhere.
//
// That failure mode is the whole reason this file exists. ProvenanceChip returns null when it has no
// claim — deliberately, so a viewer without permission and an environment behind on migrations both
// degrade quietly instead of painting every field as suspect. The cost of that kindness is that a
// typo in `table="investigatorz"` or a chip on an excluded column looks EXACTLY like "this viewer
// isn't staff". Nobody would ever see it fail.
//
// So the invariant is checked here instead:
//   1. every ProvenanceScope table is a table the provenance system actually tracks
//   2. every SummaryField field= is a column it will actually grade
//
// Both lists are read from the migrations, which are the source of truth for scope, so the guard
// tracks the DB rather than a copy of it that drifts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SUMMARIES = join(ROOT, "src", "components", "entity-summary", "summaries");

const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*/, ""))
    .join("\n");

/** The array literal returned by the LAST migration that defines `fn`. Later migrations replace
 *  earlier ones, so only the final definition is in force. */
function latestArray(fn) {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => extname(f) === ".sql")
    .sort();
  let found = null;
  for (const f of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS, f), "utf8"));
    const at = sql.indexOf(`FUNCTION public.${fn}()`);
    if (at === -1) continue;
    const open = sql.indexOf("ARRAY[", at);
    if (open === -1) continue;
    const close = sql.indexOf("]", open);
    found = [...sql.slice(open + 6, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  return found;
}

const summaryFiles = () =>
  readdirSync(SUMMARIES)
    .filter((f) => extname(f) === ".tsx")
    .map((f) => [f, readFileSync(join(SUMMARIES, f), "utf8")]);

test("the migration parser finds both scope lists", () => {
  // If this fails the other two tests are vacuous, so it is asserted separately and loudly.
  const tables = latestArray("provenance_excluded_tables");
  const columns = latestArray("provenance_excluded_columns");
  assert.ok(tables && tables.length > 10, `excluded tables not parsed: ${tables}`);
  assert.ok(columns && columns.length > 5, `excluded columns not parsed: ${columns}`);
  assert.ok(columns.includes("updated_at"), "expected updated_at among the excluded columns");
});

test("every ProvenanceScope names a table the system grades", () => {
  const excluded = new Set(latestArray("provenance_excluded_tables"));
  const problems = [];
  for (const [file, src] of summaryFiles()) {
    for (const m of src.matchAll(/<ProvenanceScope\s+table="([^"]+)"/g)) {
      const t = m[1];
      if (excluded.has(t)) {
        problems.push(
          `${file}: scope on "${t}", which provenance_excluded_tables() excludes — every chip in ` +
            `this panel will render nothing, silently.`,
        );
      }
      if (!/^[a-z][a-z0-9_]*$/.test(t)) {
        problems.push(`${file}: "${t}" is not a bare table name.`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every SummaryField field= names a column the system grades", () => {
  const excluded = new Set(latestArray("provenance_excluded_columns"));
  const external = new Set(latestArray("provenance_external_identifier_columns") ?? []);
  const problems = [];
  for (const [file, src] of summaryFiles()) {
    for (const m of src.matchAll(/<SummaryField[^>]*?field="([^"]+)"/gs)) {
      const col = m[1];
      const head = col.split(".")[0];
      if (excluded.has(head)) {
        problems.push(
          `${file}: field="${col}" is in provenance_excluded_columns() — it is bookkeeping, so no ` +
            `claim is ever recorded and the chip never appears.`,
        );
      }
      // Foreign keys stopped being graded in 20260822160000: a uuid is not a claim a human can
      // judge. External identifiers are the named exception (20260822190000) -- scholar_id points
      // OUT at a public page, so it IS a claim. The allowlist is read from the migration rather
      // than restated here, so the two cannot drift.
      const tail = col.split(".").pop();
      if (/_id$/.test(col) && !external.has(tail) && !external.has(head)) {
        problems.push(
          `${file}: field="${col}" is foreign-key shaped and not in ` +
            `provenance_external_identifier_columns(), so it is never graded and the chip never ` +
            `appears. If it is an external identifier, add it to that list in a migration.`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a summary that wires field= also declares a scope", () => {
  // field= without a surrounding ProvenanceScope is the other silent half: the lookup falls back to
  // the empty context and every chip is null.
  const problems = [];
  for (const [file, src] of summaryFiles()) {
    const hasFields = /<SummaryField[^>]*?field="/s.test(src);
    const hasScope = src.includes("<ProvenanceScope");
    if (hasFields && !hasScope) {
      problems.push(`${file}: has field= attributes but no <ProvenanceScope> — no chip can render.`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
