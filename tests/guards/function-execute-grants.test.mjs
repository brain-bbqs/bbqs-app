// Guard: every function a migration creates in schema public says who may run it.
//
// WHY (2026-11-18). PostgreSQL grants EXECUTE on a new function to PUBLIC, and Supabase's default
// privileges grant it to anon and authenticated by name as well, so nothing decides who may call a
// function, and a SECURITY DEFINER one runs past row-level security. On a replica of this schema,
// 100 of the 107 functions in public were executable by anon, among them record_investigator_alias
// (anyone could add their own address to a member's record, and globus-auth then signs that address
// in as the member) and check_onboard_conflicts (any member's e-mail address, given the name).
// 20261118120000_privacy_round_two gave every function a tier. This guard keeps the next one from
// arriving open:
//   * every CREATE [OR REPLACE] FUNCTION public.<f> in a migration from 20261118120000 on comes with,
//     in the same file, a REVOKE of EXECUTE (or ALL) on <f> FROM PUBLIC (anon holds what PUBLIC
//     holds), and, for anon and for authenticated each, a REVOKE that names the role or a GRANT
//     EXECUTE on <f> TO it. CREATE OR REPLACE keeps an existing function's grants, but a changed
//     argument list makes a new function with the defaults again, so every definition says it;
//   * 20261118120000's kg_function_access names every function an earlier migration defines and has
//     not dropped since, once, with a tier, so the audit covers them all.
// For a function only signed-in users run:
//   REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon;
//   GRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated, service_role;
// For one only the owner and the service role run (a trigger function, a maintenance helper):
//   REVOKE ALL ON FUNCTION public.f() FROM PUBLIC, anon, authenticated;
//   GRANT EXECUTE ON FUNCTION public.f() TO service_role;
// A trigger fires whatever its function's grants (checked on the replica), but a function an invoker
// trigger calls, an index expression, an RLS policy or a view runs as the role that evaluates it:
// see the header of 20261118120000 before taking EXECUTE from a role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const FIX = "20261118120000_privacy_round_two.sql";
const ROLES = ["anon", "authenticated"];

/** SQL with comments removed (CRLF-safe), so a commented-out CREATE, REVOKE or GRANT does not count. */
export function stripComments(sql) {
  return sql.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const IDENT = String.raw`"?([A-Za-z_][\w$]*)"?`;

/** Functions in schema public that a migration creates or drops, in file order: { op, name, at }. */
export function functionEvents(sql) {
  const code = stripComments(sql);
  const out = [];
  const create = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+(?:${IDENT}\s*\.\s*)?${IDENT}\s*\(`, "gi");
  for (const m of code.matchAll(create)) {
    const schema = (m[1] ?? "public").toLowerCase();
    if (schema === "public") out.push({ op: "create", name: m[2].toLowerCase(), at: m.index });
  }
  const drop = /\bdrop\s+function\s+(?:if\s+exists\s+)?([^;]+);/gi;
  for (const m of code.matchAll(drop)) {
    for (const item of splitTopLevel(m[1])) {
      const n = item.trim().match(new RegExp(String.raw`^(?:${IDENT}\s*\.\s*)?${IDENT}`));
      if (n && (n[1] ?? "public").toLowerCase() === "public") out.push({ op: "drop", name: n[2].toLowerCase(), at: m.index });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Split on commas outside parentheses. */
export function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Every GRANT / REVOKE on functions in a migration: { kind, privileges, names (null = every function
 *  in schema public), grantees }. */
export function functionPrivilegeStatements(sql) {
  const code = stripComments(sql);
  const out = [];
  const re = /\b(grant|revoke)\s+((?:grant\s+option\s+for\s+)?[\w\s,]+?)\s+on\s+(all\s+(?:functions|routines)\s+in\s+schema|functions?|routines?|procedures?)\s+([\s\S]*?)\s+(?:from|to)\s+([^;]+);/gi;
  for (const m of code.matchAll(re)) {
    const privileges = m[2].toLowerCase().replace(/grant\s+option\s+for\s+/, "").split(/\s*,\s*/).map((p) => p.trim());
    if (!privileges.some((p) => p === "execute" || p === "all" || p === "all privileges")) continue;
    const every = /^all\s/i.test(m[3]);
    if (every && !/^\s*"?public"?\s*$/i.test(m[4])) continue;
    const names = every ? null : splitTopLevel(m[4]).map((item) => {
      const n = item.trim().match(new RegExp(String.raw`^(?:${IDENT}\s*\.\s*)?${IDENT}`));
      return n && (n[1] ?? "public").toLowerCase() === "public" ? n[2].toLowerCase() : null;
    }).filter(Boolean);
    const grantees = m[5].toLowerCase().replace(/\s+(cascade|restrict|granted\s+by[\s\S]*|with\s+grant\s+option)\s*$/i, "")
      .split(/\s*,\s*/).map((g) => g.trim().replace(/"/g, ""));
    out.push({ kind: m[1].toLowerCase(), names, grantees });
  }
  return out;
}

/** What a migration does wrong: each public function it creates without saying who may run it. */
export function executeProblems(file, sql) {
  const created = [...new Set(functionEvents(sql).filter((e) => e.op === "create").map((e) => e.name))];
  const stmts = functionPrivilegeStatements(sql);
  const covers = (s, name) => s.names === null || s.names.includes(name);
  const problems = [];
  for (const name of created) {
    const revoked = (role) => stmts.some((s) => s.kind === "revoke" && covers(s, name) && s.grantees.includes(role));
    const granted = (role) => stmts.some((s) => s.kind === "grant" && covers(s, name) && s.grantees.includes(role));
    const missing = [];
    if (!revoked("public")) missing.push("REVOKE ... FROM PUBLIC");
    for (const role of ROLES) if (!revoked(role) && !granted(role)) missing.push(`a REVOKE from or GRANT EXECUTE to ${role}`);
    if (missing.length) problems.push(`${file}: public.${name} has no ${missing.join(", no ")}`);
  }
  return problems;
}

/** fn_name -> tier, from 20261118120000's kg_function_access rows. */
export function functionTiers(sql) {
  const start = sql.indexOf("INSERT INTO kg_function_access");
  assert.ok(start >= 0, `${FIX} has no INSERT INTO kg_function_access`);
  const block = sql.slice(start, sql.indexOf(";\n", start));
  const rows = [...block.matchAll(/^\s*\('([a-z_0-9]+)',\s*'([a-z]+)',\s*'/gm)].map((m) => [m[1], m[2]]);
  return rows;
}

test("the detector finds a function that does not say who may run it, and passes one that does", () => {
  const fn = "CREATE OR REPLACE FUNCTION public.f(_x uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;\n";
  assert.deepEqual(executeProblems("x.sql", fn),
    ["x.sql: public.f has no REVOKE ... FROM PUBLIC, no a REVOKE from or GRANT EXECUTE to anon, no a REVOKE from or GRANT EXECUTE to authenticated"]);
  assert.deepEqual(executeProblems("x.sql", fn + "REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon;\n"
    + "GRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated, service_role;"), []);
  assert.deepEqual(executeProblems("x.sql", fn + "REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM anon, authenticated;"),
    ["x.sql: public.f has no REVOKE ... FROM PUBLIC"], "anon holds what PUBLIC holds: PUBLIC must go too");
  assert.deepEqual(executeProblems("x.sql", fn + "REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC;"),
    ["x.sql: public.f has no a REVOKE from or GRANT EXECUTE to anon, no a REVOKE from or GRANT EXECUTE to authenticated"],
    "Supabase grants anon and authenticated by name: a REVOKE from PUBLIC leaves them");
  assert.deepEqual(executeProblems("x.sql", fn + "REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon, authenticated;\n"
    + "GRANT EXECUTE ON FUNCTION public.f(uuid) TO service_role;"), []);
  assert.deepEqual(executeProblems("x.sql", fn + "REVOKE ALL ON FUNCTION public.g(uuid), public.f(uuid) FROM PUBLIC, anon, authenticated;"), [],
    "one statement may name several functions");
  assert.equal(executeProblems("x.sql", fn + "-- REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon, authenticated;").length, 1,
    "a commented-out REVOKE does not count");
  assert.deepEqual(executeProblems("x.sql", "CREATE FUNCTION pg_temp.kg_run() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;"), [],
    "a temporary function is the session's own");
  assert.deepEqual(executeProblems("x.sql", "CREATE FUNCTION unqualified() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;").length, 1,
    "an unqualified name is created in public");
  assert.deepEqual(functionEvents("CREATE FUNCTION public.a() ...; DROP FUNCTION IF EXISTS public.a(), b(int);").map((e) => `${e.op} ${e.name}`),
    ["create a", "drop a", "drop b"]);
});

test(`${FIX} gives every function an earlier migration defines a tier, once`, () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const live = new Set();
  for (const f of files.filter((x) => x < FIX)) {
    for (const e of functionEvents(readFileSync(join(MIGRATIONS, f), "utf8"))) {
      if (e.op === "create") live.add(e.name); else live.delete(e.name);
    }
  }
  const rows = functionTiers(readFileSync(join(MIGRATIONS, FIX), "utf8").replace(/\r\n/g, "\n"));
  const names = rows.map(([n]) => n);
  assert.ok(names.length >= 100, `read ${names.length} rows of kg_function_access`);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], "a function named twice");
  assert.deepEqual(rows.filter(([, t]) => !["anon", "authenticated", "service"].includes(t)), [], "a tier that is not anon, authenticated or service");
  assert.deepEqual([...live].filter((n) => !names.includes(n)).sort(), [],
    `functions an earlier migration defines that ${FIX} gives no tier: add each to kg_function_access`);
  // A name no other migration mentions, types.ts does not know and DATABASE_DESIGN.md does not record is
  // a typo: the run would skip it. (Some functions predate the migrations, e.g. handle_new_user, which
  // the design document records, and a trigger function is not in types.ts.)
  const types = readFileSync(join(ROOT, "src", "integrations", "supabase", "types.ts"), "utf8");
  const typed = new Set([...(types.match(/\n    Functions: \{([\s\S]*?)\n    \}/)?.[1] ?? "").matchAll(/\n      ([a-z_0-9]+): \{/g)].map((m) => m[1]));
  const elsewhere = files.filter((f) => f !== FIX).map((f) => stripComments(readFileSync(join(MIGRATIONS, f), "utf8")))
    .concat(readFileSync(join(ROOT, "DATABASE_DESIGN.md"), "utf8")).join("\n");
  assert.deepEqual(names.filter((n) => !live.has(n) && !typed.has(n) && !new RegExp(`\\b${n}\\s*\\(`).test(elsewhere)), [],
    "kg_function_access names a function no migration mentions, types.ts does not know and DATABASE_DESIGN.md does not record");
});

test(`every function a migration from ${FIX} on creates says who may run it`, () => {
  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f >= FIX).sort();
  const problems = later.flatMap((f) => executeProblems(f, readFileSync(join(MIGRATIONS, f), "utf8")));
  assert.deepEqual(problems, [],
    "PostgreSQL gives EXECUTE on a new function to PUBLIC and Supabase to anon and authenticated: say who "
    + "may run it, in the same migration (see the header of this guard for the two shapes).");
});
