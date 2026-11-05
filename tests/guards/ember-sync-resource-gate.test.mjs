// Guard: the EMBER mirror decides which dandisets become resources; it does not promote all of them.
//
// WHY. ember-dandiset-sync created a resources row for every EMBER dandiset. EMBER is also where
// people test uploads (#506), so the Resources page filled with 26 copies of one IDP test dataset, plus
// smoke tests and empty placeholders. A curator can now hide a dandiset (set_dandiset_hidden), which
// deletes its resource. A sync that stops checking `hidden` recreates the resource the next night,
// and one that stops checking the file count brings back the empty placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8").replace(/\r\n/g, "\n");

const sync = read("supabase/functions/ember-dandiset-sync/index.ts");

test("ember-dandiset-sync creates a resource only for a visible dandiset with files", () => {
  // Search the per-dandiset loop only: the Version type at the top names numberOfFiles too.
  const loop = sync.indexOf("for (const ds of dandisets)");
  const insert = sync.indexOf('.from("resources")', loop);
  assert.ok(loop > 0 && insert > loop, "ember-dandiset-sync no longer inserts into resources in its loop; update this guard");
  const before = sync.slice(loop, insert);
  assert.match(before, /existing\?\.hidden/, "the resources insert does not check dandisets.hidden");
  assert.match(before, /numberOfFiles/, "the resources insert does not check the file count");
});

test("a failed lookup of the mirror row cannot fall through to a second resource", () => {
  const lookup = sync.match(/const \{ data: existing, error: (\w+) \}[\s\S]*?\.maybeSingle\(\);\s*if \(\1\) throw \1;/);
  assert.ok(lookup, "the dandisets lookup ignores its error, so a failed read creates a duplicate resource");
});

test("set_dandiset_hidden removes the resource and is curator-only", () => {
  const mig = read("supabase/migrations/20261105120000_dandiset_hidden.sql");
  assert.match(mig, /DELETE FROM public\.resources WHERE id = _d\.resource_id/);
  assert.match(mig, /is_curator_or_admin\(auth\.uid\(\)\)/);
  assert.match(mig, /REVOKE ALL ON FUNCTION public\.set_dandiset_hidden\([^)]*\) FROM PUBLIC, anon/);
});
