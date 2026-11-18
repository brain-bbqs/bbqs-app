// Guard: a column that only a hand-applied migration adds is read through selectWithOptionalColumns.
//
// Migrations are applied by hand, so production can lack a column the code names. PostgREST refuses
// a select that names a missing column (400, 42703), and since 20261117190000 the public views are
// read by named columns, never "*". On 2026-11-18 production's investigators_public had no
// `onboarded` (20261008120000 not applied): the exporter lost every person's details until it
// learned to drop the column (kg/bbqs_kg.py fetch), and the People page and the person summary on
// this branch both named it and would have failed for every visitor once deployed.
// src/lib/optionalColumns.ts registers such columns; this guard holds every reader to the helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = join(ROOT, "src", "lib", "optionalColumns.ts");

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** OPTIONAL_COLUMNS as { object: { column: migration } }, read from the helper's literal. */
export function registered(src) {
  const body = stripComments(src).match(/OPTIONAL_COLUMNS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(body, "could not read OPTIONAL_COLUMNS in src/lib/optionalColumns.ts");
  const out = {};
  for (const [, object, cols] of body[1].matchAll(/([a-z_]+)\s*:\s*\{([^}]*)\}/g)) {
    out[object] = Object.fromEntries([...cols.matchAll(/([a-z_]+)\s*:\s*["']([^"']+)["']/g)].map((m) => [m[1], m[2]]));
  }
  return out;
}

/** Plain .from("<object>") ... .select("<literal>") column lists in a file: [{ object, columns }]. */
export function plainSelects(src, objects) {
  const code = stripComments(src);
  const found = [];
  for (const m of code.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]/g)) {
    if (!objects.includes(m[1])) continue;
    const rest = code.slice(m.index + m[0].length);
    const next = rest.search(/\.from\(/);
    const chain = rest.slice(0, next === -1 ? 800 : Math.min(next, 800));
    const sel = chain.match(/\.select\(\s*(["'`])([^"'`]*)\1/);
    if (sel) found.push({ object: m[1], columns: sel[2].split(",").map((c) => c.trim().split(/[\s:(!]/)[0]) });
  }
  return found;
}

/** The top-level arguments of the call whose "(" is at `open`: split at commas outside quotes and brackets. */
export function callArgs(code, open) {
  const args = [];
  let depth = 0, quote = null, cur = "";
  for (let i = open + 1; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) { cur += ch; if (ch === quote && code[i - 1] !== "\\") quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) { if (depth === 0) { args.push(cur.trim()); return args; } depth -= 1; }
    if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  return args;
}

/** selectWithOptionalColumns("<object>", "<required>", [<optional>...], refine) calls. A part that is
 *  not a literal comes back undefined (object, required) or null (optional). */
export function helperCalls(src) {
  const code = stripComments(src);
  const calls = [];
  const lit = (s) => (s ?? "").match(/^["'`]([^"'`]*)["'`]$/)?.[1];
  for (const m of code.matchAll(/selectWithOptionalColumns(?:<[^>(]*>)?\(/g)) {
    if (/function\s+$/.test(code.slice(0, m.index))) continue;          // the helper's own definition
    const [objectArg, requiredArg, optionalArg] = callArgs(code, m.index + m[0].length - 1);
    const required = lit(requiredArg);
    calls.push({
      object: lit(objectArg),
      required: required?.split(",").map((c) => c.trim().split(/[\s:(!]/)[0]),
      optional: (optionalArg ?? "").startsWith("[") ? [...optionalArg.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]) : null,
      text: code.slice(m.index, m.index + 90).replace(/\s+/g, " "),
    });
  }
  return calls;
}

const walk = (dir, exts) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return n === "node_modules" ? [] : walk(p, exts);
  return exts.includes(extname(p)) ? [p] : [];
});

test("the detectors read a plain select and a helper call", () => {
  const plain = 'await supabase.from("people_view" as any).select("id, name, added_later").eq("id", 1);';
  assert.deepEqual(plainSelects(plain, ["people_view"]), [{ object: "people_view", columns: ["id", "name", "added_later"] }]);
  assert.deepEqual(plainSelects('supabase.from("other").select("added_later")', ["people_view"]), []);
  const viaHelper = 'await selectWithOptionalColumns("people_view", "id, name", ["added_later"], (q) => q.eq("id", 1));';
  assert.deepEqual(helperCalls(viaHelper).map(({ object, required, optional }) => ({ object, required, optional })),
    [{ object: "people_view", required: ["id", "name"], optional: ["added_later"] }]);
  assert.deepEqual(plainSelects(viaHelper, ["people_view"]), [], "a helper call is not a plain select");
  const dynamic = helperCalls("selectWithOptionalColumns(table, cols, extra)")[0];
  assert.equal(dynamic.object, undefined);
  assert.equal(dynamic.optional, null);
});

test("every registered optional column names a migration that exists", () => {
  const reg = registered(readFileSync(HELPER, "utf8"));
  assert.ok(Object.keys(reg).length > 0);
  for (const [object, cols] of Object.entries(reg)) {
    for (const [column, migration] of Object.entries(cols)) {
      assert.ok(existsSync(join(ROOT, "supabase", "migrations", `${migration}.sql`)),
        `${object}.${column}: supabase/migrations/${migration}.sql does not exist`);
    }
  }
});

test("no select names an optional column directly, and every helper call is literal and registered", () => {
  const reg = registered(readFileSync(HELPER, "utf8"));
  const objects = Object.keys(reg);
  const files = [...walk(join(ROOT, "src"), [".ts", ".tsx"]), ...walk(join(ROOT, "e2e"), [".ts"])]
    .filter((p) => p !== HELPER && !p.endsWith(join("supabase", "types.ts")));
  const problems = [];
  for (const p of files) {
    const src = readFileSync(p, "utf8");
    for (const s of plainSelects(src, objects)) {
      const named = s.columns.filter((c) => c in reg[s.object]);
      if (named.length) problems.push(`${relative(ROOT, p)}: select on ${s.object} names ${named.join(", ")} directly`);
    }
    for (const call of helperCalls(src)) {
      const where = `${relative(ROOT, p)}: ${call.text}`;
      if (!call.object || !call.required || !call.optional) { problems.push(`${where}: object, required and optional must be literals`); continue; }
      if (!(call.object in reg)) { problems.push(`${where}: ${call.object} is not in OPTIONAL_COLUMNS`); continue; }
      for (const c of call.optional) if (!(c in reg[call.object])) problems.push(`${where}: ${c} is not registered as optional for ${call.object}`);
      for (const c of call.required) if (c in reg[call.object]) problems.push(`${where}: ${c} is optional, but is in the required list`);
    }
  }
  assert.deepEqual(problems, [],
    "A column in OPTIONAL_COLUMNS may be missing from the live database (its migration is applied by hand). "
    + "A select that names it is refused whole (42703). Read it with selectWithOptionalColumns(object, required, "
    + "[optional], refine) from src/lib/optionalColumns.ts, and let the caller cope with the field being absent.");
});

/** The helper itself, with its types stripped and a stand-in for the supabase client. */
async function loadHelper(fake) {
  const src = readFileSync(HELPER, "utf8");
  assert.match(src, /import \{ supabase \} from "@\/integrations\/supabase\/client";/);
  const js = stripTypeScriptTypes(src.replace(/import \{ supabase \}[^\n]*\n/, ""));
  globalThis.__optionalColumnsFake = fake;
  const url = "data:text/javascript," + encodeURIComponent("const supabase = globalThis.__optionalColumnsFake;\n" + js + `\n// ${Math.random()}`);
  return import(url);
}

/** A stand-in database: `has` is the set of columns the object really has. */
function fakeDb(has, rows = [{ id: 1 }]) {
  const asked = [];
  const answer = (cols, refined) => {
    const missing = cols.split(",").map((c) => c.trim()).find((c) => !has.has(c));
    if (missing) return { data: null, error: { code: "42703", message: `column people_view.${missing} does not exist` } };
    return { data: refined === "single" ? rows[0] : rows, error: null };
  };
  const client = {
    from: (object) => ({
      select: (cols) => {
        asked.push(cols);
        const query = { then: (ok, no) => Promise.resolve(answer(cols)).then(ok, no) };
        query.single = () => Promise.resolve(answer(cols, "single"));
        return query;
      },
    }),
  };
  return { client, asked };
}

test("the helper drops a missing optional column and asks again; anything else comes back as it is", async () => {
  // the column exists: one request, with it
  let db = fakeDb(new Set(["id", "name", "added_later"]));
  let { selectWithOptionalColumns } = await loadHelper(db.client);
  let res = await selectWithOptionalColumns("people_view", "id, name", ["added_later"]);
  assert.equal(res.error, null);
  assert.deepEqual(db.asked, ["id, name, added_later"]);

  // the column is missing (the migration is not applied): asked once with it, once without, and the rows come back
  db = fakeDb(new Set(["id", "name"]));
  ({ selectWithOptionalColumns } = await loadHelper(db.client));
  res = await selectWithOptionalColumns("people_view", "id, name", ["added_later"], (q) => q.single());
  assert.equal(res.error, null);
  assert.deepEqual(res.data, { id: 1 });
  assert.deepEqual(db.asked, ["id, name, added_later", "id, name"]);

  // two optional columns missing: dropped one by one
  db = fakeDb(new Set(["id"]));
  ({ selectWithOptionalColumns } = await loadHelper(db.client));
  res = await selectWithOptionalColumns("people_view", "id", ["a_later", "b_later"]);
  assert.equal(res.error, null);
  assert.deepEqual(db.asked, ["id, a_later, b_later", "id, b_later", "id"]);

  // a REQUIRED column is missing: that is an error, not something to hide
  db = fakeDb(new Set(["id", "added_later"]));
  ({ selectWithOptionalColumns } = await loadHelper(db.client));
  res = await selectWithOptionalColumns("people_view", "id, name", ["added_later"]);
  assert.equal(res.error?.code, "42703");
  assert.deepEqual(db.asked, ["id, name, added_later"]);

  // any other refusal (a private column, RLS) is returned untouched, with no second request
  const refused = { from: () => ({ select: () => Promise.resolve({ data: null, error: { code: "42501", message: "permission denied for view people_view" } }) }) };
  ({ selectWithOptionalColumns } = await loadHelper(refused));
  res = await selectWithOptionalColumns("people_view", "id", ["added_later"]);
  assert.equal(res.error?.code, "42501");
});
