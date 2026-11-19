// Guard: onboarding keeps every role the roster can store, and every role menu offers only those.
//
// WHY. onboard_member normalises its _role argument with its own CASE, a second copy of the
// vocabulary in normalize_grant_role, and sends anything it doesn't list to research_staff. When
// 'collaborator' became a roster role (20261118140000), onboarding a collaborator still stored
// research_staff, silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => readFileSync(ROOT + rel, "utf8").replace(/\r\n/g, "\n");

function latestBody(name) {
  const dir = "supabase/migrations/";
  const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\)\\s*RETURNS[\\s\\S]*?AS (\\$\\w*\\$)([\\s\\S]*?)\\1`, "i");
  const defs = readdirSync(ROOT + dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => read(dir + f).match(re)).filter(Boolean);
  assert.ok(defs.length, `no migration defines public.${name}`);
  return defs.at(-1)[2];
}

const thenTargets = (text) => [...new Set([...text.matchAll(/\bthen\s+'([^']+)'/gi)].map((m) => m[1]))].sort();

const rosterTokens = () => thenTargets(latestBody("normalize_grant_role"));

/** What a roster write may send: a token, a spelling normalize_grant_role maps, or trainee, which
 *  it passes through on purpose (see kg-role-vocabulary-parity). */
function rosterInputs() {
  const body = latestBody("normalize_grant_role");
  return new Set([...rosterTokens(), ...[...body.matchAll(/\bwhen\s+'([^']+)'/gi)].map((m) => m[1]), "trainee"]);
}

function onboardTokens() {
  const m = latestBody("onboard_member").match(/_role_n\s*:=\s*CASE\s+_role_n([\s\S]*?)\bEND\s*;/i);
  assert.ok(m, "could not find onboard_member's `_role_n := CASE _role_n ... END;`");
  return thenTargets(m[1].replace(/\bELSE\s+'[^']+'/i, ""));
}

function menuValues(rel) {
  return [...read(rel).matchAll(/\{\s*value:\s*"([^"]+)",\s*label:/g)].map((m) => m[1]);
}

test("onboard_member keeps exactly the roles normalize_grant_role stores", () => {
  assert.deepEqual(onboardTokens(), rosterTokens(),
    "onboard_member's role CASE disagrees with normalize_grant_role. A role it doesn't list is " +
      "stored as research_staff without an error.");
});

for (const rel of ["src/components/admin/OnboardMemberDialog.tsx", "src/components/project-profile/TeamRosterEditor.tsx"]) {
  test(`every role offered in ${rel.split("/").pop()} is one the roster accepts`, () => {
    const values = menuValues(rel);
    assert.ok(values.length, `no { value, label } role options found in ${rel}`);
    const known = rosterInputs();
    assert.deepEqual(values.filter((v) => !known.has(v)), [], `${rel} offers roles normalize_grant_role neither maps nor stores`);
  });
}
