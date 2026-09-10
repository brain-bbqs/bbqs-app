// Tests for the deterministic triage classifier (scripts/triage/classify.mjs).
//
// The classifier decides how much gate a bot PR gets. Its guarantees are load-bearing: if a
// migration ever slipped into Class A, a hand-applied schema change could reach production on one
// click. These tests pin the guarantees that must never regress — most-severe first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, parseNumstat, THRESHOLDS } from "../../scripts/triage/classify.mjs";

const f = (path, additions = 5, deletions = 0, status = "modified") => ({ path, additions, deletions, status });

// ── Class C: danger layers can NEVER be anything lighter ────────────────────────────────────────
test("a migration is Class C even as a one-line change", () => {
  const r = classify([f("supabase/migrations/20260910_add_index.sql", 1, 0, "added")]);
  assert.equal(r.klass, "C");
  assert.equal(r.blast.level, "high");
});

test("shared edge code is Class C", () => {
  assert.equal(classify([f("supabase/functions/_shared/auth.ts", 2, 1)]).klass, "C");
});

test("the classifier CANNOT classify a change to itself below C (no self-approval)", () => {
  assert.equal(classify([f("scripts/triage/classify.mjs", 1, 0)]).klass, "C");
  assert.equal(classify([f("tests/guards/role-vocabulary-parity.test.mjs", 1, 0)]).klass, "C");
});

test("a workflow change is Class C", () => {
  assert.equal(classify([f(".github/workflows/publish.yml", 3, 0)]).klass, "C");
});

test("auth and the supabase client are Class C", () => {
  assert.equal(classify([f("src/pages/Auth.tsx", 4, 2)]).klass, "C");
  assert.equal(classify([f("src/integrations/supabase/client.ts", 1, 1)]).klass, "C");
});

test("a new dependency is Class C", () => {
  assert.equal(classify([f("package.json", 1, 0)]).klass, "C");
  assert.equal(classify([f("bun.lock", 40, 0)]).klass, "C");
});

test("the production CNAME is Class C", () => {
  assert.equal(classify([f("public/CNAME", 1, 1)]).klass, "C");
});

test("role-vocabulary surfaces are Class C", () => {
  assert.equal(classify([f("supabase/functions/sync-member-groups/index.ts", 2, 0)]).klass, "C");
});

// ── Class B: real logic, scoped ─────────────────────────────────────────────────────────────────
test("a non-shared edge function body is at least Class B", () => {
  const r = classify([f("supabase/functions/nih-grants/index.ts", 10, 4)]);
  assert.equal(r.klass, "B");
  assert.equal(r.blast.level, "medium");
});

test("the app shell / global nav is Class B", () => {
  assert.equal(classify([f("src/App.tsx", 3, 1)]).klass, "B");
  assert.equal(classify([f("src/data/sidebar-config.ts", 2, 0)]).klass, "B");
});

test("a low-blast change over the size ceilings is Class B, not A", () => {
  const big = classify([f("src/pages/About.tsx", THRESHOLDS.maxLines + 1, 0)]);
  assert.equal(big.klass, "B");
  assert.equal(big.blast.level, "low");
  assert.equal(big.complexity.level, "high");
});

test("too many files pushes a low-blast change to B", () => {
  const many = Array.from({ length: THRESHOLDS.maxFiles + 1 }, (_, i) => f(`src/components/C${i}.tsx`, 2, 0));
  assert.equal(classify(many).klass, "B");
});

test("an unrecognized path is B, not A (unknown reach is not trivial)", () => {
  assert.equal(classify([f("weird/place/thing.py", 1, 0)]).klass, "B");
});

// ── Class A: the only things that ride the light gate ──────────────────────────────────────────
test("a small docs-only change is Class A", () => {
  const r = classify([f("docs/onboarding-a-new-award.md", 8, 2)]);
  assert.equal(r.klass, "A");
  assert.equal(r.blast.level, "low");
  assert.equal(r.complexity.level, "low");
});

test("a small copy tweak to a single leaf page is Class A", () => {
  assert.equal(classify([f("src/pages/About.tsx", 6, 3)]).klass, "A");
});

test("a small style-only change is Class A", () => {
  assert.equal(classify([f("src/index.css", 4, 1)]).klass, "A");
});

test("a mixed danger + trivial diff takes the danger class (worst wins)", () => {
  const r = classify([f("docs/readme.md", 2, 0), f("supabase/migrations/x.sql", 1, 0, "added")]);
  assert.equal(r.klass, "C");
});

// ── numstat parsing ─────────────────────────────────────────────────────────────────────────────
test("parseNumstat reads git diff --numstat, including renames and binaries", () => {
  const out = parseNumstat(
    ["8\t2\tdocs/a.md", "-\t-\tpublic/logo.png", "3\t0\tsrc/{old => new}/x.tsx"].join("\n"),
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].path, "docs/a.md");
  assert.equal(out[0].additions, 8);
  assert.equal(out[1].path, "public/logo.png"); // binary: additions/deletions 0
  assert.equal(out[2].path, "src/new/x.tsx");
});
