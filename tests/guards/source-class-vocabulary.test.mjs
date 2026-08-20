// Guard: every source class named anywhere in the repo exists in the ladder.
//
// WHY. current_source_class() resolves an unrecognised declaration to 'unknown' — by design, so an
// undeclared machine write fails safe. The cost of that design is that a TYPO also resolves to
// 'unknown', silently: `set_source_class('authoritative-registry')` (hyphen, not underscore) would
// not error, and the write would be recorded as having no known source while the caller believed it
// had declared tier 1. Enforcement would then refuse writes the author expected to succeed, and the
// reason would be a string nobody looks at.
//
// This is the same failure shape as the role-vocabulary drift that produced issue #283: several
// surfaces each holding their own spelling of the same concept, with no single place that agrees.
// A machine check is cheap; noticing is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not url.pathname: this repo lives under "MIT Dropbox" and pathname leaves the
// spaces percent-encoded, which makes every readdir ENOENT.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const walk = (dir, exts, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.includes(extname(name))) out.push(full);
  }
  return out;
};

/** The ladder, read from whichever migrations INSERT into source_classes. */
function ladder() {
  const codes = new Set();
  for (const f of walk(MIGRATIONS, [".sql"])) {
    const sql = readFileSync(f, "utf8");
    if (!/INSERT INTO public\.source_classes/.test(sql)) continue;
    // Rows look like: ('questionnaire', 2, 'Questionnaire', 'human', true, '...')
    for (const m of sql.matchAll(/\(\s*'([a-z_]+)'\s*,\s*\d+\s*,\s*'/g)) codes.add(m[1]);
  }
  return codes;
}

/** Every class name a caller declares, anywhere. */
function declared() {
  const found = [];
  const files = [
    ...walk(MIGRATIONS, [".sql"]),
    ...walk(join(ROOT, "src"), [".ts", ".tsx"]),
    ...walk(join(ROOT, "supabase", "functions"), [".ts"]),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const where = relative(ROOT, f).split("\\").join("/");
    for (const m of src.matchAll(/set_source_class\(\s*'([^']*)'/g)) found.push({ code: m[1], where });
    for (const m of src.matchAll(/x-bbqs-source-class['"]\s*[:,]\s*['"]([^'"]*)['"]/g))
      found.push({ code: m[1], where });
    // Positional 4th argument of record_field_provenance(table, id, column, source_class, ...)
    for (const m of src.matchAll(/record_field_provenance\(\s*'[^']*'\s*,\s*[^,]+,\s*'[^']*'\s*,\s*'([^']*)'/g))
      found.push({ code: m[1], where });
  }
  return found;
}

test("the ladder is defined and non-trivial", () => {
  const codes = ladder();
  assert.ok(codes.size >= 6, `expected the full ladder, found: ${[...codes].join(", ")}`);
  for (const required of ["authoritative_registry", "questionnaire", "curator_fill", "unknown"]) {
    assert.ok(codes.has(required), `ladder is missing ${required}`);
  }
});

test("every declared source class exists in the ladder", () => {
  const codes = ladder();
  // The setter is legitimately called with '' to clear a declaration.
  const bad = declared().filter((d) => d.code !== "" && !codes.has(d.code));
  assert.deepEqual(
    bad,
    [],
    "Unknown source class(es) — these resolve to 'unknown' SILENTLY: " +
      bad.map((b) => `${b.code} in ${b.where}`).join("; "),
  );
});

/** The EFFECTIVE ladder: replay every migration in filename order, so a later grade change wins.
 *
 *  An earlier version of this file matched grade literals in whichever migration happened to
 *  contain them, and kept passing after `algorithmic` shifted llm_extract from G5 to G6 — it was
 *  still finding the stale `('llm_extract', 5, ...)` in the older file. A guard that reads history
 *  instead of current state is worse than no guard, because it reports green. */
function effectiveLadder() {
  const grade = new Map();
  const verified = new Map();
  for (const f of walk(MIGRATIONS, [".sql"]).sort()) {
    const sql = readFileSync(f, "utf8");
    for (const m of sql.matchAll(
      /\(\s*'([a-z_]+)'\s*,\s*(\d+)\s*,\s*'[^']*'\s*,\s*'(human|machine|external_registry)'\s*,\s*(true|false)/g,
    )) {
      grade.set(m[1], Number(m[2]));
      verified.set(m[1], m[4] === "true");
    }
    for (const m of sql.matchAll(
      /UPDATE public\.source_classes\s+SET grade\s*=\s*(\d+)[\s\S]{0,400}?WHERE code\s*=\s*'([a-z_]+)'/g,
    )) {
      grade.set(m[2], Number(m[1]));
    }
  }
  return { grade, verified };
}

test("the ladder's invariants hold in its CURRENT state, not just somewhere in history", () => {
  const { grade, verified } = effectiveLadder();

  // A named person working with a model is accountable; an unattended machine is not. If these
  // flip, the UI marker inverts and every AI-assisted field starts reading as unverified.
  assert.equal(verified.get("curated_with_ai"), true, "curated_with_ai must be verified");
  assert.equal(verified.get("curator_fill"), true, "curator_fill must be verified");
  assert.equal(verified.get("llm_extract"), false, "llm_extract must NOT be verified");
  assert.equal(verified.get("algorithmic"), false, "algorithmic must NOT be verified");

  // Computed beats generated: a rule can be read and re-run, a model's output cannot be reproduced.
  // This ordering is the reason `algorithmic` exists as a separate class at all.
  assert.ok(
    grade.get("algorithmic") < grade.get("llm_extract"),
    `algorithmic (G${grade.get("algorithmic")}) must rank above llm_extract (G${grade.get("llm_extract")})`,
  );

  // Nothing may sit below "no record at all".
  const worst = Math.max(...grade.values());
  assert.equal(
    grade.get("unknown"),
    worst,
    `unknown must be the worst grade; it is G${grade.get("unknown")} while the worst is G${worst}`,
  );

  // Human sources all outrank every machine source.
  const humanMax = Math.max(...[...verified].filter(([, v]) => v).map(([c]) => grade.get(c)));
  const machineMin = Math.min(...[...verified].filter(([, v]) => !v).map(([c]) => grade.get(c)));
  assert.ok(humanMax < machineMin, `verified sources (worst G${humanMax}) must all outrank unverified (best G${machineMin})`);
});
