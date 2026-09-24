// Guard: the OWL disjointness axioms (kg/owl/disjointness.ttl) cover every node class, and mirror
// every LinkML `disjoint_with`.
//
// WHY. gen-owl silently drops LinkML `disjoint_with` (Phase 4), so the reasoner's disjointness lives
// in a hand-written file: a second copy of "which classes are node classes". Hand copies drift. A
// new class added to the schema but not to the AllDisjointClasses list is invisible to invariants
// #1/#3 — a node typed as it AND an Investigator reasons as consistent, and nothing says so. The
// reasoner itself can't catch this (a missing axiom is not a contradiction), so this test does.
//
// Contract:
//   • every concrete LinkML class is an AllDisjointClasses member, a subclass (is_a) of one, or in
//     NOT_NODE_CLASSES below with a reason;
//   • every class the exporter types a node with is covered the same way;
//   • every `disjoint_with: [X]` on class C appears as `bbqs:C owl:disjointWith bbqs:X` (either way).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8").replace(/\r\n/g, "\n");

/** Concrete classes that are deliberately not pairwise-disjoint node classes. Each needs a reason. */
const NOT_NODE_CLASSES = {
  // External-ontology term stubs (Cognitive Atlas / UBERON / NBO), reserved for the Marr layer.
  // Not spine nodes; whether a construct can also be a task is the source ontology's call, not ours.
  BehavioralConstruct: "external ontology term",
  AnatomicalSite: "external ontology term",
  CognitiveTask: "external ontology term",
};

function linkmlClasses() {
  const src = read("kg/bbqs.linkml.yaml");
  const section = src.match(/\nclasses:\n([\s\S]*?)(?=\n[a-z_]+:\s*\n|$)/);
  assert.ok(section, "no classes: section in kg/bbqs.linkml.yaml");
  const classes = {};
  const re = /^ {2}([A-Z]\w*):(.*)\n((?: {4,}.*\n|\s*\n|\s*#.*\n)*)/gm;
  for (const m of section[1].matchAll(re)) {
    const body = m[2] + "\n" + m[3];
    const isA = body.match(/is_a:\s*(\w+)/);
    const disj = body.match(/disjoint_with:\s*\[([^\]]*)\]/);
    classes[m[1]] = {
      abstract: /abstract:\s*true/.test(body),
      isA: isA ? isA[1] : null,
      disjointWith: disj ? disj[1].split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
  }
  assert.ok(Object.keys(classes).length > 20, "parsed suspiciously few LinkML classes");
  return classes;
}

function axioms() {
  const src = read("kg/owl/disjointness.ttl").replace(/#.*$/gm, "");
  const list = src.match(/owl:AllDisjointClasses\s*;\s*owl:members\s*\(([^)]*)\)/);
  assert.ok(list, "no owl:AllDisjointClasses member list in kg/owl/disjointness.ttl");
  const members = [...list[1].matchAll(/bbqs:(\w+)/g)].map((m) => m[1]);
  const pairs = [...src.matchAll(/bbqs:(\w+)\s+owl:disjointWith\s+bbqs:(\w+)/g)].map((m) => [m[1], m[2]]);
  return { members: new Set(members), pairs };
}

function covered(name, classes, members) {
  for (let c = name, seen = 0; c && seen < 20; c = classes[c]?.isA, seen++) {
    if (members.has(c)) return true;
  }
  return false;
}

test("every concrete LinkML class is covered by the OWL disjointness axioms", () => {
  const classes = linkmlClasses();
  const { members } = axioms();
  const missing = Object.entries(classes)
    .filter(([n, c]) => !c.abstract && !n.endsWith("Enum") && !(n in NOT_NODE_CLASSES))
    .filter(([n]) => !covered(n, classes, members))
    .map(([n]) => n);
  assert.deepEqual(
    missing,
    [],
    `LinkML classes missing from owl:AllDisjointClasses in kg/owl/disjointness.ttl: ${missing.join(", ")}. ` +
      "Add them to the member list (or, if they are a subclass of a member, add the is_a), or to " +
      "NOT_NODE_CLASSES here with a reason.",
  );
});

test("no AllDisjointClasses member is a subclass of another (that makes it unsatisfiable)", () => {
  const classes = linkmlClasses();
  const { members } = axioms();
  const bad = [...members].filter((m) => {
    for (let c = classes[m]?.isA; c; c = classes[c]?.isA) if (members.has(c)) return true;
    return false;
  });
  assert.deepEqual(bad, [], `members that inherit from another member: ${bad.join(", ")}`);
  const unknown = [...members].filter((m) => !(m in classes));
  assert.deepEqual(unknown, [], `members that are not LinkML classes: ${unknown.join(", ")}`);
});

test("every class the exporter types a node with is covered", () => {
  const classes = linkmlClasses();
  const { members } = axioms();
  const src = read("kg/export.py");
  const typeMap = src.match(/TYPE_CLASS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(typeMap, "no TYPE_CLASS map in kg/export.py");
  const emitted = new Set([
    ...[...typeMap[1].matchAll(/:\s*"(\w+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/RDF\.type,\s*BBQS\["(\w+)"\]/g)].map((m) => m[1]),
  ]);
  const missing = [...emitted].filter((c) => !covered(c, classes, members));
  assert.deepEqual(missing, [], `exporter emits classes outside the disjointness axioms: ${missing.join(", ")}`);
});

test("every LinkML disjoint_with is mirrored as owl:disjointWith (gen-owl drops it)", () => {
  const classes = linkmlClasses();
  const { pairs } = axioms();
  const has = (a, b) => pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const missing = [];
  for (const [name, c] of Object.entries(classes)) {
    for (const other of c.disjointWith) if (!has(name, other)) missing.push(`${name} ⊥ ${other}`);
  }
  assert.deepEqual(missing, [], `disjoint_with not mirrored in kg/owl/disjointness.ttl: ${missing.join(", ")}`);
});
