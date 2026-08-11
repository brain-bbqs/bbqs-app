// Guard: every surface that decides "is this a PI role" must use the SAME set of tokens.
//
// WHY (issue #283). The canonical role vocabulary is declared independently in several places, and
// they silently drifted apart:
//   supabase/functions/group-audit/index.ts        PI_ROSTER_ROLES = pi, contact_pi, co_pi, mpi
//   supabase/functions/sync-member-groups/index.ts PI_ROSTER_ROLES = (same, only since cf10b70)
//   supabase/functions/_shared/grant-sync.ts       PI_LIKE          = pi, contact_pi, co_pi, mpi
//
// Before cf10b70, sync-member-groups matched investigators.role instead of the roster and so used a
// different rule entirely: 74 investigators held a PI role on the grant roster while only 9 had a
// canonical token in investigators.role, meaning that trigger missed 65 real PIs. group-audit
// computed the expected pi@ set FROM the roster, so the two disagreed and the audit reported drift
// that no repair could settle. Nothing failed loudly; the sets just differed.
//
// A prose convention cannot hold three copies of a vocabulary in sync across two languages and a
// migration. This test can. If a surface adds or drops a PI token, it fails here rather than in
// Google Group membership months later.
//
// Deliberately NOT asserting the career-stage rule: that one matches investigators.role by SUBSTRING
// against raw Google-Form labels ("Postdoc/Grad Student", "Research Staff (Scientist and others)"),
// which is correct precisely because it is not an exact-token comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The one true PI set. co-investigator is deliberately absent: it sits on the award but is NOT a PI
 *  for mailing-list purposes (policy 2026-08-07, after 24 co-investigators landed on pi@). */
const CANONICAL_PI_ROLES = ["pi", "contact_pi", "co_pi", "mpi"];

/** Pull the string literals out of a `new Set([...])` / `= [...]` declaration by name. */
function declaredSet(relPath, declName) {
  const src = readFileSync(ROOT + relPath, "utf8");
  const re = new RegExp(`${declName}\\s*=\\s*(?:new Set\\()?\\[([^\\]]*)\\]`, "s");
  const m = src.match(re);
  assert.ok(m, `${relPath}: could not find a declaration named ${declName}`);
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1].toLowerCase()).sort();
}

const SURFACES = [
  ["supabase/functions/group-audit/index.ts", "PI_ROSTER_ROLES"],
  ["supabase/functions/sync-member-groups/index.ts", "PI_ROSTER_ROLES"],
  ["supabase/functions/_shared/grant-sync.ts", "PI_LIKE"],
];

test("every surface agrees on the canonical PI role set", () => {
  const expected = [...CANONICAL_PI_ROLES].sort();
  for (const [path, decl] of SURFACES) {
    assert.deepEqual(
      declaredSet(path, decl),
      expected,
      `${path} (${decl}) disagrees with the canonical PI role set. ` +
        `Divergence here does not fail loudly — it shows up as wrong Google Group membership.`,
    );
  }
});

test("co-investigator is never treated as a PI role", () => {
  for (const [path, decl] of SURFACES) {
    assert.ok(
      !declaredSet(path, decl).includes("co-investigator"),
      `${path} (${decl}) includes co-investigator. Policy 2026-08-07: only people NIH records as a ` +
        `PI on the award belong on pi@ — the broad rule put 24 co-investigators there.`,
    );
  }
});

test("pi@ entitlement is derived from the roster, not from investigators.role", () => {
  const src = readFileSync(ROOT + "supabase/functions/sync-member-groups/index.ts", "utf8");
  assert.match(
    src,
    /grant_investigators/,
    "sync-member-groups must read grant_investigators to decide pi@. Deciding it from " +
      "investigators.role missed 65 of 74 real PIs, because that column holds free-text form labels.",
  );
});
