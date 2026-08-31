// Guard: provenance coverage has TWO halves, and they must stay attached together.
//
// WHY. enforce_field_provenance (BEFORE UPDATE) refuses a machine write over a curated value.
// record_field_provenance (AFTER INSERT) records how a value arrived. For a year only the first
// existed, because it is named for enforcement and INSERT has nothing to enforce — so every new
// record began with no provenance and nobody noticed until a new grant showed no chips.
//
// The failure mode is not someone deleting the recorder on purpose. It is CREATE OR REPLACE: both
// provenance_attach_all() and the provenance_guardable_tables view are replaced wholesale by later
// migrations, and a copy made from the older 20260820150000 text silently reinstates the
// guard-only version. Nothing errors; new rows just stop being recorded again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not url.pathname: this repo lives under "MIT Dropbox" and pathname leaves the
// spaces percent-encoded, which makes every readdir ENOENT.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/** Migration text in apply order — later definitions win, exactly as the database sees them. */
function migrationsInOrder() {
  return readdirSync(MIGRATIONS)
    .filter((f) => extname(f) === ".sql")
    .sort()
    .map((f) => join(MIGRATIONS, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => ({ file: f, sql: readFileSync(f, "utf8") }));
}

/** The last definition of an object, since that is the one in force. */
function lastDefinition(pattern) {
  let found = null;
  for (const { file, sql } of migrationsInOrder()) {
    for (const m of sql.matchAll(pattern)) found = { file, text: m[0] };
  }
  return found;
}

test("the guardable-tables view reports both halves of coverage", () => {
  const view = lastDefinition(
    /CREATE OR REPLACE VIEW public\.provenance_guardable_tables AS[\s\S]*?;/g,
  );
  assert.ok(view, "provenance_guardable_tables is never defined");

  assert.match(
    view.text,
    /AS is_guarded/,
    `${view.file}: the view stopped reporting is_guarded`,
  );
  assert.match(
    view.text,
    /AS is_recorded/,
    `${view.file}: the view stopped reporting is_recorded — INSERT-time provenance is now invisible, so drift in it cannot be seen`,
  );
  assert.match(
    view.text,
    /trg_record_field_provenance/,
    `${view.file}: is_recorded must be derived from the trg_record_field_provenance trigger`,
  );
});

test("attach_all attaches the recorder as well as the guard", () => {
  const fn = lastDefinition(
    /CREATE OR REPLACE FUNCTION public\.provenance_attach_all\(\)[\s\S]*?\$fn\$;/g,
  );
  assert.ok(fn, "provenance_attach_all is never defined");

  assert.match(
    fn.text,
    /provenance_attach_guard/,
    `${fn.file}: attach_all stopped attaching the UPDATE guard`,
  );
  assert.match(
    fn.text,
    /provenance_attach_recorder/,
    `${fn.file}: attach_all stopped attaching the INSERT recorder — new rows will silently carry no provenance, which is the bug 20260831160000 fixed`,
  );
});

test("new tables get both triggers, not just the guard", () => {
  const fn = lastDefinition(
    /CREATE OR REPLACE FUNCTION public\.provenance_guard_new_tables\(\)[\s\S]*?\$fn\$;/g,
  );
  assert.ok(fn, "provenance_guard_new_tables is never defined");

  assert.match(
    fn.text,
    /provenance_attach_recorder/,
    `${fn.file}: the ddl event trigger attaches only the guard, so any table created from here on records nothing on insert`,
  );
});

test("the recorder only fires for a declared source class", () => {
  const fn = lastDefinition(
    /CREATE OR REPLACE FUNCTION public\.record_field_provenance\(\)[\s\S]*?\$fn\$;/g,
  );
  assert.ok(fn, "record_field_provenance is never defined");

  assert.match(
    fn.text,
    /source_class_was_declared\(\)/,
    `${fn.file}: the recorder must gate on source_class_was_declared(). current_source_class() always answers — falling back to 'unknown' (G7) — so recording through it would stamp G7 on every cell of every bulk seed and bury provenance_worklist.`,
  );
});
