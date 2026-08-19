// Guard: rendered data comes from the knowledge graph, never from a checked-in YAML/JSON copy.
//
// WHY (2026-08-19). /projects rendered its Species column from public/bbqs_marr.yaml while the
// project detail page rendered projects.study_species from the KG. The two sources disagreed on
// 25 of 30 projects; 6 rows showed no species in the table while showing one a click away. Four of
// those six were a pure key-shape mismatch — the YAML key kept NIH's application-type prefix
// (1U01DA063565) while the lookup normalized only the row — and two grants had no YAML entry at all.
//
// Worse than the blanks: both sources held confident Latin species names that were wrong. For
// R34DA059507 the KG said Taeniopygia guttata where the grant abstract names Molothrus ater; for
// R34DA061925 the YAML said Sapajus apella and the KG Cebus capucinus where the abstract names
// Cebus imitator. A static file cannot be corrected by the people who own the data, carries no
// provenance, and outranked the KG on the public site for months.
//
// Constitution v1.8.0 Principle XI now prohibits static duplicates of KG data as a source for
// rendered fields. This test is the ratchet: the allowlist below may only SHRINK. Deleting an entry
// is progress; adding one is a violation that needs a constitution argument, not a test edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not url.pathname: this repo lives under "MIT Dropbox" and pathname leaves the
// spaces percent-encoded, which makes every readdir ENOENT.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(ROOT, "src");

/** Files still permitted to read bbqs_marr.yaml. The Marr-layer diagram surfaces have no KG
 *  columns yet (feature 012 P2 moves them); the hook itself is the loader. MAY ONLY SHRINK. */
const YAML_ALLOWLIST = new Set([
  "src/hooks/useMarrYaml.ts",
  "src/pages/Species.tsx",
  "src/components/diagrams/MarrChordDiagram.tsx",
  "src/components/diagrams/MarrSankeyDiagram.tsx",
  "src/components/diagrams/ProjectIndexGrid.tsx",
  "src/components/diagrams/SpeciesHeatmap.tsx",
  "src/components/diagrams/SynergyNetwork.tsx",
  "src/components/entity-summary/summaries/SpeciesSummary.tsx",
]);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if ([".ts", ".tsx"].includes(extname(name))) out.push(full);
  }
  return out;
};

const rel = (f) => relative(ROOT, f).split("\\").join("/");

/** Strip comments before matching. A guard that greps raw text cannot tell a live import from a
 *  sentence explaining why the import was removed — the first version of this file failed on its
 *  own explanatory comment. Naive but sufficient here: no string literal in this repo contains
 *  "//" followed by a YAML reference. */
const codeOnly = (src) => {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join(" ");
};

test("no new file reads species/Marr data from the checked-in YAML", () => {
  const offenders = walk(SRC)
    .filter((f) => /useMarrYaml|bbqs_marr\.yaml/.test(codeOnly(readFileSync(f, "utf8"))))
    .map(rel)
    .filter((r) => !YAML_ALLOWLIST.has(r));

  assert.deepEqual(
    offenders,
    [],
    "These read the checked-in YAML instead of the KG (Constitution XI):\n  " +
      offenders.join("\n  ") +
      "\nRead the KG, or argue for an allowlist entry in the constitution first.",
  );
});

test("the /projects Species column reads the KG, not the YAML", () => {
  const src = codeOnly(readFileSync(join(SRC, "pages", "Projects.tsx"), "utf8"));
  assert.ok(
    !/useMarrYaml|bbqs_marr/.test(src),
    "Projects.tsx must not read bbqs_marr.yaml — species is projects.study_species from the KG.",
  );
  assert.match(
    src,
    /from\("projects"\)[\s\S]{0,160}study_species/,
    "Projects.tsx should select study_species from the KG projects table.",
  );
});

test("grant numbers are compared on BOTH sides through one normalizer", () => {
  const src = codeOnly(readFileSync(join(SRC, "pages", "Projects.tsx"), "utf8"));
  // The original bug: normalizing the lookup key but not the map key. A one-sided normalize is
  // invisible until a grant rolls from application type 1 to 5, then silently returns nothing.
  // The definition reads "coreGrantNumber = (", so only CALL sites match — two is the point.
  const uses = src.match(/coreGrantNumber\(/g) || [];
  assert.ok(
    uses.length >= 2,
    "coreGrantNumber must normalize the map key AND the lookup key (found " +
      uses.length +
      " call site(s); expected at least 2 — one per side of the comparison).",
  );
});

test("the allowlist itself only shrinks: every entry still exists", () => {
  for (const r of YAML_ALLOWLIST) {
    let ok = true;
    try {
      statSync(join(ROOT, r));
    } catch {
      ok = false;
    }
    assert.ok(ok, `Allowlisted file ${r} is gone — delete its entry (the ratchet only tightens).`);
  }
});
