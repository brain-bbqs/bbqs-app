// Guard: every class the KG exporter types a node with is a real, concrete class in the schema.
//
// WHY. The exporter (kg/bbqs_kg.py) maps resources.resource_type -> class name in a hand-written
// TYPE_CLASS table, and mints ProjectRole separately. Nothing ties those names to
// kg/bbqs.linkml.yaml: rename a class in the schema, or add a type with a typo, and the exporter
// emits nodes the TBox doesn't know -- every shape targeting the real class then passes on nothing.
// (Salvaged from #411's disjointness guard, which read TYPE_CLASS from kg/export.py and broke when
// the #403 refactor moved it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8").replace(/\r\n/g, "\n");

function exporterClasses() {
  const src = read("kg/bbqs_kg.py");
  const block = src.match(/\nTYPE_CLASS = \{([\s\S]*?)\n\}/);
  assert.ok(block, "no TYPE_CLASS map in kg/bbqs_kg.py");
  const mapped = [...block[1].matchAll(/:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(mapped.length > 10, `TYPE_CLASS parsed to only ${mapped.length} classes`);
  const minted = [...src.matchAll(/RDF\.type,\s*BBQS\["([A-Za-z]+)"\]/g)].map((m) => m[1]);
  return [...new Set([...mapped, ...minted])].sort();
}

function schemaClasses() {
  const src = read("kg/bbqs.linkml.yaml");
  const block = src.match(/\nclasses:\n([\s\S]*?)(?=\n\w|$)/);
  assert.ok(block, "no classes: section in kg/bbqs.linkml.yaml");
  const classes = new Map();
  // A class is a 2-space-indented key; its body runs to the next one. One-line classes use { ... }.
  const heads = [...block[1].matchAll(/^ {2}([A-Z][A-Za-z]+):(.*)$/gm)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : block[1].length;
    const body = h[2] + block[1].slice(h.index + h[0].length, end);
    classes.set(h[1], /\babstract:\s*true\b/.test(body));
  });
  return classes;
}

test("every class the exporter types a node with is a concrete schema class", () => {
  const schema = schemaClasses();
  const bad = exporterClasses().filter((c) => !schema.has(c) || schema.get(c));
  assert.deepEqual(bad, [], `exporter classes missing from, or abstract in, kg/bbqs.linkml.yaml: ${bad.join(", ")}`);
});
