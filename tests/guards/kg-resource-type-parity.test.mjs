// Guard: the KG schema's node-type vocabulary must not drift from the database's.
//
// WHY. resources.resource_type is the rdf:type discriminator for the whole knowledge graph — every
// node is exactly one of its values. The KG master schema (kg/bbqs.linkml.yaml, enum
// resource_type_enum) is now a THIRD independent copy of that vocabulary, alongside the Postgres
// enum and the app's generated types. When copies of an enum drift, the failure is the one
// sync-prod-schema.yml was built to stop: "code shipped, migration didn't" —
// `invalid input value for enum resource_type` at runtime, or an exporter that emits nodes SHACL
// can't type. A prose "keep these in sync" note cannot hold three copies together; this test can.
//
// The LinkML enum deliberately carries PROPOSED values (species, device, working_group, …) that the
// enum-extend + resource_id backfill migration has not added yet. So the contract is two-sided:
//   • every SHIPPED LinkML value exists in the DB enum, and vice versa (exact parity);
//   • no PROPOSED value is in the DB yet — once the migration lands, that value must be promoted
//     from PROPOSED to shipped here, which this test forces you to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** DB truth: the runtime `resource_type: [ ... ]` array in the generated Supabase types. */
function dbResourceTypes() {
  const src = readFileSync(ROOT + "src/integrations/supabase/types.ts", "utf8");
  // Only the runtime Constants array is `resource_type:` immediately followed by `[`; the type
  // union uses `|` and the Row fields use `Database[...]`, so neither matches.
  const m = src.match(/resource_type:\s*\[([^\]]*)\]/);
  assert.ok(m, "could not find the runtime resource_type enum array in types.ts");
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort();
}

/** KG schema: resource_type_enum permissible values, split into shipped vs PROPOSED. */
function linkmlResourceTypes() {
  const src = readFileSync(ROOT + "kg/bbqs.linkml.yaml", "utf8");
  const block = src.match(/\n {2}resource_type_enum:\n([\s\S]*?)(?=\n {2}\w+_enum:|\n\w|$)/);
  assert.ok(block, "could not find resource_type_enum in kg/bbqs.linkml.yaml");
  const pv = block[1].match(/permissible_values:\n([\s\S]*)/);
  assert.ok(pv, "resource_type_enum has no permissible_values");
  const shipped = [];
  const proposed = [];
  for (const line of pv[1].split("\n")) {
    const m = line.match(/^ {6}([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    (/PROPOSED/.test(m[2]) ? proposed : shipped).push(m[1]);
  }
  return { shipped: shipped.sort(), proposed: proposed.sort() };
}

test("KG resource_type_enum (shipped) is exactly the DB resource_type enum", () => {
  const db = dbResourceTypes();
  const { shipped } = linkmlResourceTypes();
  assert.deepEqual(
    shipped,
    db,
    "kg/bbqs.linkml.yaml shipped resource_type values disagree with the DB enum. Add the missing " +
      "value to whichever side is behind — a value the exporter emits but the DB enum lacks fails " +
      "at insert time; a DB value the schema lacks yields untyped/unvalidated graph nodes.",
  );
});

test("no PROPOSED resource_type is already in the DB (promote it if it is)", () => {
  const db = new Set(dbResourceTypes());
  const { proposed } = linkmlResourceTypes();
  const landed = proposed.filter((v) => db.has(v));
  assert.deepEqual(
    landed,
    [],
    `these resource_type values are marked PROPOSED in kg/bbqs.linkml.yaml but already exist in the ` +
      `DB enum: ${landed.join(", ")}. The backfill migration has landed — move them out of the ` +
      `PROPOSED block into shipped so the parity test above covers them.`,
  );
});
