import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// The working-group list is spelled out in the DB and again in each surface that offers, filters or
// syncs working groups. Adding WG-Cross-Species touched a dozen of them; any one missed silently
// hides the new group there (no picker option, no Google-Group sync, no filter chip). This checks
// every such surface against the DB's single definition, public.working_group_tokens().

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

function dbTokens() {
  const dir = new URL("supabase/migrations/", root);
  const file = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .find((f) => /FUNCTION public\.working_group_tokens\(\)/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.ok(file, "no migration defines public.working_group_tokens()");
  const body = readFileSync(new URL(file, dir), "utf8")
    .match(/FUNCTION public\.working_group_tokens\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]/);
  assert.ok(body, `could not read the ARRAY[...] in ${file}`);
  return [...body[1].matchAll(/'(WG-[A-Za-z-]+)'/g)].map((m) => m[1]);
}

// Surfaces that must offer or recognise every working group, by stored token.
const TOKEN_SURFACES = [
  "src/components/admin/OnboardMemberDialog.tsx",
  "src/components/admin/ResolveStageDialog.tsx",
  "src/components/profile/MemberProfileEditor.tsx",
  "src/components/entity-summary/summaries/InvestigatorSummary.tsx",
  "src/pages/AdminUsers.tsx",
  "src/pages/PrincipalInvestigators.tsx",
  "src/pages/WorkingGroups.tsx",
  "supabase/functions/parse-onboard/index.ts",
  "supabase/functions/group-audit/index.ts",
  "supabase/functions/bbqs-mcp/index.ts",
];

// Surfaces that must know every working group's Google Group address.
const ADDRESS_SURFACES = [
  "supabase/functions/sync-member-groups/index.ts",
  "supabase/functions/group-audit/index.ts",
  "src/components/entity-summary/summaries/WorkingGroupSummary.tsx",
];

const address = (token) => `${token.toLowerCase()}@brain-bbqs.org`;

test("the DB defines a non-trivial working-group list", () => {
  assert.ok(dbTokens().length >= 5, "working_group_tokens() parsed to fewer than 5 tokens");
});

for (const file of TOKEN_SURFACES) {
  test(`${file} names every working group`, () => {
    const src = read(file);
    const missing = dbTokens().filter((t) => !src.includes(t));
    assert.deepEqual(missing, [], `${file} is missing: ${missing}`);
  });
}

for (const file of ADDRESS_SURFACES) {
  test(`${file} knows every working group's Google Group`, () => {
    const src = read(file);
    const missing = dbTokens().map(address).filter((a) => !src.includes(a));
    assert.deepEqual(missing, [], `${file} is missing: ${missing}`);
  });
}
