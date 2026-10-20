// Guard: the rule that decides whether a change is tracked by an issue (scripts/tracking/).
//
// WHY. Every non-trivial change must trace to an issue so the project board, and the progress page
// built from it, see all the work. The rule must not be fooled in either direction: a KG invariant
// mentioned as "#7" is not an issue reference, and a 400 KB regenerated Inspector page is not 400 KB
// of work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { referencesIssue, markedTrivial, size, isTiny } from "../../scripts/tracking/tracking.mjs";

test("a keyword plus an issue number is a reference", () => {
  for (const msg of ["Refs #421", "Closes #12", "fixes #3", "Part of #386", "Tracks brain-bbqs/bbqs-app#386",
                     "see https://github.com/brain-bbqs/bbqs-app/issues/440", "Fixes brain-bbqs/bbqs-agent#9"]) {
    assert.equal(referencesIssue(msg), true, msg);
  }
});

test("a bare #N (a KG invariant, a PR mention) is not a reference", () => {
  for (const msg of ["#7 8->6", "invariants #1/#3/#6/#10/#20 in SHACL", "restore #19 guard", "", null]) {
    assert.equal(referencesIssue(msg), false, String(msg));
  }
});

test("[trivial] marks a change trivial", () => {
  assert.equal(markedTrivial("docs: fix typo [trivial]"), true);
  assert.equal(markedTrivial("docs: fix typo"), false);
});

test("size leaves out generated files, so a rebuild is tiny and real work is not", () => {
  const rebuild = "9000\t9000\tkg/browser/index.html\n4000\t4000\tkg/export/quality.json";
  assert.equal(isTiny(size(rebuild)), true);
  const work = "120\t4\tkg/quality.py\n30\t0\tkg/README.md";
  assert.deepEqual(size(work), { lines: 154, files: 2 });
  assert.equal(isTiny(size(work)), false);
  assert.equal(isTiny(size("3\t1\tREADME.md")), true);
});
