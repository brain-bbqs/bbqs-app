import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// slack-channels looked a member up in Slack under the one email it was handed. Members often
// joined Slack under another address (a new institution, a personal account); the KG keeps those
// in secondary_emails. Suthana was reported "not in workspace" for 96 days under her old UCLA
// address while she was in Slack under her Duke one. Every lookup must go through lookupMember,
// which tries all of a member's addresses.

const src = readFileSync(new URL("../../supabase/functions/slack-channels/index.ts", import.meta.url), "utf8");

test("every Slack user lookup goes through lookupMember", () => {
  const fn = src.match(/async function lookupMember\([\s\S]*?\n\}/);
  assert.ok(fn, "slack-channels has no lookupMember()");
  const calls = [...src.matchAll(/"users\.lookupByEmail"/g)].map((m) => m.index);
  assert.equal(calls.length, 1, `expected exactly one users.lookupByEmail call (inside lookupMember), found ${calls.length}`);
  assert.ok(calls[0] > fn.index && calls[0] < fn.index + fn[0].length, "the users.lookupByEmail call is outside lookupMember");
});

test("orderedCandidates tries the requested address first, then each other address once", () => {
  const m = src.match(/function orderedCandidates\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(m, "slack-channels has no orderedCandidates()");
  const orderedCandidates = new Function("requested", "primary", "secondaries", m[1]);
  assert.deepEqual(
    orderedCandidates("nanthia@ucla.edu", "nanthia@ucla.edu", ["Nanthia.Suthana@duke.edu", "", null]),
    ["nanthia@ucla.edu", "nanthia.suthana@duke.edu"]);
  assert.deepEqual(
    orderedCandidates("jsw82@duke.edu", "joel.s.white@duke.edu", ["jsw82@duke.edu"]),
    ["jsw82@duke.edu", "joel.s.white@duke.edu"]);
  assert.deepEqual(orderedCandidates("a@x.org", null, undefined), ["a@x.org"]);
});
