// Guard: one identity rule per key, written once, and every layer that asks "is this already in
// the KG?" declares or implements that same rule.
//
// WHY (2026-11-17). A KG reviewer: "if you have something in the KG already, you don't want to
// duplicate it; cleaning is a difficult and tedious task as the KG grows; link, don't copy; make a
// decision and stick to it." The 11-04 export had 14 duplicate groups, cleaned by hand in
// 20261116150000. Nothing stopped the next one: the schema declared no key but `id`, the database
// had unique constraints on three columns, and each write path matched on its own spelling.
//
// Now each key (ORCID, DOI, PMID, FON, award number, organization name, URL) has ONE rule, stated in
// kg/identity_keys.json together with the vectors that pin it down, and four layers carry it:
//   database  public.kg_<key>_key and the uq_* indexes on them (supabase/migrations/*_prevent_duplicates.sql)
//   writers   supabase/functions/_shared/identity-keys.ts (tests/guards/identity-normalization)
//   schema    kg/bbqs.linkml.yaml unique_keys (gen-owl turns each into an owl:hasKey axiom)
//   export    kg/shapes/validation.shapes.ttl, and kg/quality.py duplicates() through kg/identity_keys.py
// Copies of one rule drift, and a drifted key lets a duplicate through one layer that another
// refuses. This test holds the declarations together. kg/ci_check.py runs the Python rule on the
// vectors; the migration's self-test (block keys-02) runs the SQL rule on them when it is applied.
//
// KG_MIGRATIONS_DIR reads the migrations from another folder (a scratch copy of
// supabase/migrations), to check a migration before it is in the tree. CI never sets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const MIGRATIONS = process.env.KG_MIGRATIONS_DIR || join(ROOT, "supabase", "migrations");

// The keys the design fixes (kg/README.md, "Modelling rule: link, don't copy"). More may be added.
const REQUIRED = ["orcid", "doi", "pmid", "fon", "award", "nih_award_core", "name", "url", "title", "preprint"];

function spec() {
  const path = join(ROOT, "kg", "identity_keys.json");
  assert.ok(existsSync(path), "kg/identity_keys.json is missing: it is where each identity key's rule and vectors are stated once");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every LinkML key the JSON declares, new keys and existing ones, as "Class.key[slot,slot]". */
function declaredKeys(s) {
  return [...Object.values(s.keys), ...(s.existing || [])]
    .flatMap((k) => k.linkml || [])
    .map((l) => `${l.class}.${l.key}[${l.slots.join(",")}]`)
    .sort();
}

/** kg/bbqs.linkml.yaml classes: name -> { parents, slots, keys }. Regex-parsed: the guards are zero-dependency. */
function schemaClasses() {
  const src = read("kg/bbqs.linkml.yaml");
  const section = src.match(/\nclasses:\n([\s\S]*?)(?=\n\w)/);
  assert.ok(section, "no classes: section in kg/bbqs.linkml.yaml");
  const body = section[1];
  const heads = [...body.matchAll(/^ {2}([A-Z][A-Za-z]+):(.*)$/gm)];
  const classes = new Map();
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    const text = h[2] + "\n" + body.slice(h.index + h[0].length, end);
    const list = (s) => s.split(",").map((x) => x.replace(/#.*/, "").trim()).filter(Boolean);
    // `slots:` preceded by a space, `{` or `,`: never unique_key_slots.
    const inline = text.match(/(?:^|[\s{,])slots:\s*\[([^\]]*)\]/);
    const block = text.match(/\n {4}slots:[ \t]*\n((?: {6}(?:- |#).*\n?)+)/);
    const slots = inline ? list(inline[1]) : block ? [...block[1].matchAll(/^ {6}- ([a-z_]+)/gm)].map((m) => m[1]) : [];
    const isA = text.match(/(?:^|[\s{,])is_a:\s*([A-Za-z]+)/);
    const mixins = text.match(/(?:^|[\s{,])mixins:\s*\[([^\]]*)\]/);
    const keys = [];
    const uk = text.match(/\n {4}unique_keys:\n((?: {6,}.*\n?)+)/);
    if (uk) {
      for (const k of uk[1].matchAll(/^ {6}([a-z_]+):\n((?: {8,}.*\n?)*)/gm)) {
        const slotsOf = k[2].match(/^ {8}unique_key_slots:\s*\[([^\]]*)\]/m);
        assert.ok(slotsOf, `${h[1]}.unique_keys.${k[1]}: no one-line unique_key_slots: [...] (this guard reads that form)`);
        keys.push({ key: k[1], slots: list(slotsOf[1]), body: k[2] });
      }
    }
    classes.set(h[1], { parents: [...(isA ? [isA[1]] : []), ...(mixins ? list(mixins[1]) : [])], slots, keys, text });
  });
  // Every unique_key_slots line in the file was read into some class's keys.
  const total = (src.match(/^\s+unique_key_slots:/gm) || []).length;
  const parsed = [...classes.values()].reduce((n, c) => n + c.keys.length, 0);
  assert.equal(parsed, total, "kg/bbqs.linkml.yaml has unique_keys this guard could not read; keep the layout of the existing ones");
  return classes;
}

function inherited(classes, name, seen = new Set()) {
  if (seen.has(name) || !classes.has(name)) return new Set();
  seen.add(name);
  const c = classes.get(name);
  return new Set([...c.slots, ...c.parents.flatMap((p) => [...inherited(classes, p, seen)])]);
}

function migrations() {
  assert.ok(existsSync(MIGRATIONS), `no migrations folder at ${MIGRATIONS}`);
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => ({ name: f, text: readFileSync(join(MIGRATIONS, f), "utf8").replace(/\r\n/g, "\n") }));
}

// The SQL without its whole-line comments: a header's UNDO section may name an index or a function.
const code = (text) => text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

function preventDuplicates() {
  const found = migrations().filter((m) => /_prevent_duplicates\.sql$/.test(m.name));
  assert.equal(found.length, 1, `expected one *_prevent_duplicates.sql migration (it creates the key functions and indexes), found ${found.length}`);
  return found[0];
}

const fnName = (sql) => sql.replace(/^public\./, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One SQL literal at src[i]: NULL, '...' or E'...', read the way PostgreSQL reads it
 *  (standard_conforming_strings on). In E'' only \b \f \n \r \t, octal, \x, \u and \U are escapes;
 *  any other backslashed character is itself, so E'\v' is "v", not a vertical tab. */
function sqlLiteral(src, i) {
  const rest = src.slice(i);
  if (/^NULL\b/i.test(rest)) return { value: null, end: i + 4 };
  const escaped = /^[Ee]'/.test(rest);
  let j = i + (escaped ? 2 : 1);
  assert.ok(src[j - 1] === "'", `not a SQL literal at: ${rest.slice(0, 40)}`);
  let out = "";
  for (;;) {
    assert.ok(j < src.length, "unterminated SQL literal");
    const c = src[j];
    if (c === "'") {
      if (src[j + 1] === "'") { out += "'"; j += 2; continue; }
      return { value: out, end: j + 1 };
    }
    if (escaped && c === "\\") {
      const n = src[j + 1];
      const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (n in simple) { out += simple[n]; j += 2; continue; }
      let m;
      if ((m = /^u([0-9a-fA-F]{4})/.exec(src.slice(j + 1)))) { out += String.fromCodePoint(parseInt(m[1], 16)); j += 6; continue; }
      if ((m = /^U([0-9a-fA-F]{8})/.exec(src.slice(j + 1)))) { out += String.fromCodePoint(parseInt(m[1], 16)); j += 10; continue; }
      if ((m = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(j + 1)))) { out += String.fromCharCode(parseInt(m[1], 16)); j += 1 + m[0].length; continue; }
      if ((m = /^([0-7]{1,3})/.exec(src.slice(j + 1)))) { out += String.fromCharCode(parseInt(m[1], 8)); j += 1 + m[0].length; continue; }
      out += n; j += 2; continue;
    }
    out += c; j += 1;
  }
}

function selfTestRows(text) {
  const block = text.match(/-- identity-vectors:begin[^\n]*\n([\s\S]*?)\n[ \t]*-- identity-vectors:end/);
  assert.ok(block, "the migration has no -- identity-vectors:begin ... -- identity-vectors:end block (keys-02)");
  return block[1].split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).map((line) => {
    const row = [];
    let i = line.indexOf("(");
    assert.ok(i >= 0, `self-test line is not a row: ${line}`);
    i += 1;
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

test("kg/identity_keys.json states each identity key: its rule, its implementations, and vectors", () => {
  const s = spec();
  const missing = REQUIRED.filter((k) => !(k in s.keys));
  assert.deepEqual(missing, [], `kg/identity_keys.json lacks the keys ${missing.join(", ")}`);
  const py = read("kg/identity_keys.py");
  for (const [name, k] of Object.entries(s.keys)) {
    for (const field of ["rule", "ts", "py"]) assert.ok(k[field], `${name}: no "${field}"`);
    if ((k.db || []).length) assert.ok(k.sql, `${name}: indexed in the database (${k.db.map((d) => d.index).join(", ")}) but no "sql" function`);
    assert.ok(Array.isArray(k.vectors) && k.vectors.length >= 3, `${name}: fewer than 3 vectors`);
    for (const v of k.vectors) {
      assert.ok(Array.isArray(v) && v.length === 2, `${name}: a vector is not [input, want]: ${JSON.stringify(v)}`);
      if (name === "preprint") assert.ok(Array.isArray(v[0]) && v[0].length === 2, `preprint: an input is not [journal, doi]`);
    }
    const nullIn = name === "preprint" ? (v) => v[0][0] === null && v[0][1] === null : (v) => v[0] === null;
    assert.ok(k.vectors.some(nullIn), `${name}: no vector for a missing value (null)`);
    assert.match(py, new RegExp(`^def ${k.py}\\(`, "m"), `${name}: kg/identity_keys.py defines no ${k.py}()`);
  }
});

test("kg/bbqs.linkml.yaml declares exactly the unique keys kg/identity_keys.json lists", () => {
  const classes = schemaClasses();
  const schema = [...classes].flatMap(([cls, c]) => c.keys.map((k) => `${cls}.${k.key}[${k.slots.join(",")}]`)).sort();
  assert.deepEqual(schema, declaredKeys(spec()),
    "the LinkML unique_keys and kg/identity_keys.json disagree: a key declared in one is enforced or checked nowhere else");
  for (const [cls, c] of classes) {
    for (const k of c.keys) {
      assert.match(k.body, /consider_nulls_inequal:\s*true/, `${cls}.${k.key}: say consider_nulls_inequal: true (a missing value never collides)`);
      assert.match(k.body, /description:/, `${cls}.${k.key}: no description naming where the key is refused and checked`);
    }
  }
});

test("each key slot is a slot of its class or of a class it inherits from", () => {
  // gen-owl writes owl:hasKey for a slot the class does not have, without a word.
  const classes = schemaClasses();
  const declared = new Set([...read("kg/bbqs.linkml.yaml").match(/\nslots:\n([\s\S]*?)(?=\n\w)/)[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]));
  const keys = [...classes.values()].reduce((n, c) => n + c.keys.length, 0);
  assert.ok(keys > 0 && keys === declaredKeys(spec()).length, `read ${keys} unique keys from the schema`);
  const bad = [];
  for (const [cls, c] of classes) {
    const own = inherited(classes, cls);
    for (const k of c.keys) for (const slot of k.slots) {
      if (!declared.has(slot)) bad.push(`${cls}.${k.key}: ${slot} is not a slot of the schema`);
      else if (!own.has(slot)) bad.push(`${cls}.${k.key}: ${slot} is not a slot of ${cls}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("each shape kg/identity_keys.json names is a shape in kg/shapes/validation.shapes.ttl", () => {
  const ttl = read("kg/shapes/validation.shapes.ttl");
  const s = spec();
  const shapes = [...Object.values(s.keys), ...(s.existing || [])].map((k) => k.shape).filter(Boolean);
  assert.ok(shapes.length >= 6, `only ${shapes.length} shapes named`);
  const missing = shapes.filter((name) => !new RegExp(`^bbqs:${name}\\n\\s+a sh:NodeShape`, "m").test(ttl));
  assert.deepEqual(missing, [], "named in kg/identity_keys.json but not a shape");
});

test("kg/quality.py checks each key it is listed for, with the same Python rule", () => {
  const src = read("kg/quality.py");
  const ids = src.match(/^IDENTIFIERS = \(([^)]*)\)/m);
  assert.ok(ids, "no IDENTIFIERS = (...) in kg/quality.py");
  const identifiers = [...ids[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const fold = src.match(/^FOLD = \{([\s\S]*?)\n\}/m);
  assert.ok(fold, "no FOLD = {...} in kg/quality.py: it maps each identifier to its kg/identity_keys.py rule");
  const folds = Object.fromEntries([...fold[1].matchAll(/"([a-z_]+)":\s*([a-z_]+)/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(folds).sort(), [...identifiers].sort(), "FOLD and IDENTIFIERS list different identifiers");
  for (const [name, k] of Object.entries(spec().keys)) {
    if (!k.quality) continue;
    assert.ok(identifiers.includes(k.quality), `${name}: kg/quality.py IDENTIFIERS lacks "${k.quality}"`);
    assert.equal(folds[k.quality], k.py, `${name}: kg/quality.py folds "${k.quality}" with ${folds[k.quality]}, not ${k.py}`);
  }
});

test("the migration creates each unique index on its key function", () => {
  const { name } = preventDuplicates();
  const text = code(preventDuplicates().text);
  const missing = [];
  for (const [key, k] of Object.entries(spec().keys)) {
    for (const d of k.db || []) {
      const expr = new RegExp(`public\\.${escapeRe(fnName(k.sql))}\\(\\s*${escapeRe(d.column)}\\s*\\)`);
      const table = new RegExp(`\\b${escapeRe(d.table)}\\b`);
      // the index named near (within 600 characters of) its table and its key expression
      const near = [...text.matchAll(new RegExp(`\\b${escapeRe(d.index)}\\b`, "g"))]
        .some((m) => { const w = text.slice(Math.max(0, m.index - 600), m.index + 600); return expr.test(w) && table.test(w); });
      if (!near) missing.push(`${key}: ${d.index} on ${d.table} (public.${fnName(k.sql)}(${d.column}))`);
    }
  }
  assert.deepEqual(missing, [], `${name} does not create these indexes on their key functions`);
});

test("the migration's self-test vectors are kg/identity_keys.json's", () => {
  const { name, text } = preventDuplicates();
  const want = [];
  for (const [kind, k] of Object.entries(spec().keys)) {
    if (!k.sql) continue;
    for (const [input, out] of k.vectors) {
      const [a, b] = kind === "preprint" ? input : [input, null];
      want.push([kind, a, b, typeof out === "boolean" ? String(out) : out]);
    }
  }
  assert.ok(want.length >= 60, `only ${want.length} vectors for the SQL rules`);
  assert.deepEqual(selfTestRows(text), want,
    `${name}'s identity-vectors block is not kg/identity_keys.json: regenerate it from the JSON, so Postgres is tested on the same cases as Python and TypeScript`);
});

test("each kg_* key function is defined in exactly one migration", () => {
  const all = migrations();
  const where = {};
  for (const k of Object.values(spec().keys)) {
    if (!k.sql) continue;
    const def = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${escapeRe(fnName(k.sql))}\\s*\\(`, "i");
    where[k.sql] = all.filter((m) => def.test(code(m.text))).map((m) => m.name);
  }
  const bad = Object.entries(where).filter(([, files]) => files.length !== 1 || !/_prevent_duplicates\.sql$/.test(files[0]));
  assert.deepEqual(bad, [],
    "a key function defined in two migrations (or outside *_prevent_duplicates.sql) gets replaced under its index: " +
      "CREATE OR REPLACE changes an indexed function without a word, and the index keeps the old keys");
});

test("the preprint venues and DOI prefixes are the same in kg/identity_keys.py, the JSON and the SQL", () => {
  const p = spec().keys.preprint;
  const py = read("kg/identity_keys.py");
  const tuple = (name) => {
    const m = py.match(new RegExp(`^${name} = \\(([^)]*)\\)`, "m"));
    assert.ok(m, `no ${name} = (...) in kg/identity_keys.py`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(tuple("PREPRINT_VENUES"), [...p.venues].sort(), "PREPRINT_VENUES: kg/identity_keys.py vs the JSON");
  assert.deepEqual(tuple("PREPRINT_DOI_PREFIXES"), [...p.doi_prefixes].sort(), "PREPRINT_DOI_PREFIXES: kg/identity_keys.py vs the JSON");
  const { name } = preventDuplicates();
  const text = code(preventDuplicates().text);
  const at = text.search(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${escapeRe(fnName(p.sql))}\\s*\\(`, "i"));
  assert.ok(at >= 0, `${name} does not define ${p.sql}`);
  const body = text.slice(at, at + 2500);
  const venues = body.match(/'\(([a-z ]+(?:\|[a-z ]+)+)\)'/);
  const prefixes = body.match(/\^10\\{1,2}\.\(([0-9]+(?:\|[0-9]+)+)\)\//);
  assert.ok(venues && prefixes, `${name}: could not read the venue and DOI-prefix alternations of ${p.sql}`);
  assert.deepEqual(venues[1].split("|").sort(), [...p.venues].sort(), `${p.sql}: venues differ from the JSON`);
  assert.deepEqual(prefixes[1].split("|").map((x) => `10.${x}/`).sort(), [...p.doi_prefixes].sort(), `${p.sql}: DOI prefixes differ from the JSON`);
});
