// Guard: anon reads the column-restricted objects by naming public columns, and nothing opens a
// private column to anon again.
//
// WHY (2026-11-17). An audit of everything anon (the site's public key) can read found auth user ids,
// e-mail addresses, pending role requests and curators' notes in nine tables and views: Supabase's
// default grant gives anon every column, and row-level security only decides rows.
// 20261117190000_hide_private_columns_from_anon took those columns away from anon, column by column.
// That changes what a query may look like. PostgREST runs select=* as SELECT *, which needs every
// column, so a visitor's select("*") on one of these objects is now refused outright: the page shows
// nothing, or an error. A select("*") is the shortest thing to write, and the next one would break
// the site for every visitor while working for everyone who tests it signed in. This guard makes
// that a failing check instead of a bug report:
//   * src/ and e2e/ ask these objects for named columns: no select("*"), no select(), no obj(*), and
//     a plain column list (not one chosen by sign-in) names no private column;
//   * kg/bbqs_kg.py, which reads as anon, has a PUBLIC_COLUMNS list for every one of them it reads,
//     and none of those lists names a private column;
//   * the private list is real: each column is in types.ts or added by a migration;
//   * no later migration gives anon a private column, or a whole object, back; and one that adds a
//     column to one of these objects, or redefines one of the views, says whether anon may read the
//     new columns (they are hidden from anon until a GRANT SELECT (<column>) ... TO anon says otherwise).
// The list of private columns is the migration's own (its kg_private_from_anon rows), so there is one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const FIX = "20261117190000_hide_private_columns_from_anon.sql";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** object -> Set of the columns the migration takes from anon, from its kg_private_from_anon rows. */
export function privateFromAnon(sql) {
  const start = sql.indexOf("INSERT INTO kg_private_from_anon");
  assert.ok(start >= 0, `${FIX} has no INSERT INTO kg_private_from_anon`);
  const block = sql.slice(start, sql.indexOf(";", start));
  const out = new Map();
  for (const [, obj, col] of block.matchAll(/\(\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'/g)) {
    if (!out.has(obj)) out.set(obj, new Set());
    out.get(obj).add(col);
  }
  return out;
}

const PRIVATE = privateFromAnon(read(join("supabase", "migrations", FIX)));
const OBJECTS = [...PRIVATE.keys()];

/** Code with // and /* comments blanked to spaces (same length, newlines kept), so a comment cannot
 *  count and a position in it is a position in the source. "https://" is not a comment. */
export function stripJsComments(src) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\"'`])(\/\/[^\n]*)/g, (_, pre, c) => pre + blank(c));
}

// A query only a signed-in user can reach (a delete, an editor) may name a private column; it says so
// in a comment inside its chain, e.g. `// signed-in only: deleting is for the comment's author`.
const SIGNED_IN_ONLY = /signed-in only/i;

/** Every .select(...) on one of `objects`: { object, arg, signedInOnly } with arg the text between
 *  the parens, and signedInOnly whether the chain carries the signed-in-only comment. */
export function selectsOn(src, objects) {
  const code = stripJsComments(src);
  const found = [];
  const from = /\.from\(\s*["'`]([a-z_]+)["'`]/g;
  let m;
  while ((m = from.exec(code)) !== null) {
    if (!objects.includes(m[1])) continue;
    // The chain up to the next .from( (or 800 characters): its first .select( belongs to this from.
    const start = m.index + m[0].length;
    const rest = code.slice(start);
    const next = rest.search(/\.from\(/);
    const chain = rest.slice(0, next === -1 ? 800 : Math.min(next, 800));
    const s = chain.search(/\.select\(/);
    if (s === -1) continue;
    let depth = 0;
    let arg = "";
    for (const ch of chain.slice(s + ".select(".length)) {
      if (ch === "(") depth += 1;
      else if (ch === ")") { if (depth === 0) break; depth -= 1; }
      arg += ch;
    }
    const lineStart = code.lastIndexOf("\n", m.index) + 1;
    const raw = src.slice(lineStart, start + s + ".select(".length + arg.length + 1);
    found.push({ object: m[1], arg: arg.trim(), signedInOnly: SIGNED_IN_ONLY.test(raw) });
  }
  return found;
}

/** The first argument of a call's argument text: up to the first comma outside brackets and quotes. */
export function firstArg(arg) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < arg.length; i += 1) {
    const ch = arg[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) return arg.slice(0, i).trim();
  }
  return arg.trim();
}

/** What is wrong with one select on a column-restricted object, or null. `consts` resolves a
 *  `const NAME = "..."` column list defined in the same file. */
export function selectProblem({ arg, signedInOnly }, privateCols, consts = new Map()) {
  if (arg === "") return "select() asks for every column";
  let first = firstArg(arg);                          // .select("...", { count, head }) has options after
  if (consts.has(first)) first = consts.get(first);
  // Even a signed-in-only query must not use "*": the same code is one refactor away from a visitor.
  if (/^["'`]\s*\*\s*["'`]$/.test(first)) return 'select("*") asks for every column';
  // A plain list (one string literal, not chosen by a sign-in check) runs for visitors too.
  const literal = first.match(/^["'`]([^"'`]*)["'`]$/);
  if (literal && !signedInOnly) {
    const named = literal[1].split(",").map((c) => c.trim().split(/[\s:(!]/)[0]);
    const bad = named.filter((c) => privateCols.has(c));
    if (bad.length) return `names ${bad.join(", ")}, which anon may not read`;
  }
  return null;
}

/** `const NAME = "literal"` definitions in a file, for column lists kept in a constant. */
export function stringConsts(src) {
  const out = new Map();
  for (const [, name, lit] of stripJsComments(src).matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*("[^"\n]*"|'[^'\n]*')\s*(?:as\s+const\s*)?;/g)) {
    out.set(name, lit);
  }
  return out;
}

const walk = (dir, exts) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : walk(p, exts);
    return exts.includes(extname(p)) ? [p] : [];
  });

test("the detector finds select(*), select() and obj(*), and passes named public columns", () => {
  const priv = new Set(["created_by"]);
  const on = (src) => selectsOn(src, ["resources"]).map((s) => selectProblem(s, priv, stringConsts(src)));
  assert.deepEqual(on(`supabase.from("resources").select("*").eq("id", id)`), ['select("*") asks for every column']);
  assert.deepEqual(on(`supabase\n  .from("resources" as any)\n  .select()\n`), ["select() asks for every column"]);
  assert.deepEqual(on(`supabase.from("resources").select("id, created_by")`), ["names created_by, which anon may not read"]);
  assert.deepEqual(on(`const COLS = "id, created_by";\nsupabase.from("resources").select(COLS)`), ["names created_by, which anon may not read"]);
  assert.deepEqual(on(`supabase.from("resources").select("id, name", { count: "exact", head: true })`), [null]);
  assert.deepEqual(on(`supabase.from("resources").select(signedIn ? "id, created_by" : "id")`), [null],
    "a list chosen by a sign-in check is the caller's to get right");
  assert.deepEqual(on(`supabase.from("resources")\n  // signed-in only: the editor\n  .select("id, created_by")`), [null]);
  assert.deepEqual(on(`supabase.from("resources")\n  // signed-in only\n  .select("*")`), ['select("*") asks for every column'],
    "never *, signed in or not");
  assert.deepEqual(on(`// supabase.from("resources").select("*")`), [], "a commented-out query does not count");
  assert.deepEqual(on(`supabase.from("grants").select("*")`), [], "other tables are not this guard's business");
  assert.equal(firstArg(`"a, b", { head: true }`), `"a, b"`);
});

test(`${FIX} lists what it hides, and every listed column is real`, () => {
  for (const obj of ["investigators_public", "projects", "resources", "announcements", "entity_comments",
    "dandisets", "harvester_relations", "harvester_settings", "feature_suggestions_public"]) {
    assert.ok(PRIVATE.has(obj), `${obj} is not in the private list`);
  }
  assert.ok(PRIVATE.get("investigators_public").has("user_id") && PRIVATE.get("investigators_public").has("pending_role"));
  // A typo here would hide nothing and say nothing, because the migration skips a column that does not
  // exist (so it can run before 20261105120000). So: in types.ts (the live schema), or added by a migration.
  const types = read("src/integrations/supabase/types.ts");
  const added = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");
  const missing = [];
  for (const [obj, cols] of PRIVATE) {
    const block = types.match(new RegExp(`\\n      ${obj}: \\{\\n        Row: \\{\\n([\\s\\S]*?)\\n        \\}`));
    assert.ok(block, `${obj} is not a table or view in types.ts`);
    for (const col of cols) {
      const inTypes = new RegExp(`\\n          ${col}\\??:`).test("\n" + block[1]);
      const inMigration = new RegExp(`ADD COLUMN (IF NOT EXISTS )?${col}\\b`, "i").test(added);
      if (!inTypes && !inMigration) missing.push(`${obj}.${col}`);
    }
  }
  assert.deepEqual(missing, [], "private columns that exist nowhere (a typo hides nothing)");
});

test("the site and the e2e checks never ask a column-restricted object for every column", () => {
  const files = [...walk(join(ROOT, "src"), [".ts", ".tsx"]), ...walk(join(ROOT, "e2e"), [".ts"])]
    .filter((p) => !p.endsWith(join("supabase", "types.ts")));
  const problems = [];
  for (const p of files) {
    const src = readFileSync(p, "utf8");
    const consts = stringConsts(src);
    for (const s of selectsOn(src, OBJECTS)) {
      const why = selectProblem(s, PRIVATE.get(s.object), consts);
      if (why) problems.push(`${relative(ROOT, p)}: ${s.object} ${why}`);
    }
    const code = stripJsComments(src);
    for (const [, obj] of code.matchAll(/[\s,"'`(:]([a-z_]+)(?:!inner|!left)?\(\s*\*\s*\)/g)) {
      if (PRIVATE.has(obj)) problems.push(`${relative(ROOT, p)}: embeds ${obj}(*)`);
    }
    // A raw REST call: select=* on one of these objects, or on a table named by a variable.
    for (const [, table] of code.matchAll(/\/rest\/v1\/([a-z_]+|\$\{[^}]+\})\?(?:[^"'`\s]*&)?select=\*/g)) {
      if (PRIVATE.has(table) || table.startsWith("${")) problems.push(`${relative(ROOT, p)}: REST select=* on ${table}`);
    }
  }
  assert.deepEqual(problems, [],
    "anon may read only named public columns of these objects (20261117190000): select=* is refused for "
    + "every visitor. Name the columns; a private one only behind a sign-in check.");
});

test("the KG exporter reads every column-restricted object it uses through PUBLIC_COLUMNS, with no private column", () => {
  const py = read("kg/bbqs_kg.py");
  const block = py.match(/^PUBLIC_COLUMNS = \{([\s\S]*?)^\}/m);
  assert.ok(block, "kg/bbqs_kg.py has no PUBLIC_COLUMNS");
  const lists = new Map();
  for (const [, obj, body] of block[1].matchAll(/"([a-z_]+)":\s*((?:"[^"]*"\s*)+),?/g)) {
    lists.set(obj, body.replace(/"\s*"/g, "").replace(/"/g, "").split(",").map((c) => c.trim()).filter(Boolean));
  }
  assert.match(py, /if select == "\*":\s*\n\s*select = PUBLIC_COLUMNS\.get\(table, "\*"\)/,
    "fetch() must turn the default select=* into PUBLIC_COLUMNS");
  const problems = [];
  for (const [obj, cols] of lists) {
    if (!PRIVATE.has(obj)) problems.push(`PUBLIC_COLUMNS["${obj}"]: not column-restricted, needs no list`);
    else for (const c of cols) if (PRIVATE.get(obj).has(c)) problems.push(`PUBLIC_COLUMNS["${obj}"] names ${c}`);
  }
  // Every column-restricted object read with the default select: by the exporter, and by roundtrip.py.
  const fetched = new Set([...py.matchAll(/self\.fetch\("([a-z_]+)"\)/g)].map((m) => m[1]));
  const tables = read("kg/roundtrip.py").match(/^TABLES = \[([\s\S]*?)\]/m);
  assert.ok(tables, "kg/roundtrip.py has no TABLES list");
  for (const [, t] of tables[1].matchAll(/"([a-z_]+)"/g)) fetched.add(t);
  for (const obj of fetched) if (PRIVATE.has(obj) && !lists.has(obj)) problems.push(`${obj} is read with select=* and has no PUBLIC_COLUMNS`);
  assert.deepEqual(problems, []);
});

/** What a migration after FIX does wrong with the private columns, as a list of messages. */
export function laterMigrationProblems(file, sqlText, privateMap = PRIVATE) {
  const sql = sqlText.replace(/\r\n/g, "\n");
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const problems = [];
  for (const [, cols, obj, to] of code.matchAll(/\bgrant\s+(?:select|all(?:\s+privileges)?)\s*(\([^)]*\))?\s+on\s+(?:table\s+)?(?:public\.)?"?([a-z_]+)"?\s+to\s+([^;]+);/gi)) {
    const o = obj.toLowerCase();
    if (!privateMap.has(o) || !/\banon\b|\bpublic\b/i.test(to)) continue;
    if (!cols) { problems.push(`${file}: grants anon all of ${o}`); continue; }
    for (const c of cols.slice(1, -1).split(",").map((x) => x.trim().replace(/"/g, ""))) {
      if (privateMap.get(o).has(c)) problems.push(`${file}: grants anon ${o}.${c}`);
    }
  }
  // A redefined view keeps its column grants, so a column it appends is hidden from anon until granted.
  for (const [, view] of code.matchAll(/\bcreate\s+or\s+replace\s+view\s+(?:public\.)?"?([a-z_]+)"?/gi)) {
    const v = view.toLowerCase();
    if (!privateMap.has(v)) continue;
    const granted = new RegExp(`grant\\s+select\\s*\\([^)]*\\)\\s+on\\s+(?:table\\s+)?(?:public\\.)?${v}\\s+to\\s+[^;]*\\banon\\b`, "i").test(code);
    if (!granted && !/private from anon:/i.test(sql)) {
      problems.push(`${file}: redefines ${v} without GRANT SELECT (<new columns>) ON public.${v} TO anon `
        + `or a comment "-- private from anon: <columns>" (anon reads ${v} column by column since ${FIX})`);
    }
  }
  // A column added to one of these objects is hidden from anon until granted: say which it is meant to be.
  for (const [, obj, list] of code.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_]+)"?\s+([^;]*?\badd\s+column[^;]*);/gi)) {
    const o = obj.toLowerCase();
    if (!privateMap.has(o)) continue;
    for (const [, col] of list.matchAll(/\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_]+)"?/gi)) {
      const granted = new RegExp(`grant\\s+select\\s*\\([^)]*\\b${col}\\b[^)]*\\)\\s+on\\s+(?:table\\s+)?(?:public\\.)?${o}\\s+to\\s+[^;]*\\banon\\b`, "i").test(code);
      const declared = new RegExp(`private from anon:[^\\n]*\\b${col}\\b`, "i").test(sql);
      if (!granted && !declared) {
        problems.push(`${file}: adds ${o}.${col} without GRANT SELECT (${col}) ON public.${o} TO anon `
          + `or a comment "-- private from anon: ${col}"`);
      }
    }
  }
  return problems;
}

test("the migration check finds a grant back, an unexplained new column and an unexplained redefinition", () => {
  const priv = new Map([["projects", new Set(["last_edited_by"])], ["investigators_public", new Set(["user_id"])]]);
  const on = (sql) => laterMigrationProblems("x.sql", sql, priv);
  assert.deepEqual(on("GRANT SELECT ON public.projects TO anon;"), ["x.sql: grants anon all of projects"]);
  assert.deepEqual(on("GRANT SELECT (id, last_edited_by) ON public.projects TO anon, authenticated;"),
    ["x.sql: grants anon projects.last_edited_by"]);
  assert.deepEqual(on("GRANT SELECT ON public.grants TO anon;"), [], "other tables are not this guard's business");
  assert.equal(on("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS foo text;").length, 1);
  assert.deepEqual(on("ALTER TABLE public.projects ADD COLUMN foo text;\nGRANT SELECT (foo) ON public.projects TO anon;"), []);
  assert.deepEqual(on("-- private from anon: foo\nALTER TABLE public.projects ADD COLUMN foo text;"), []);
  assert.deepEqual(on("-- GRANT SELECT ON public.projects TO anon;"), [], "a commented-out grant does not count");
  assert.equal(on("CREATE OR REPLACE VIEW public.investigators_public AS SELECT id FROM public.investigators;").length, 1);
  assert.deepEqual(on("CREATE OR REPLACE VIEW public.investigators_public AS SELECT id, x FROM public.investigators;\n"
    + "GRANT SELECT (x) ON public.investigators_public TO anon;"), []);
});

test("no later migration opens a private column to anon, and a new column on these objects says whether anon reads it", () => {
  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f > FIX).sort();
  const problems = later.flatMap((file) => laterMigrationProblems(file, readFileSync(join(MIGRATIONS, file), "utf8")));
  assert.deepEqual(problems, []);
});
