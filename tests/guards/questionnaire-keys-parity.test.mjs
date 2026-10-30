import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// import_questionnaire_response() refuses any answer key not in questionnaire_metadata_keys(). That
// SQL allowlist duplicates the metadata keys defined in src/data/questionnaire-fields.ts, and a key
// added to the form definition but not the allowlist would make every import carrying it fail.

const root = new URL("../../", import.meta.url);

function tsMetadataKeys() {
  const src = readFileSync(new URL("src/data/questionnaire-fields.ts", root), "utf8");
  const keys = [];
  for (const m of src.matchAll(/\{\s*key:\s*"([a-z_]+)"([\s\S]*?)\}/g)) {
    // topLevel fields live in their own projects columns (website, keywords, study_*), not metadata.
    if (!/topLevel:\s*true/.test(m[2])) keys.push(m[1]);
  }
  return keys;
}

function sqlAllowlist() {
  const dir = new URL("supabase/migrations/", root);
  // The newest migration that (re)defines the function is the live definition.
  const file = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .find((f) => /FUNCTION public\.questionnaire_metadata_keys\(\)/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.ok(file, "no migration defines public.questionnaire_metadata_keys()");
  const sql = readFileSync(new URL(file, dir), "utf8");
  const body = sql.match(/FUNCTION public\.questionnaire_metadata_keys\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]/);
  assert.ok(body, `could not read the ARRAY[...] in ${file}`);
  return [...body[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test("questionnaire-fields.ts yields a non-trivial key set", () => {
  assert.ok(tsMetadataKeys().length > 50, "the field extractor found too few keys; the parser is broken");
});

test("the import allowlist matches the questionnaire metadata keys exactly", () => {
  const ts = new Set(tsMetadataKeys());
  const sql = new Set(sqlAllowlist());
  const missing = [...ts].filter((k) => !sql.has(k));
  const extra = [...sql].filter((k) => !ts.has(k));
  assert.deepEqual(missing, [], `in questionnaire-fields.ts but not the SQL allowlist (imports would reject them): ${missing}`);
  assert.deepEqual(extra, [], `in the SQL allowlist but not questionnaire-fields.ts: ${extra}`);
});
