// Guard: every project role a screen or function can write is one the database vocabulary knows.
//
// WHY (2026-11-18). grant_investigators.role holds canonical tokens only: normalize_grant_role, behind
// trg_normalize_grant_role, maps what it recognises and passes anything else through unchanged. The
// KG schema's project_role_enum and shape #4 are held equal to that function
// (tests/guards/kg-role-vocabulary-parity). Nothing held the SCREENS to it. The roster editor and the
// person summary have always offered "Collaborator"; the normalizer never listed it, so the value was
// stored as an unknown token, and the first curator who chose it (U24DA064429, between the exports of
// 2026-11-17 and 2026-11-18) put a violation into the graph that no data fix could clear. The same
// shape as #496 (`other`), one layer further out.
//
// Every value a role menu offers, and every role a parser may return, must be an input
// normalize_grant_role maps on purpose (a WHEN key) or one it passes through on purpose (trainee).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => readFileSync(ROOT + rel, "utf8").replace(/\r\n/g, "\n");

/** Passed through unmapped on purpose (see normalize_grant_role's own comment). */
const PASSED_THROUGH = ["trainee"];

/** The inputs the latest normalize_grant_role maps: every WHEN '<input>' of its CASE. */
export function normalizerInputs(sqlFiles) {
  const defs = sqlFiles
    .map((src) => [...src.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.normalize_grant_role\([^)]*\)[^$]*?AS (\$\w*\$)([\s\S]*?)\1/gi)].at(-1))
    .filter(Boolean);
  assert.ok(defs.length, "no migration defines public.normalize_grant_role");
  const body = defs.at(-1)[2].replace(/--[^\n]*/g, " ");
  const inputs = [...body.matchAll(/\bwhen\s+'([^']+)'/gi)].map((m) => m[1].toLowerCase());
  assert.ok(inputs.length, "could not read the WHEN inputs of normalize_grant_role");
  return new Set(inputs);
}

/** `value: "x"` entries of the array literal assigned to `name` in a file. */
export function arrayValues(src, name) {
  const m = src.match(new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*;`));
  assert.ok(m, `could not find the array ${name}`);
  const objects = [...m[1].matchAll(/\bvalue:\s*["']([^"']+)["']/g)].map((x) => x[1]);
  return objects.length ? objects : [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

/** <option value="x"> entries of the <select> whose value is {role}. */
export function roleSelectOptions(src) {
  const m = src.match(/<select\s[^>]*value=\{role\}[\s\S]*?<\/select>/);
  assert.ok(m, "could not find the role <select>");
  return [...m[0].matchAll(/<option\s+value=["']([^"']+)["']/g)].map((x) => x[1]);
}

const SURFACES = [
  ["src/components/project-profile/TeamRosterEditor.tsx", (src) => arrayValues(src, "ROLES")],
  ["src/components/admin/OnboardMemberDialog.tsx", (src) => arrayValues(src, "ROLES")],
  ["src/components/entity-summary/summaries/InvestigatorSummary.tsx", roleSelectOptions],
  ["supabase/functions/parse-onboard/index.ts", (src) => arrayValues(src, "ROLES")],
];

test("the readers find role values in an array of options, a plain array and a role <select>", () => {
  assert.deepEqual(arrayValues('const ROLES = [\n  { value: "pi", label: "PI" },\n  { value: "made_up", label: "x" },\n];', "ROLES"), ["pi", "made_up"]);
  assert.deepEqual(arrayValues('const ROLES = ["co_pi", "other"\n];', "ROLES"), ["co_pi", "other"]);
  assert.deepEqual(roleSelectOptions('<select\n value={role}>\n<option value="pi">PI</option><option value="made_up">X</option>\n</select>'), ["pi", "made_up"]);
  const known = normalizerInputs(["CREATE OR REPLACE FUNCTION public.normalize_grant_role(_role text)\nRETURNS text LANGUAGE sql AS $fn$\n SELECT CASE lower(_role) WHEN 'pi' then 'PI' -- WHEN 'ghost' then 'x'\n WHEN 'staff' then 'research_staff' ELSE _role END\n$fn$;"]);
  assert.deepEqual([...known].sort(), ["pi", "staff"]);
});

test("every role a screen or a parser can write is one normalize_grant_role knows", () => {
  const dir = "supabase/migrations/";
  const known = normalizerInputs(readdirSync(ROOT + dir).filter((f) => f.endsWith(".sql")).sort().map((f) => read(dir + f)));
  const unknown = [];
  for (const [path, values] of SURFACES) {
    const offered = values(read(path));
    assert.ok(offered.length >= 3, `${path}: found only ${offered.length} role values`);
    for (const v of offered) {
      if (!known.has(v.toLowerCase()) && !PASSED_THROUGH.includes(v)) unknown.push(`${path}: "${v}"`);
    }
  }
  assert.deepEqual(unknown, [],
    "These role values can be written to grant_investigators.role, but normalize_grant_role does not list "
    + "them: they are stored as unknown tokens, and the graph (project_role_enum, shape #4) then reports an "
    + "error no data fix can clear. Add the value to normalize_grant_role in a new migration (the KG enum and "
    + "the shape follow it: tests/guards/kg-role-vocabulary-parity), or stop offering it.");
});
