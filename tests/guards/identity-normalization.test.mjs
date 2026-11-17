// Guard: an identity key is one rule, and the database, the write paths and the KG checks all use it.
//
// WHY (2026-11-17). A KG reviewer: "if you have something in the KG already, you don't want to
// duplicate it ... link, don't copy; make a decision and stick to it." So each identity key (ORCID,
// DOI, PMID, FON, award number, organization name, URL) has one rule, stated with the vectors that
// pin it down in kg/identity_keys.json, and three implementations:
//   SQL         public.kg_<key>_key, which the uq_* unique indexes are built on
//               (supabase/migrations/*_prevent_duplicates.sql);
//   TypeScript  supabase/functions/_shared/identity-keys.ts, which the write paths look up by
//               before they insert (_shared/kg-write.ts);
//   Python      kg/identity_keys.py, which kg/quality.py duplicates() and the exporter fold with.
// If the TypeScript fold drifts from the SQL one, a write path misses the record the index then
// refuses (the write fails) or, worse, folds two different records together and reuses the wrong
// one. If the Python fold drifts, the export gate reports duplicates the database cannot see.
//
// This test runs every vector through the TypeScript, runs the vectors the migration's self-test
// block (keys-02) hands to Postgres through the TypeScript as well, and runs every vector through
// kg/identity_keys.py when a Python interpreter is on PATH (CI's ubuntu runner has one; set PYTHON
// to choose one). tests/guards/kg-identity-keys holds the JSON, the schema and the migration's
// vector block together, and kg/ci_check.py checks the Python in the KG gate.
//
// IDENTITY_KEYS_JSON reads the vectors from another file, to check a module before the JSON is in
// the tree. CI never sets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath, not url.pathname: this repo lives under "MIT Dropbox", and pathname keeps the
// spaces percent-encoded.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SPEC = process.env.IDENTITY_KEYS_JSON || join(ROOT, "kg", "identity_keys.json");
const MODULE = join(ROOT, "supabase", "functions", "_shared", "identity-keys.ts");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function spec() {
  assert.ok(existsSync(SPEC), `${SPEC} is missing: it states each identity key's rule and the vectors that pin it down`);
  return JSON.parse(readFileSync(SPEC, "utf8"));
}

async function ts() {
  assert.ok(existsSync(MODULE),
    "supabase/functions/_shared/identity-keys.ts is missing: the write paths have no copy of the identity keys to look up by");
  return import(pathToFileURL(MODULE).href);
}

const show = (v) => JSON.stringify(v);
const callTs = (I, kind, fn, input) => (kind === "preprint" ? I[fn](...input) : I[fn](input));

test("every vector in kg/identity_keys.json gives its `want` through _shared/identity-keys.ts", async () => {
  const I = await ts();
  const bad = [];
  let n = 0;
  for (const [kind, k] of Object.entries(spec().keys)) {
    assert.equal(typeof I[k.ts], "function", `${kind}: identity-keys.ts exports no ${k.ts}()`);
    for (const [input, want] of k.vectors) {
      n++;
      const got = callTs(I, kind, k.ts, input);
      if (got !== want) bad.push(`${kind}: ${k.ts}(${show(input)}) = ${show(got)}, want ${show(want)}`);
    }
  }
  assert.ok(n >= 60, `only ${n} vectors read from ${SPEC}`);
  assert.deepEqual(bad, [],
    "the TypeScript identity keys disagree with kg/identity_keys.json: a write path would look a record up by a different key than the database's index refuses it by");
});

test("the TypeScript preprint venues and DOI prefixes are the JSON's", async () => {
  const I = await ts();
  const p = spec().keys.preprint;
  assert.deepEqual([...I.PREPRINT_VENUES].sort(), [...p.venues].sort(), "PREPRINT_VENUES in identity-keys.ts vs kg/identity_keys.json");
  assert.deepEqual([...I.PREPRINT_DOI_PREFIXES].sort(), [...p.doi_prefixes].sort(), "PREPRINT_DOI_PREFIXES in identity-keys.ts vs kg/identity_keys.json");
});

test("identity-keys.ts imports nothing and uses no Deno global, so Node and Deno load the same file", () => {
  const src = readFileSync(MODULE, "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m, "identity-keys.ts imports something");
  assert.doesNotMatch(src, /^\s*export\s[^;]*?\bfrom\s*["']/m, "identity-keys.ts re-exports from another module");
  assert.doesNotMatch(src, /\bDeno\.|\brequire\(/, "identity-keys.ts uses a runtime global");
});

// ── The SQL leg ────────────────────────────────────────────────────────────────────────────────

/** The migration that creates the kg_*_key functions and the indexes on them. */
function preventDuplicates() {
  const found = readdirSync(MIGRATIONS).filter((f) => /_prevent_duplicates\.sql$/.test(f));
  assert.equal(found.length, 1, `expected one *_prevent_duplicates.sql migration, found ${found.length}`);
  return { name: found[0], text: readFileSync(join(MIGRATIONS, found[0]), "utf8").replace(/\r\n/g, "\n") };
}

/** One SQL literal at src[i] (NULL, '...' or E'...'), read as PostgreSQL reads it. */
function sqlLiteral(src, i) {
  if (/^NULL\b/i.test(src.slice(i))) return { value: null, end: i + 4 };
  const e = src[i] === "E" || src[i] === "e";
  let j = i + (e ? 2 : 1);
  assert.equal(src[j - 1], "'", `not a SQL literal: ${src.slice(i, i + 40)}`);
  let out = "";
  for (;;) {
    assert.ok(j < src.length, "unterminated SQL literal");
    const c = src[j];
    if (c === "'") {
      if (src[j + 1] === "'") { out += "'"; j += 2; continue; }
      return { value: out, end: j + 1 };
    }
    if (e && c === "\\") {
      const n = src[j + 1];
      const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      let m;
      if (n in simple) { out += simple[n]; j += 2; continue; }
      if ((m = /^u([0-9a-fA-F]{4})/.exec(src.slice(j + 1)))) { out += String.fromCodePoint(parseInt(m[1], 16)); j += 6; continue; }
      if ((m = /^U([0-9a-fA-F]{8})/.exec(src.slice(j + 1)))) { out += String.fromCodePoint(parseInt(m[1], 16)); j += 10; continue; }
      if ((m = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(j + 1)))) { out += String.fromCharCode(parseInt(m[1], 16)); j += 1 + m[0].length; continue; }
      if ((m = /^([0-7]{1,3})/.exec(src.slice(j + 1)))) { out += String.fromCharCode(parseInt(m[1], 8)); j += 1 + m[0].length; continue; }
      out += n; j += 2; continue;
    }
    out += c; j += 1;
  }
}

/** The rows of the migration's self-test block: (kind, input, second input, want). */
function selfTestRows(text) {
  const block = text.match(/-- identity-vectors:begin[^\n]*\n([\s\S]*?)\n[ \t]*-- identity-vectors:end/);
  assert.ok(block, "the migration has no -- identity-vectors:begin ... -- identity-vectors:end block (keys-02)");
  return block[1].split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).map((line) => {
    const row = [];
    let i = line.indexOf("(") + 1;
    assert.ok(i > 0, `self-test line is not a row: ${line}`);
    for (;;) {
      while (/\s/.test(line[i])) i++;
      const lit = sqlLiteral(line, i);
      row.push(lit.value);
      i = lit.end;
      while (/\s/.test(line[i])) i++;
      if (line[i] === ",") { i++; continue; }
      assert.equal(line[i], ")", `self-test row not closed: ${line}`);
      break;
    }
    assert.equal(row.length, 4, `self-test row is not (kind, input, second input, want): ${line}`);
    return row;
  });
}

test("the vectors the migration tests Postgres on give the same keys through the TypeScript", async () => {
  // When the migration is applied, keys-02 refuses to run unless Postgres returns `want` for each of
  // these rows; so a row the TypeScript disagrees with is a key the write paths fold differently from
  // the database.
  const I = await ts();
  const keys = spec().keys;
  const { name, text } = preventDuplicates();
  const rows = selfTestRows(text);
  assert.ok(rows.length >= 60, `${name}: only ${rows.length} self-test rows`);
  const bad = [];
  for (const [kind, a, b, want] of rows) {
    assert.ok(keys[kind]?.ts, `${name}: self-test kind ${kind} is not a key in kg/identity_keys.json`);
    const got = kind === "preprint" ? String(I[keys[kind].ts](a, b)) : I[keys[kind].ts](a);
    if (got !== want) bad.push(`${kind}: ${keys[kind].ts}(${show(a)}${kind === "preprint" ? `, ${show(b)}` : ""}) = ${show(got)}, Postgres must give ${show(want)}`);
  }
  assert.deepEqual(bad, [], `${name}'s self-test and supabase/functions/_shared/identity-keys.ts disagree`);
});

test("kg_is_preprint's venues and DOI prefixes are the TypeScript's", async () => {
  const I = await ts();
  const { name, text } = preventDuplicates();
  const code = text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const at = code.search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.kg_is_preprint\s*\(/i);
  assert.ok(at >= 0, `${name} does not define public.kg_is_preprint`);
  const body = code.slice(at, at + 2500);
  const venues = body.match(/'\(([a-z ]+(?:\|[a-z ]+)+)\)'/);
  const prefixes = body.match(/\^10\\{1,2}\.\(([0-9]+(?:\|[0-9]+)+)\)\//);
  assert.ok(venues && prefixes, `${name}: could not read kg_is_preprint's venue and DOI-prefix alternations`);
  assert.deepEqual(venues[1].split("|").sort(), [...I.PREPRINT_VENUES].sort(), "kg_is_preprint venues vs identity-keys.ts");
  assert.deepEqual(prefixes[1].split("|").map((x) => `10.${x}/`).sort(), [...I.PREPRINT_DOI_PREFIXES].sort(), "kg_is_preprint DOI prefixes vs identity-keys.ts");
});

// ── The Python leg ─────────────────────────────────────────────────────────────────────────────

test("kg/quality.py folds with kg/identity_keys.py, and kg/identity_keys.py gives every vector's `want`", (t) => {
  const quality = readFileSync(join(ROOT, "kg", "quality.py"), "utf8");
  assert.match(quality, /^from identity_keys import /m, "kg/quality.py does not take its identity keys from kg/identity_keys.py");
  assert.doesNotMatch(quality, /^def (fold_identifier|orcid_key|doi_key|pmid_key|fon_key|award_key|name_key|url_key)\(/m,
    "kg/quality.py defines its own fold: a second copy of a rule kg/identity_keys.py already states");

  const python = [process.env.PYTHON, "python3", "python"].filter(Boolean)
    .find((exe) => spawnSync(exe, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"]).status === 0);
  if (!python) {
    t.skip("no Python 3 on PATH (set PYTHON); kg/ci_check.py checks kg/identity_keys.py in the KG gate");
    return;
  }
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import identity_keys as I",
    "spec = json.load(open(sys.argv[2], encoding='utf-8'))",
    "bad = []",
    "for kind, k in spec['keys'].items():",
    "    f = getattr(I, k['py'], None)",
    "    if f is None:",
    "        bad.append('%s: kg/identity_keys.py has no %s()' % (kind, k['py'])); continue",
    "    for inp, want in k['vectors']:",
    "        got = f(*inp) if kind == 'preprint' else f(inp)",
    "        if got != want:",
    "            bad.append('%s: %s(%r) = %r, want %r' % (kind, k['py'], inp, got, want))",
    "print(json.dumps(bad))",
  ].join("\n");
  // -I: isolated mode, so nothing on PYTHONPATH or in the working directory is imported instead.
  const r = spawnSync(python, ["-I", "-c", script, join(ROOT, "kg"), SPEC], { encoding: "utf8" });
  assert.equal(r.status, 0, `${python} could not run kg/identity_keys.py: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), [],
    "kg/identity_keys.py disagrees with kg/identity_keys.json: kg/quality.py would fold identifiers differently from the database and the write paths");
});
