// Guard: the typecheck command must actually check the app.
//
// WHY (2026-08-20). `npx tsc --noEmit` was run repeatedly as a gate all week and passed every time.
// It was compiling NOTHING: the root tsconfig.json has "files": [] and only project references, so
// without -b or -p it has no inputs and exits 0. A green no-op is worse than a red check, because it
// buys confidence instead of information.
//
// It hid five real errors, three of them shipped: two stale `parsed.data.full_name` references left
// behind when the signup form split name into first/last, and a component using <Link> without
// importing it. The error count before that week's work was 1; by the time anyone looked properly it
// was 6.
//
// So: package.json must expose a typecheck script, and it must name a project. This test only reads
// the script definition — it does not run tsc, which belongs in CI where it can take the time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("a typecheck script exists", () => {
  assert.ok(
    pkg.scripts?.typecheck,
    'package.json needs a "typecheck" script — otherwise the obvious thing to run is the no-op form.',
  );
});

test("the typecheck script names a project, so it has inputs", () => {
  const cmd = pkg.scripts.typecheck;
  const targetsProject = /\s-p\s|\s--project\s|\s-b(\s|$)|\s--build(\s|$)/.test(cmd);
  assert.ok(
    targetsProject,
    `"${cmd}" does not name a tsconfig project. Bare "tsc --noEmit" compiles nothing here: ` +
      'the root tsconfig has "files": [] and only references, so it exits 0 having checked zero files. ' +
      "Use -p tsconfig.app.json, or -b to follow the references.",
  );
});

test("the root tsconfig is still the referencing kind this guard assumes", () => {
  // If someone later gives the root tsconfig real inputs, bare `tsc --noEmit` stops being a no-op
  // and this guard's reasoning no longer applies. Fail loudly rather than keep asserting a stale
  // premise — a guard that outlives its reason is the thing it was written to prevent.
  const root = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
  const empty = Array.isArray(root.files) && root.files.length === 0;
  const hasRefs = Array.isArray(root.references) && root.references.length > 0;
  assert.ok(
    empty && hasRefs,
    "The root tsconfig no longer looks like a pure solution file (files: [] plus references). " +
      "Re-check whether bare `tsc --noEmit` is still a no-op, and update this guard's reasoning.",
  );
});
