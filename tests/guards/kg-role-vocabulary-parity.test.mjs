// Guard: the graph's per-project role vocabulary must be exactly what the database can store.
//
// WHY (#496). normalize_grant_role, behind trg_normalize_grant_role, decides which tokens
// grant_investigators.role may hold. The KG schema's project_role_enum and the hand-written #4 shape
// (ProjectRoleTokenShape) were copies of a September snapshot of the data, not of that function.
// When curators added 15 roster rows coded `other`, a token the database has always accepted, the
// graph reported 15 errors that no data fix could clear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => readFileSync(ROOT + rel, "utf8").replace(/\r\n/g, "\n");

/** Values normalize_grant_role's ELSE branch lets through unmapped on purpose (see its comment). */
const PASSED_THROUGH = ["trainee"];

/** DB truth: every THEN target of the latest normalize_grant_role definition. */
function dbRoleTokens() {
  const dir = "supabase/migrations/";
  const defs = readdirSync(ROOT + dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => read(dir + f))
    .map((src) => src.match(/CREATE (?:OR REPLACE )?FUNCTION public\.normalize_grant_role\([^)]*\)[^$]*?AS (\$\w*\$)([\s\S]*?)\1/i))
    .filter(Boolean);
  assert.ok(defs.length, "no migration defines public.normalize_grant_role");
  const body = defs.at(-1)[2];
  const tokens = [...body.matchAll(/\bthen\s+'([^']+)'/gi)].map((m) => m[1]);
  assert.ok(tokens.length, "could not read the THEN targets of normalize_grant_role");
  return [...new Set([...tokens, ...PASSED_THROUGH])].sort();
}

function linkmlRoleTokens() {
  const src = read("kg/bbqs.linkml.yaml");
  const block = src.match(/\n {2}project_role_enum:\n([\s\S]*?)(?=\n {2}\w+_enum:|\n\w|$)/);
  assert.ok(block, "could not find project_role_enum in kg/bbqs.linkml.yaml");
  const pv = block[1].match(/permissible_values:\n([\s\S]*)/);
  assert.ok(pv, "project_role_enum has no permissible_values");
  return [...pv[1].matchAll(/^ {6}([A-Za-z_-]+):/gm)].map((m) => m[1]).sort();
}

function shapeRoleTokens() {
  const src = read("kg/shapes/consistency.shapes.ttl");
  const m = src.match(/bbqs:ProjectRoleTokenShape\b[\s\S]*?sh:in\s*\(([^)]*)\)/);
  assert.ok(m, "could not find the sh:in list of ProjectRoleTokenShape");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

test("KG project_role_enum is exactly what normalize_grant_role can store", () => {
  assert.deepEqual(
    linkmlRoleTokens(),
    dbRoleTokens(),
    "kg/bbqs.linkml.yaml project_role_enum disagrees with normalize_grant_role. A token the DB " +
      "stores but the enum lacks is a graph error no data fix can clear; a token the enum has but the " +
      "DB never stores is a role the graph accepts and the database would rewrite or reject.",
  );
});

test("the #4 shape accepts the same role tokens as the schema", () => {
  assert.deepEqual(
    shapeRoleTokens(),
    linkmlRoleTokens(),
    "ProjectRoleTokenShape's sh:in (kg/shapes/consistency.shapes.ttl) disagrees with project_role_enum.",
  );
});
