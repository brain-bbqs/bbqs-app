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
// The list of private columns is the migrations' own (their kg_private_from_anon rows), so there is one.
//
// ROUND TWO (2026-11-18). 20261118120000_privacy_round_two added projects.metadata to that list (every
// questionnaire answer; a visitor reads the keys the public pages show from project_metadata_public),
// and took investigators_public.user_id and .pending_role from signed-in users too (its
// kg_private_from_authenticated rows). So, as well:
//   * no code, signed in or not, asks investigators_public for those two, by select or by filter
//     (.eq("user_id", ...) needs SELECT on the column just as a select does): the person, curators
//     and admins read them from public.investigators;
//   * an embedded select (grants?select=..., projects(metadata)) is held to the same lists;
//   * every key of projects.metadata a public page reads is one project_metadata_public carries,
//     so a page that starts to show a new answer is a failing check, not a field that is silently
//     empty for every visitor;
//   * no later migration gives signed-in users those two columns back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const FIX = "20261117190000_hide_private_columns_from_anon.sql";
const ROUND2 = "20261118120000_privacy_round_two.sql";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** object -> Set of columns, from a migration's INSERT INTO <list> (object_name, column_name, holds) rows. */
export function privateRows(sql, list = "kg_private_from_anon") {
  const start = sql.indexOf(`INSERT INTO ${list}`);
  assert.ok(start >= 0, `no INSERT INTO ${list}`);
  const block = sql.slice(start, sql.indexOf(";", start));
  const out = new Map();
  for (const [, obj, col] of block.matchAll(/\(\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'/g)) {
    if (!out.has(obj)) out.set(obj, new Set());
    out.get(obj).add(col);
  }
  return out;
}

/** object -> Set of the columns a migration takes from anon, from its kg_private_from_anon rows. */
export const privateFromAnon = (sql) => privateRows(sql, "kg_private_from_anon");

/** The union of several object -> Set maps. */
export function mergePrivate(...maps) {
  const out = new Map();
  for (const m of maps) for (const [obj, cols] of m) out.set(obj, new Set([...(out.get(obj) ?? []), ...cols]));
  return out;
}

const PRIVATE = mergePrivate(privateFromAnon(read(join("supabase", "migrations", FIX))),
  privateFromAnon(read(join("supabase", "migrations", ROUND2))));
const OBJECTS = [...PRIVATE.keys()];
/** Columns signed-in users may not read either (20261118120000's kg_private_from_authenticated rows). */
const PRIVATE_FROM_AUTHENTICATED = privateRows(read(join("supabase", "migrations", ROUND2)), "kg_private_from_authenticated");

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

test(`${FIX} and ${ROUND2} list what they hide, and every listed column is real`, () => {
  for (const obj of ["investigators_public", "projects", "resources", "announcements", "entity_comments",
    "dandisets", "harvester_relations", "harvester_settings", "feature_suggestions_public"]) {
    assert.ok(PRIVATE.has(obj), `${obj} is not in the private list`);
  }
  assert.ok(PRIVATE.get("investigators_public").has("user_id") && PRIVATE.get("investigators_public").has("pending_role"));
  assert.ok(PRIVATE.get("projects").has("metadata"), `${ROUND2} takes projects.metadata from anon`);
  assert.deepEqual([...(PRIVATE_FROM_AUTHENTICATED.get("investigators_public") ?? [])].sort(), ["pending_role", "user_id"],
    `${ROUND2} takes investigators_public.user_id and .pending_role from signed-in users`);
  // A typo here would hide nothing and say nothing, because the migration skips a column that does not
  // exist (so it can run before 20261105120000). So: in types.ts (the live schema), or added by a migration.
  const types = read("src/integrations/supabase/types.ts");
  const added = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");
  const missing = [];
  for (const [obj, cols] of mergePrivate(PRIVATE, PRIVATE_FROM_AUTHENTICATED)) {
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

/** The names a select list (or an embed's inner list) asks for at its own level: `alias:column` is
 *  the column, `metadata->>key` is metadata, an embed `name(...)` is not a column of this level. */
export function topLevelColumns(list) {
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { items.push(cur); cur = ""; } else cur += ch;
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter((s) => s && !s.includes("("))
    .map((s) => (s.match(/^[A-Za-z_]\w*\s*:(?!:)\s*([A-Za-z_]\w*)/) || s.match(/^([A-Za-z_]\w*)/) || [])[1])
    .filter(Boolean);
}

/** Every embedded resource in a select list, at any depth: `name(...)`, `alias:name(...)`,
 *  `name!hint(...)`, as { object, cols } with cols what the embed asks for at its own level. */
export function embedsIn(list) {
  const out = [];
  const re = /(?:^|[\s,(])(?:[A-Za-z_]\w*\s*:\s*)?([a-z_]+)(?:\s*!\s*[a-z_]+)?\s*\(/g;
  let m;
  while ((m = re.exec(list)) !== null) {
    const open = m.index + m[0].length;
    let depth = 0;
    let i = open;
    for (; i < list.length; i += 1) {
      if (list[i] === "(") depth += 1;
      else if (list[i] === ")") { if (depth === 0) break; depth -= 1; }
    }
    out.push({ object: m[1], cols: topLevelColumns(list.slice(open, i)) });
    re.lastIndex = open;                                  // nested embeds are found on the way on
  }
  return out;
}

/** Every .select("literal") in a file, whatever object it is on: { text, signedInOnly }. */
export function selectLiterals(src) {
  const code = stripJsComments(src);
  const out = [];
  for (const m of code.matchAll(/\.select\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    const raw = src.slice(Math.max(0, m.index - 400), m.index + m[0].length);
    out.push({ text: m[2], signedInOnly: SIGNED_IN_ONLY.test(raw) });
  }
  return out;
}

/** What a file does wrong with the columns signed-in users may not read either: a select that names
 *  one (signed in or not: no sign-in check lets a member read another member's login id), a filter
 *  or order on one (it needs SELECT on the column just as a select does), a raw REST URL with one. */
export function hiddenFromSignedInProblems(src, privateAuth = PRIVATE_FROM_AUTHENTICATED) {
  const code = stripJsComments(src);
  const problems = [];
  const objects = [...privateAuth.keys()];
  const from = /\.from\(\s*["'`]([a-z_]+)["'`]/g;
  let m;
  while ((m = from.exec(code)) !== null) {
    if (!objects.includes(m[1])) continue;
    const cols = privateAuth.get(m[1]);
    const rest = code.slice(m.index + m[0].length);
    const next = rest.search(/\.from\(/);
    const chain = rest.slice(0, next === -1 ? 800 : Math.min(next, 800));
    const s = chain.match(/\.select\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/);
    if (s) for (const c of topLevelColumns(s[2])) if (cols.has(c)) problems.push(`${m[1]}: selects ${c}`);
    // Any other call whose first argument names one: .eq("user_id", ...), .match({ user_id }),
    // .or("name.ilike.x,user_id.eq.y"), .order("pending_role").
    for (const [, how, arg] of chain.matchAll(/\.(\w+)\(\s*(\{[^}]*\}|"[^"]*"|'[^']*'|`[^`]*`)/g)) {
      if (how === "select") continue;
      for (const c of cols) if (new RegExp(`\\b${c}\\b`).test(arg)) problems.push(`${m[1]}: .${how}() on ${c}`);
    }
  }
  for (const obj of objects) {
    for (const [, query] of code.matchAll(new RegExp(`${obj}\\?([^"'\`\\s]*)`, "g"))) {
      for (const col of privateAuth.get(obj)) {
        if (new RegExp(`(^|[=&,(])${col}\\b`).test(query)) problems.push(`${obj}: REST ${col}`);
      }
    }
  }
  return problems;
}

test("the embed, filter and signed-in detectors find what they should", () => {
  assert.deepEqual(topLevelColumns("id, name:full_name, metadata->>repoUrl, grants(title, abstract)"), ["id", "full_name", "metadata"]);
  assert.deepEqual(embedsIn("grant_number, projects(id, metadata), dandiset:dandisets!inner(id, raw)"),
    [{ object: "projects", cols: ["id", "metadata"] }, { object: "dandisets", cols: ["id", "raw"] }]);
  assert.deepEqual(embedsIn("id, grants(title, projects(metadata))").map((e) => e.object), ["grants", "projects"]);
  assert.deepEqual(selectLiterals(`supabase.from("grants").select("id, projects(metadata)")`), [{ text: "id, projects(metadata)", signedInOnly: false }]);
  const auth = new Map([["investigators_public", new Set(["user_id", "pending_role"])]]);
  const on = (src) => hiddenFromSignedInProblems(src, auth);
  assert.deepEqual(on(`supabase.from("investigators_public").select("id, name").eq("id", x)`), []);
  assert.deepEqual(on(`supabase.from("investigators_public")\n  // signed-in only\n  .select("id, user_id")`),
    ["investigators_public: selects user_id"], "no sign-in check makes another member's login id readable");
  assert.deepEqual(on(`supabase.from("investigators_public").select("id").eq("user_id", user.id)`),
    ["investigators_public: .eq() on user_id"]);
  assert.deepEqual(on(`supabase.from("investigators_public").select("id").not("pending_role", "is", null)`),
    ["investigators_public: .not() on pending_role"]);
  assert.deepEqual(on(`supabase.from("investigators_public").select("id").or(\`name.ilike.%x%,user_id.eq.\${u}\`)`),
    ["investigators_public: .or() on user_id"]);
  assert.deepEqual(on(`supabase.from("investigators_public").select("id").match({ user_id: u })`),
    ["investigators_public: .match() on user_id"]);
  assert.deepEqual(on(`supabase.from("investigators").select("user_id, pending_role").eq("user_id", u)`), [],
    "the base table, under its RLS, is where they are read");
  assert.deepEqual(on("fetch(`${URL}/rest/v1/investigators_public?select=id,name&user_id=eq.${u}`)"), ["investigators_public: REST user_id"]);
  assert.deepEqual(on("kgGet(`investigators_public?id=in.(${ids})&select=id,name`)"), []);
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
    // An embed of one of these objects in another object's select runs for visitors too.
    for (const sel of selectLiterals(src)) {
      if (sel.signedInOnly) continue;
      for (const e of embedsIn(sel.text)) {
        for (const c of e.cols) if (PRIVATE.get(e.object)?.has(c)) problems.push(`${relative(ROOT, p)}: embeds ${e.object}(${c}), which anon may not read`);
      }
    }
    // selectWithOptionalColumns (src/lib/optionalColumns.ts) builds the select itself, from two
    // literal lists (tests/guards/optional-columns holds them literal): they are column lists too,
    // for visitors and for signed-in users alike.
    for (const [, obj, req, opt] of code.matchAll(/selectWithOptionalColumns(?:<[^>(]*>)?\(\s*["'`]([a-z_]+)["'`]\s*,\s*["'`]([^"'`]*)["'`]\s*,\s*\[([^\]]*)\]/g)) {
      const named = [...req.split(","), ...[...opt.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1])]
        .map((c) => c.trim().split(/[\s:(!]/)[0]);
      const hidden = new Set([...(PRIVATE.get(obj) ?? []), ...(PRIVATE_FROM_AUTHENTICATED.get(obj) ?? [])]);
      const bad = named.filter((c) => hidden.has(c));
      if (bad.length) problems.push(`${relative(ROOT, p)}: ${obj} names ${bad.join(", ")} through selectWithOptionalColumns, which is hidden`);
    }
    // A raw REST call: select=* on one of these objects, or on a table named by a variable.
    for (const [, table] of code.matchAll(/\/rest\/v1\/([a-z_]+|\$\{[^}]+\})\?(?:[^"'`\s]*&)?select=\*/g)) {
      if (PRIVATE.has(table) || table.startsWith("${")) problems.push(`${relative(ROOT, p)}: REST select=* on ${table}`);
    }
  }
  assert.deepEqual(problems, [],
    "anon may read only named public columns of these objects (20261117190000, 20261118120000): select=* is "
    + "refused for every visitor. Name the columns; a private one only behind a sign-in check. A visitor reads "
    + "the public questionnaire keys from project_metadata_public (src/lib/projectPublicMetadata.ts).");
});

test("no code path, signed in or not, reads a column hidden from signed-in users", () => {
  const files = [...walk(join(ROOT, "src"), [".ts", ".tsx"]), ...walk(join(ROOT, "e2e"), [".ts"]),
    ...walk(join(ROOT, "supabase", "functions"), [".ts"])].filter((p) => !p.endsWith(join("supabase", "types.ts")));
  const problems = files.flatMap((p) => hiddenFromSignedInProblems(readFileSync(p, "utf8")).map((x) => `${relative(ROOT, p)}: ${x}`));
  assert.deepEqual(problems, [],
    "investigators_public.user_id and .pending_role are hidden from signed-in users too (20261118120000): "
    + "the person, curators and admins read them from public.investigators, whose RLS decides the rows.");
});

/** The keys of projects.metadata the latest definition of project_metadata_public carries:
 *  { keys, deviceKeys }. */
export function publicMetadataKeys(sql) {
  const at = sql.search(/create\s+or\s+replace\s+view\s+public\.project_metadata_public\b/i);
  assert.ok(at >= 0, "no CREATE OR REPLACE VIEW public.project_metadata_public");
  const view = sql.slice(at, sql.indexOf(";", at));
  const list = (re) => [...(view.match(re)?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
  return { keys: new Set(list(/\be\.key\s+IN\s*\(([^)]*)\)/i)), deviceKeys: new Set(list(/\bd\.key\s+IN\s*\(([^)]*)\)/i)) };
}

test("every questionnaire key a public page reads is one project_metadata_public carries", () => {
  const defining = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
    .filter((f) => /view\s+public\.project_metadata_public\b/i.test(readFileSync(join(MIGRATIONS, f), "utf8")));
  assert.ok(defining.length, "no migration defines public.project_metadata_public");
  const { keys, deviceKeys } = publicMetadataKeys(readFileSync(join(MIGRATIONS, defining.at(-1)), "utf8").replace(/\r\n/g, "\n"));
  assert.ok(keys.size >= 20 && deviceKeys.size >= 4, `could not read the view's key lists (${keys.size}, ${deviceKeys.size})`);
  const marr = read("src/components/entity-summary/summaries/GrantMarrSection.tsx");
  const block = (name) => marr.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1] ?? "";
  const fieldKeys = (name) => [...block(name).matchAll(/\b(?:key|projectKey):\s*"([a-z0-9_]+)"/g)].map((x) => x[1]);
  const read_ = {
    "GrantMarrSection MARR_FIELDS": fieldKeys("MARR_FIELDS"),
    "GrantMarrSection ARRAY_FIELDS": fieldKeys("ARRAY_FIELDS"),
    "GrantMarrSection metadata.<key>": [...marr.matchAll(/\bmetadata\.([a-z0-9_]+)/g)].map((x) => x[1]),
    "useMarrProjects md.<key>": [...read("src/hooks/useMarrProjects.ts").matchAll(/\bmd\.([a-z0-9_]+)/g)].map((x) => x[1]),
    "GrantSummary metadata?.<key>": [...read("src/components/entity-summary/summaries/GrantSummary.tsx")
      .matchAll(/\.metadata as any\)\??\.([a-z0-9_]+)/g)].map((x) => x[1]),
  };
  assert.ok(read_["GrantMarrSection MARR_FIELDS"].length >= 7 && read_["useMarrProjects md.<key>"].length >= 5,
    "could not read the keys the public pages use");
  const missing = Object.entries(read_).flatMap(([where, ks]) => ks.filter((k) => !keys.has(k)).map((k) => `${where}: ${k}`));
  for (const k of fieldKeys("DEVICE_FIELDS")) if (!deviceKeys.has(k)) missing.push(`GrantMarrSection DEVICE_FIELDS: devices.${k}`);
  assert.deepEqual(missing, [],
    "a public page reads a questionnaire key a visitor cannot see. Add it to project_metadata_public in a new "
    + "migration (CREATE OR REPLACE VIEW, the same three columns), if it is meant to be public.");
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

/** What a migration after FIX (after ROUND2, for `authenticated`) does wrong with the columns hidden
 *  from `role`, as a list of messages. */
export function laterMigrationProblems(file, sqlText, privateMap = PRIVATE, role = "anon") {
  const sql = sqlText.replace(/\r\n/g, "\n");
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const since = role === "anon" ? FIX : ROUND2;
  const problems = [];
  for (const [, cols, obj, to] of code.matchAll(/\bgrant\s+(?:select|all(?:\s+privileges)?)\s*(\([^)]*\))?\s+on\s+(?:table\s+)?(?:public\.)?"?([a-z_]+)"?\s+to\s+([^;]+);/gi)) {
    const o = obj.toLowerCase();
    if (!privateMap.has(o) || !new RegExp(`\\b${role}\\b|\\bpublic\\b`, "i").test(to)) continue;
    if (!cols) { problems.push(`${file}: grants ${role} all of ${o}`); continue; }
    for (const c of cols.slice(1, -1).split(",").map((x) => x.trim().replace(/"/g, ""))) {
      if (privateMap.get(o).has(c)) problems.push(`${file}: grants ${role} ${o}.${c}`);
    }
  }
  // A redefined view keeps its column grants, so a column it appends is hidden from the role until granted.
  for (const [, view] of code.matchAll(/\bcreate\s+or\s+replace\s+view\s+(?:public\.)?"?([a-z_]+)"?/gi)) {
    const v = view.toLowerCase();
    if (!privateMap.has(v)) continue;
    const granted = new RegExp(`grant\\s+select\\s*\\([^)]*\\)\\s+on\\s+(?:table\\s+)?(?:public\\.)?${v}\\s+to\\s+[^;]*\\b${role}\\b`, "i").test(code);
    if (!granted && !new RegExp(`private from ${role}:`, "i").test(sql)) {
      problems.push(`${file}: redefines ${v} without GRANT SELECT (<new columns>) ON public.${v} TO ${role} `
        + `or a comment "-- private from ${role}: <columns>" (${role} reads ${v} column by column since ${since})`);
    }
  }
  // A column added to one of these objects is hidden from the role until granted: say which it is meant to be.
  for (const [, obj, list] of code.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_]+)"?\s+([^;]*?\badd\s+column[^;]*);/gi)) {
    const o = obj.toLowerCase();
    if (!privateMap.has(o)) continue;
    for (const [, col] of list.matchAll(/\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_]+)"?/gi)) {
      const granted = new RegExp(`grant\\s+select\\s*\\([^)]*\\b${col}\\b[^)]*\\)\\s+on\\s+(?:table\\s+)?(?:public\\.)?${o}\\s+to\\s+[^;]*\\b${role}\\b`, "i").test(code);
      const declared = new RegExp(`private from ${role}:[^\\n]*\\b${col}\\b`, "i").test(sql);
      if (!granted && !declared) {
        problems.push(`${file}: adds ${o}.${col} without GRANT SELECT (${col}) ON public.${o} TO ${role} `
          + `or a comment "-- private from ${role}: ${col}"`);
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
  // The same for signed-in users and the columns hidden from them.
  const forAuth = (sql) => laterMigrationProblems("y.sql", sql, priv, "authenticated");
  assert.deepEqual(forAuth("GRANT SELECT ON public.investigators_public TO authenticated;"), ["y.sql: grants authenticated all of investigators_public"]);
  assert.deepEqual(forAuth("GRANT SELECT (id, user_id) ON public.investigators_public TO authenticated;"),
    ["y.sql: grants authenticated investigators_public.user_id"]);
  assert.deepEqual(forAuth("GRANT SELECT (id, user_id) ON public.investigators_public TO service_role;"), []);
  assert.equal(forAuth("CREATE OR REPLACE VIEW public.investigators_public AS SELECT id, x FROM public.investigators;\n"
    + "GRANT SELECT (x) ON public.investigators_public TO anon;").length, 1, "anon's grant says nothing about signed-in users");
});

test("no later migration opens a private column to anon or to signed-in users, and a new column on these objects says who reads it", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const problems = [
    ...files.filter((f) => f > FIX).flatMap((file) => laterMigrationProblems(file, readFileSync(join(MIGRATIONS, file), "utf8"))),
    ...files.filter((f) => f > ROUND2).flatMap((file) =>
      laterMigrationProblems(file, readFileSync(join(MIGRATIONS, file), "utf8"), PRIVATE_FROM_AUTHENTICATED, "authenticated")),
  ];
  assert.deepEqual(problems, []);
});
