// Guard: the Class-C spec gate is released only by a listed signer, and only for the commits signed.
//
// WHY (#513 decision 4). The gate read "is the `spec-signoff` label present", and anyone with triage
// rights can add a label, so an author could release the gate on their own PR, and a sign-off given
// once kept covering every later push. This runs the gate's own script from triage.yml against a fake
// GitHub client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const yml = readFileSync(ROOT + ".github/workflows/triage.yml", "utf8").replace(/\r\n/g, "\n");

function gateScript() {
  const step = yml.split(/\n {6}- name: /).find((s) => s.startsWith("Class-C spec gate"));
  assert.ok(step, "triage.yml has no 'Class-C spec gate' step");
  const lines = step.split("\n");
  const at = lines.findIndex((l) => /^\s+script: \|\s*$/.test(l));
  assert.ok(at >= 0, "the gate step has no `script: |` block");
  const body = lines.slice(at + 1);
  const indent = body.find((l) => l.trim())?.match(/^ */)[0].length ?? 0;
  return body.map((l) => l.slice(indent)).join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function runGate({ klass = "C", action = "labeled", labeled = true, labeledBy = [] }) {
  const calls = { statuses: [], removed: [], comments: [] };
  const events = labeledBy.map((login) => ({ event: "labeled", label: { name: "spec-signoff" }, actor: { login } }));
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      repos: { createCommitStatus: async (s) => calls.statuses.push(s) },
      issues: {
        listEvents: async () => ({ data: events }),
        removeLabel: async (p) => calls.removed.push(p.name),
        listComments: async () => ({ data: [] }),
        createComment: async (c) => calls.comments.push(c.body),
        updateComment: async (c) => calls.comments.push(c.body),
      },
    },
  };
  const context = {
    repo: { owner: "o", repo: "r" },
    payload: {
      action,
      pull_request: { state: "open", number: 1, head: { sha: "abc" }, user: { login: "author" },
        labels: labeled ? [{ name: "spec-signoff" }] : [] },
    },
  };
  const fakeRequire = (m) => {
    assert.equal(m, "fs");
    return { readFileSync: () => JSON.stringify({ klass, danger: [{ path: "supabase/migrations/x.sql" }] }) };
  };
  await new AsyncFunction("github", "context", "require", gateScript())(github, context, fakeRequire);
  const gate = calls.statuses.filter((s) => s.context === "triage/spec-gate").pop();
  return { state: gate?.state, ...calls };
}

test("a label added by someone who is not a signer does not release the gate", async () => {
  const r = await runGate({ labeledBy: ["author"] });
  assert.equal(r.state, "pending");
});

test("a signer's label releases the gate", async () => {
  const r = await runGate({ labeledBy: ["nadernik"] });
  assert.equal(r.state, "success");
});

test("the latest labeling counts: re-added by a non-signer after a signer is not a sign-off", async () => {
  const r = await runGate({ labeledBy: ["nadernik", "author"] });
  assert.equal(r.state, "pending");
});

test("a push after the sign-off removes the label and holds the gate", async () => {
  const r = await runGate({ action: "synchronize", labeledBy: ["nadernik"] });
  assert.deepEqual(r.removed, ["spec-signoff"]);
  assert.equal(r.state, "pending");
});

test("a change outside the danger layers passes without a sign-off", async () => {
  const r = await runGate({ klass: "B", labeled: false });
  assert.equal(r.state, "success");
});
