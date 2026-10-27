// Guard: the KG's written decisions must not drift from the files that enforce them.
//
// WHY. Three hand-kept copies say the same thing in different places, and nothing held them together:
//   • every invariant shape in kg/shapes/consistency.shapes.ttl has a row in the README catalogue
//     (a shape with no row is a rule nobody can find; numbering collided once, #442);
//   • the four working-group names in WorkingGroupCanonicalShape are the tokens the database writes
//     (normalize_working_groups) — a fifth name there would flag the real fourth group;
//   • every class kg/standalone_by_design.yaml excuses from the isolated-node target is a real
//     class, so a rename cannot silently stop excusing it (or excuse a typo that matches nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8").replace(/\r\n/g, "\n");

const shapes = read("kg/shapes/consistency.shapes.ttl");
const readme = read("kg/README.md");

/** Invariant numbers named in shape headers: `# ── Invariant #8 — ...` / `# ── Invariant #10 (URLs) ...`. */
function shapeInvariants() {
  return [...shapes.matchAll(/^# ── Invariant #(\d+)\b/gm)].map((m) => Number(m[1]));
}

/** Catalogue rows: `| 14 | One ORCID ... |`, inside the Consistency-invariant catalog section. */
function catalogRows() {
  const section = readme.match(/## Consistency-invariant catalog[\s\S]*?(?=\n## )/);
  assert.ok(section, "could not find the Consistency-invariant catalog section in kg/README.md");
  return [...section[0].matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
}

test("every invariant a shape names has a catalogue row", () => {
  const rows = new Set(catalogRows());
  const missing = [...new Set(shapeInvariants())].filter((n) => !rows.has(n));
  assert.deepEqual(missing, [], `shapes name invariants with no README catalogue row: #${missing.join(", #")}`);
});

test("catalogue numbers are unique", () => {
  const rows = catalogRows();
  const dupes = rows.filter((n, i) => rows.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `catalogue numbers used twice: #${dupes.join(", #")}`);
});

test("WorkingGroupCanonicalShape lists the tokens the database writes", () => {
  const inList = shapes.match(/bbqs:WorkingGroupCanonicalShape[\s\S]*?sh:in \(([^)]*)\)/);
  assert.ok(inList, "WorkingGroupCanonicalShape has no sh:in list");
  const shape = [...inList[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const mig = read("supabase/migrations/20260806120000_normalize_working_groups.sql");
  const db = [...new Set([...mig.matchAll(/THEN '(WG-[A-Za-z]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(db.length >= 4, "found fewer than four WG- tokens in the normalize migration");
  assert.deepEqual(shape, db);
});

test("standalone_by_design names real classes, each with a decision", () => {
  const yml = read("kg/standalone_by_design.yaml");
  const block = yml.split(/^standalone_by_design:\n/m)[1];
  assert.ok(block, "kg/standalone_by_design.yaml has no standalone_by_design: map");
  const names = [...block.matchAll(/^ {2}(\w+):\n/gm)].map((m) => m[1]);
  assert.ok(names.length > 0, "no classes listed");
  const schema = read("kg/bbqs.linkml.yaml");
  for (const name of names) {
    assert.match(schema, new RegExp(`\\n {2}${name}:\\n`), `${name} is not a class in kg/bbqs.linkml.yaml`);
    const entry = block.split(new RegExp(`^ {2}${name}:\\n`, "m"))[1].split(/^ {2}\w+:\n/m)[0];
    assert.match(entry, /decision:/, `${name} has no recorded decision`);
  }
});
