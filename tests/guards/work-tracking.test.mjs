// Guard: the rule that decides whether a change is tracked by an issue (scripts/tracking/).
//
// WHY. Every non-trivial change must trace to an issue so the project board, and the progress page
// built from it, see all the work. The rule must not be fooled in either direction: a KG invariant
// mentioned as "#7" is not an issue reference, and a 400 KB regenerated Inspector page is not 400 KB
// of work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { referencesIssue, markedTrivial, size, isTiny, issueRefs, nextStatus } from "../../scripts/tracking/tracking.mjs";

const HERE = "brain-bbqs/bbqs-app";

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

// The board half: which issues a change moves on the project board. Stricter than the `tracked`
// check, because a wrong match moves someone else's issue: "see #5" and "guard for #19" name no work.
test("issueRefs finds every issue a change names, and whether it closes it", () => {
  const refs = text => issueRefs(text, HERE).map(r => `${r.repo}#${r.number}${r.closes ? " closes" : ""}`);
  assert.deepEqual(refs("feat: x\n\nRefs #421"), ["brain-bbqs/bbqs-app#421"]);
  assert.deepEqual(refs("Closes #12, #13 and #14"), ["brain-bbqs/bbqs-app#12 closes", "brain-bbqs/bbqs-app#13 closes", "brain-bbqs/bbqs-app#14 closes"]);
  assert.deepEqual(refs("Fixes brain-bbqs/bbqs-agent#9"), ["brain-bbqs/bbqs-agent#9 closes"]);
  assert.deepEqual(refs("Part of #386; tracked by https://github.com/brain-bbqs/bbqs-app/issues/440"),
                   ["brain-bbqs/bbqs-app#386", "brain-bbqs/bbqs-app#440"]);
  assert.deepEqual(refs("Refs #421\nCloses #421"), ["brain-bbqs/bbqs-app#421 closes"]);
});

test("issueRefs ignores what isn't a work reference", () => {
  for (const msg of ["#7 8->6", "restore #19 guard", "see #5", "the guard for #19", "Merge pull request #472 from x/y", "", null]) {
    assert.deepEqual(issueRefs(msg, HERE), [], String(msg));
  }
});

test("nextStatus only moves an issue forward, never back out of Done", () => {
  for (const s of [null, undefined, "", "Todo", "Backlog"]) assert.equal(nextStatus(s), "In progress", String(s));
  for (const s of ["In progress", "Done"]) assert.equal(nextStatus(s), null, s);
});
