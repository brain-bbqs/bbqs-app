// Guard: the predicates public.resource_links accepts are the predicates the exporter writes, and
// each is a slot of the KG schema.
//
// WHY. resource_links (20261116150000) holds the curated links no column stores: a model trained_on
// its dataset, a benchmark that evaluates a tool, a published paper that is a revision_of its
// preprint (20261117181500). Its predicate is a kg/bbqs.linkml.yaml slot name, and four places
// list them by hand: the table's CHECK constraint, the type check trigger
// (resource_links_check_types, one WHEN per predicate), the exporter's RESOURCE_LINK_SLOTS
// (kg/bbqs_kg.py), and kg/identity_keys.json. A predicate the database accepts but the exporter
// skips is a curated link that silently never reaches the graph; one the exporter lists but the
// database refuses can never be written; one the schema lacks is a predicate gen-owl does not know.
//
// KG_MIGRATIONS_DIR reads the migrations from another folder (a scratch copy of
// supabase/migrations), to check a migration before it is in the tree. CI never sets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const MIGRATIONS = process.env.KG_MIGRATIONS_DIR || join(ROOT, "supabase", "migrations");
const sorted = (xs) => [...new Set(xs)].sort();

function migrations() {
  assert.ok(existsSync(MIGRATIONS), `no migrations folder at ${MIGRATIONS}`);
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => ({ name: f, text: code(readFileSync(join(MIGRATIONS, f), "utf8").replace(/\r\n/g, "\n")) }));
}

// The SQL without its whole-line comments: a header's UNDO section may quote an old CHECK.
const code = (text) => text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// A quoted token, as SQL writes it or as it appears inside a quoted EXECUTE string ('' doubled).
const tokens = (s) => [...s.matchAll(/'{1,2}([a-z_]+)'{1,2}/g)].map((m) => m[1]);

/** The predicates of the last resource_links_predicate_check any migration defines. */
function latestCheck() {
  let last = null;
  for (const m of migrations()) {
    for (const c of m.text.matchAll(/resource_links_predicate_check\s+CHECK\s*\(\s*predicate\s+IN\s*\(([^)]*)\)/gi)) {
      last = { file: m.name, predicates: sorted(tokens(c[1])) };
    }
  }
  assert.ok(last, "no migration defines resource_links_predicate_check");
  return last;
}

/** The function bodies of every definition of public.resource_links_check_types() in the last
 *  migration that defines it: from the definition to the end of its dollar-quoted body. */
function latestTypeCheck() {
  let last = null;
  for (const m of migrations()) {
    const bodies = [];
    for (const d of m.text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.resource_links_check_types\s*\(\s*\)/gi)) {
      const after = m.text.slice(d.index);
      const open = after.match(/\$([A-Za-z_]*)\$/);
      assert.ok(open, `${m.name}: resource_links_check_types() has no dollar-quoted body`);
      const start = open.index + open[0].length;
      const end = after.indexOf(open[0], start);
      assert.ok(end > start, `${m.name}: resource_links_check_types()'s body is not closed`);
      bodies.push(after.slice(start, end));
    }
    if (bodies.length) last = { file: m.name, bodies };
  }
  assert.ok(last, "no migration defines public.resource_links_check_types()");
  return last;
}

function exporterSlots() {
  const m = read("kg/bbqs_kg.py").match(/^RESOURCE_LINK_SLOTS = frozenset\(\{([^}]*)\}\)/m);
  assert.ok(m, "kg/bbqs_kg.py has no RESOURCE_LINK_SLOTS = frozenset({...}): the exporter writes no resource_links");
  return sorted([...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
}

function jsonPredicates() {
  const path = join(ROOT, "kg", "identity_keys.json");
  assert.ok(existsSync(path), "kg/identity_keys.json is missing");
  const p = JSON.parse(readFileSync(path, "utf8")).resource_link_predicates;
  assert.ok(Array.isArray(p) && p.length, "kg/identity_keys.json has no resource_link_predicates");
  return sorted(p);
}

test("the CHECK, the type check, the exporter and kg/identity_keys.json list the same resource_links predicates", () => {
  const check = latestCheck();
  const types = latestTypeCheck();
  for (const body of types.bodies) {
    const when = sorted([...body.matchAll(/WHEN\s+'{1,2}([a-z_]+)'{1,2}\s+THEN/g)].map((m) => m[1]));
    assert.deepEqual(when, check.predicates,
      `${types.file}'s resource_links_check_types() has a WHEN for ${when.join(", ")}, but ${check.file}'s CHECK allows ${check.predicates.join(", ")}`);
  }
  assert.deepEqual(exporterSlots(), check.predicates,
    `kg/bbqs_kg.py RESOURCE_LINK_SLOTS differs from the predicates ${check.file} lets resource_links hold: a link the exporter skips never reaches the graph`);
  assert.deepEqual(jsonPredicates(), check.predicates, "kg/identity_keys.json resource_link_predicates differs from the CHECK");
});

test("revision_of links a publication to a publication, in the database and in the schema", () => {
  const types = latestTypeCheck();
  for (const body of types.bodies) {
    assert.match(body, /WHEN\s+'{1,2}revision_of'{1,2}\s+THEN\s+_s\s*=\s*'{1,2}publication'{1,2}\s+AND\s+_o\s*=\s*'{1,2}publication'{1,2}/,
      `${types.file}: resource_links_check_types() must accept revision_of only from a publication to a publication`);
  }
  const yaml = read("kg/bbqs.linkml.yaml");
  const slot = yaml.match(/^ {2}revision_of:\s*\{([^}]*)\}/m);
  assert.ok(slot, "kg/bbqs.linkml.yaml declares no revision_of slot");
  assert.match(slot[1], /range:\s*Publication\b/, "revision_of's range is not Publication");
  assert.match(slot[1], /exact_mappings:\s*\[\s*prov:wasRevisionOf\s*\]/, "revision_of does not map to prov:wasRevisionOf");
  const pub = yaml.match(/^ {2}Publication:\n([\s\S]*?)(?=\n {2}[A-Z]|\n\w)/m);
  assert.ok(pub, "no Publication class");
  const slots = pub[1].match(/\n {4}slots:\s*\[([^\]]*)\]/);
  assert.ok(slots && slots[1].split(",").map((s) => s.trim()).includes("revision_of"), "revision_of is not in Publication.slots");
});

test("every resource_links predicate is a slot of the KG schema", () => {
  const section = read("kg/bbqs.linkml.yaml").match(/\nslots:\n([\s\S]*?)(?=\n\w)/);
  assert.ok(section, "no slots: section in kg/bbqs.linkml.yaml");
  const slots = new Set([...section[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]));
  const missing = latestCheck().predicates.filter((p) => !slots.has(p));
  assert.deepEqual(missing, [], "resource_links predicates that are no slot of kg/bbqs.linkml.yaml (the exporter writes bbqs:<predicate>)");
});
