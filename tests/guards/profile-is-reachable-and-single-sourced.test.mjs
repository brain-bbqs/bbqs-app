// Guards for two UI regressions the user photographed, both of which a build and a typecheck pass
// happily. Neither is expressible as a runtime test here: this repo has no component-test setup
// (node guards + playwright only), and the affected surfaces need a signed-in consortium member.
// A source-level assertion is what is actually available, so that is what gets written down.
//
// 1. THE DOUBLED PROJECT NAME. The projects grid opens a rich detail card on row hover, whose
//    heading is the project title in full. The title cell was ALSO wrapped in a Radix Tooltip whose
//    entire content was the same title, so hovering rendered two overlapping popups and the name
//    appeared twice. Verified fixed live: one hover card, zero Radix poppers.
//
// 2. THE TAB THAT WAS A DOORWAY. The project card's "Manage" tab contained one button whose job was
//    to navigate to /projects/:grantNumber/profile. A tab holding a link to its own content is not
//    a tab; the questionnaire now renders inside it, from the same components as the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** The body of a top-level `const Name = ...` declaration, up to the next top-level `const`. */
function topLevelConst(src, name) {
  const start = src.indexOf(`const ${name}`);
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/\nconst [A-Za-z_]/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("the extractor finds a component body and stops at the next one", () => {
  const src = "const A = () => {\n  return 1;\n};\n\nconst B = () => 2;\n";
  const a = topLevelConst(src, "A");
  assert.match(a, /return 1/);
  assert.doesNotMatch(a, /return 2/);
});

test("the projects title cell does not open a second popup over the hover card", () => {
  const src = read("src/pages/Projects.tsx");
  const cell = topLevelConst(src, "TitleCell");
  assert.ok(cell, "TitleCell not found — rename? update this guard.");

  // The rich hover card must still exist, or this guard would pass by deleting the wrong one.
  assert.match(src, /hoveredRow &&/, "the row hover detail card is gone; it is the thing that shows the full title");

  assert.doesNotMatch(
    cell,
    /TooltipContent/,
    "TitleCell renders a Tooltip again. The hover detail card already shows the full title as " +
      "its heading, so a tooltip here stacks a second popup on the first and the project name reads twice.",
  );
});

test("the project card's profile tab renders the questionnaire, not a link to it", () => {
  const src = read("src/components/entity-summary/summaries/GrantSummary.tsx");
  const tabStart = src.indexOf('id: "profile"');
  assert.notEqual(tabStart, -1, 'no tab with id "profile" — rename? update this guard.');
  const tab = src.slice(tabStart, src.indexOf('id: "details"', tabStart));

  assert.match(
    tab,
    /<ProjectQuestionnaireBody/,
    "the profile tab no longer renders ProjectQuestionnaireBody. A tab whose only content is a " +
      "button to the full page is a doorway, not a tab — that was the reported bug.",
  );
});

test("the questionnaire is written by exactly one module", () => {
  // The page and the tab share useProjectProfileEditor. If a second copy of the upsert appears, the
  // two surfaces can drift — different completeness maths, or one skipping the edit_history rows.
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if ([".ts", ".tsx"].includes(extname(e.name))) files.push(p);
    }
  };
  walk("src");

  const writers = files.filter((f) =>
    /\.upsert\(\s*row\s*,\s*\{\s*onConflict:\s*"grant_number"/.test(read(f)),
  );
  assert.deepEqual(
    writers,
    ["src/components/project-profile/useProjectProfileEditor.ts"],
    "the project questionnaire upsert exists in more than one place: " + writers.join(", "),
  );
});
