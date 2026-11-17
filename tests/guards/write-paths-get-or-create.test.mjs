// Guard: a write path looks the record up, by its identity key, before it inserts one.
//
// WHY (2026-11-17). The 11-04 export had 14 duplicate groups. 10 were orphan investigator spine rows
// (resources rows typed investigator that no person points at) next to the real person: nih-grants,
// add-project-by-grant and seed-consortium inserted the spine row first and the person second, and
// when the person insert failed (a name or email already taken) the spine row stayed. The others
// came from lookups that missed: an exact or ilike match on a name the registry spells differently
// ("UNIVERSITY OF CALIFORNIA, SAN DIEGO"), a funding call upserted on its FON when its forecast held
// the same notice under another one, a resource matched across types by an ilike pattern with its
// own '%' and '_' stripped. A KG reviewer: "if you have something in the KG already, you don't want
// to duplicate it; cleaning is a difficult and tedious task as the KG grows."
//
// So the write paths share supabase/functions/_shared/kg-write.ts: find by the identity key the
// database's uq_* index refuses a second row by (_shared/identity-keys.ts), reuse it, write only
// when nothing matches, the person before the spine row, and treat a 23505 as "someone else just
// wrote it": read again and reuse. This test holds every path the design names to that, and drives
// the helpers with a fake client, since there is no Deno or database in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nodeModule from "node:module";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FUNCS = join(ROOT, "supabase", "functions");
const KG_WRITE = join(FUNCS, "_shared", "kg-write.ts");
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const fn = (name) => read(`supabase/functions/${name}/index.ts`);

const tsFiles = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
});
const sources = () => tsFiles(FUNCS).map((p) => ({ path: relative(ROOT, p).replace(/\\/g, "/"), src: readFileSync(p, "utf8") }));
const lineOf = (src, i) => src.slice(0, i).split("\n").length;

// The write paths the design names, and the shared modules they write through.
const WRITE_PATHS = ["import-grant-publications", "bbqs-mcp", "nih-grants", "add-project-by-grant", "seed-consortium", "verify-affiliations"];
const SHARED = ["_shared/identity-keys.ts", "_shared/kg-write.ts"];

// A function that fills a STAGING database with fake data and refuses to run against production.
const FAKE_DATA = new Set(["supabase/functions/seed-staging-fakes/index.ts"]);

// ── Static: where people, nodes and organizations may be inserted ─────────────────────────────

test("no investigator spine row is inserted outside _shared/kg-write.ts", () => {
  // A spine row inserted before its person is the orphan the person's failed insert leaves behind.
  const hits = [];
  for (const { path, src } of sources()) {
    if (path === "supabase/functions/_shared/kg-write.ts") continue;
    for (const m of src.matchAll(/resource_type["']?\s*:\s*["'`]investigator["'`]/g)) hits.push(`${path}:${lineOf(src, m.index)}`);
  }
  assert.deepEqual(hits, [], "investigator spine rows written outside findOrCreateInvestigator (person first, then the node)");
});

test("no organization is inserted or upserted outside _shared/kg-write.ts", () => {
  // findOrCreateOrganization matches by the name key uq_organizations_name_key refuses a second row by.
  const hits = [];
  for (const { path, src } of sources()) {
    if (path === "supabase/functions/_shared/kg-write.ts" || FAKE_DATA.has(path)) continue;
    for (const m of src.matchAll(/\.from\(\s*["'`]organizations["'`]\s*\)/g)) {
      const statement = src.slice(m.index, m.index + 400).split(";")[0];
      if (/\.(insert|upsert)\(/.test(statement)) hits.push(`${path}:${lineOf(src, m.index)}`);
    }
    for (const m of src.matchAll(/["'`]organizations(?:\?[^"'`]*)?["'`]\s*,\s*\{[^}]*method:\s*["'`](POST|PUT)/g)) hits.push(`${path}:${lineOf(src, m.index)}`);
  }
  assert.deepEqual(hits, [], "organizations written without findOrCreateOrganization");
});

// ── Static: each named write path goes through the helpers ────────────────────────────────────

const importsFromKgWrite = (src, names) => {
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/_shared\/kg-write\.ts["']/);
  const got = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  return names.filter((n) => !got.includes(n));
};

test("import-grant-publications finds papers by PMID/DOI key, gives them nodes, links versions, and names itself", () => {
  const src = fn("import-grant-publications");
  assert.deepEqual(importsFromKgWrite(src, ["findOrCreatePublication", "ensureSpineRow", "linkPublicationVersions"]), [],
    "import-grant-publications does not import the kg-write helpers it needs");
  assert.doesNotMatch(src, /\.from\(\s*["']publications["']\s*\)[^;]*\.insert\(/, "a direct publications insert bypasses findOrCreatePublication");
  assert.doesNotMatch(src, /\.ilike\(\s*["']doi["']/, "a DOI ilike lookup: compare doiKey instead");
  assert.match(src, /["']x-bbqs-client["']\s*:\s*["']import-grant-publications["']/,
    "its service-role writes must name themselves (Principle X): today they read 'unknown' in data_audit_log");
  assert.doesNotMatch(src, /["']x-bbqs-source-class["']/, "declaring a source class is a separate decision (20260831160000): it raises what the importer may overwrite");
  for (const field of ["pubs_matched", "spine_rows_created", "version_links", "already_in_kg"]) {
    assert.match(src, new RegExp(`\\b${field}\\b`), `its result does not report ${field}`);
  }
});

const toolBody = (src, name) => {
  const at = src.indexOf(`T("${name}"`);
  assert.ok(at > 0, `bbqs-mcp has no ${name} tool`);
  return src.slice(at, src.indexOf("\n  });", at));
};

test("add_resource decides by name within its resource_type, never by an ilike pattern, and PATCHes only that decision's row", () => {
  // WHY (review db_edge#1, 2026-11-17): add_resource once took a matching homepage URL for the same
  // record and PATCHed DeepLabCut with DeepLabCut-Live's description and repository. A URL is not an
  // identity for a tool (a lab's tools share its homepage); decideResource says so, and is tested below.
  const src = fn("bbqs-mcp");
  const body = toolBody(src, "add_resource");
  assert.doesNotMatch(body, /replace\(\/\[%_\*\]\/g/, "stripping '%', '_' and '*' from a name changes the name it looks up");
  assert.doesNotMatch(body, /name=ilike\./, "an ilike lookup on the name, across every resource type");
  assert.match(body, /decideResource\(/, "add_resource does not decide with decideResource (same type; the name, or same_as; a URL is only a note)");
  assert.doesNotMatch(src, /\bmatchResources\(/, "bbqs-mcp matches resources itself instead of through decideResource");
  assert.match(body, /already_in_kg/, "a match must be reported as already_in_kg");
  const patches = [...body.matchAll(/method:\s*"PATCH"/g)];
  assert.equal(patches.length, 1, "add_resource should PATCH in one place only");
  const before = body.slice(0, patches[0].index);
  assert.match(before, /if \(decision\.action === "update"\) \{\s*const row = decision\.row;[\s\S]*resources\?id=eq\.\$\{row\.id\}`, \{\s*$/,
    "the PATCH is not of decision.row inside the update branch");
  assert.match(body, /same_as:\s*\{/, "no same_as parameter: there is no explicit way to update a record that has another name");
});

test("add_funding_opportunity decides by the FON key alone, PATCHes inside a 23505 handler, and supersedes only when told", () => {
  // WHY (review db_edge#5 and kg#1, 2026-11-17): a call's notice URL can be a landing page that lists
  // several calls, so it is a hint (decideFundingCall), and a refused PATCH is said as such.
  const body = toolBody(fn("bbqs-mcp"), "add_funding_opportunity");
  assert.doesNotMatch(body, /on_conflict=fon/, "a blind upsert on the exact FON makes a second row for 'RFA NS 27 002' or for the same notice under its forecast's FON");
  assert.match(body, /decideFundingCall\(/, "add_funding_opportunity does not decide with decideFundingCall");
  assert.match(body, /\bsupersedes\b/, "no supersedes parameter: a final notice cannot take over its forecast's row");
  assert.doesNotMatch(body, /already belongs to/, "a notice URL another call holds is refused: it is a hint, never an identity");
  const writes = [...body.matchAll(/restC\(\s*(`funding_opportunities\?id=eq\.\$\{row\.id\}`|"funding_opportunities")/g)];
  assert.equal(writes.length, 2, "one PATCH and one POST expected");
  for (const w of writes) {
    const tail = body.slice(w.index, w.index + 700);
    assert.match(tail, /\} catch \(e\) \{\s*if \(!isUniqueViolation\(e\)\) throw e;/, `${w[1]}: a 23505 is not turned into a clear refusal`);
  }
});

test("update_my_profile turns an ORCID 23505 into a clear refusal and saves the other fields without the ORCID", () => {
  // WHY (review db_edge#4): member_self_update writes all fields in one UPDATE, so a typed ORCID iD
  // another record holds (uq_investigators_orcid_key) refused the whole save with a raw 409.
  const body = toolBody(fn("bbqs-mcp"), "update_my_profile");
  assert.match(body, /catch \(e\) \{\s*if \(!isUniqueViolation\(e\)\) throw e;/, "a 23505 from member_self_update is shown raw");
  assert.match(body, /rpcC\("member_self_update", \{ \.\.\.args, _orcid: null \}\)/, "the other fields are not saved without the ORCID");
  assert.match(body, /ask a curator to merge/, "the refusal does not say what to do");
  for (const tool of ["create_grant", "repoint_grant"]) {
    assert.match(toolBody(fn("bbqs-mcp"), tool), /keyedRpcC\(/, `${tool}: a 23505 from the RPC is shown raw`);
  }
});

test("seed-consortium writes nothing to a record a name alone found unless it has no email", () => {
  // WHY (review db_edge#3): the name step merged a roster person into a namesake with another email:
  // their ORCID, secondary emails and working groups, and trg_sync_member_groups then queued a Google
  // Groups sync for the namesake's address. matchPeople's rule is tested below; this holds the handler to it.
  const src = fn("seed-consortium");
  const at = src.indexOf("const match = matchPeople(");
  assert.ok(at > 0, "seed-consortium does not keep matchPeople's whole result");
  const guard = src.slice(at).search(/if \(match\.ambiguous \|\| \(nameOnly && emailKey\(match\.row!?\.email\)\)\) \{[\s\S]{0,400}?continue;/);
  assert.ok(guard > 0, "an ambiguous match, or a name-only match onto a record with an email, is not skipped");
  const update = src.slice(at).search(/\.from\("investigators"\)\.update\(/);
  assert.ok(update > guard, "seed-consortium updates a matched person before it checks the match");
});

test("grant numbers are reduced to the NIH core before they are looked up or written", () => {
  const nih = fn("nih-grants");
  assert.match(nih, /searchParams\.get\(\s*["']grant["']\s*\)[\s\S]{0,200}nihAwardCore\(/, "nih-grants: ?grant= is not reduced with nihAwardCore");
  assert.match(nih, /awardKey\(/, "nih-grants: the grant row is not resolved by awardKey");
  const mcp = fn("bbqs-mcp");
  for (const tool of ["create_grant", "repoint_grant", "refresh_grant_from_reporter"]) {
    const at = mcp.indexOf(`T("${tool}"`);
    assert.ok(at > 0, `bbqs-mcp has no ${tool} tool`);
    assert.match(mcp.slice(at, mcp.indexOf("\n  });", at)), /nihAwardCore\(|grantNumberFor\(/, `${tool} sends the grant number as typed`);
  }
  assert.match(mcp, /function grantNumberFor\([\s\S]{0,600}nihAwardCore\(/, "bbqs-mcp: grantNumberFor does not reduce with nihAwardCore");
  const add = fn("add-project-by-grant");
  assert.match(add, /nihAwardCore\(/, "add-project-by-grant: its own regex misses activity codes such as RF1, UG3 and DP2");
});

test("people and organizations are found before they are created, and each path names itself", () => {
  const want = {
    "nih-grants": ["findOrCreateInvestigator", "findOrCreateOrganization"],
    "add-project-by-grant": ["findOrCreateInvestigator", "findOrCreateOrganization"],
    "seed-consortium": ["findOrCreateInvestigator"],
    "verify-affiliations": ["findOrCreateOrganization"],
  };
  for (const [name, helpers] of Object.entries(want)) {
    const src = fn(name);
    assert.deepEqual(importsFromKgWrite(src, helpers), [], `${name} does not import ${helpers.join(", ")} from _shared/kg-write.ts`);
    for (const h of helpers) assert.match(src, new RegExp(`\\b${h}\\(`), `${name} does not call ${h}`);
    assert.match(src, /["']x-bbqs-client["']\s*:/, `${name}: its service-role writes do not name themselves (x-bbqs-client)`);
  }
  assert.doesNotMatch(fn("seed-consortium"), /email\.ilike\./, "seed-consortium: an email ilike on the primary address misses the secondary ones");
});

// ── Syntax: every touched file is TypeScript that strips to a valid ES module ──────────────────
// `node --check` is not this check: on a .ts file inside an ES module package it exits 0 without
// parsing the file (`function f( {` passes). Node's own type stripper parses it, and node --check
// on the stripped JavaScript catches what is left.

function syntaxErrors(tsSource) {
  const strip = nodeModule.stripTypeScriptTypes;
  let js;
  try { js = strip(tsSource); } catch (e) { return `${e.code ?? "error"}: ${e.message.split("\n")[0]}`; }
  const dir = mkdtempSync(join(tmpdir(), "bbqs-guard-"));
  try {
    const file = join(dir, "stripped.mjs");
    writeFileSync(file, js);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    return r.status === 0 ? null : (r.stderr.split("\n").find((l) => /Error/.test(l)) ?? r.stderr.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every file this change touches parses as erasable TypeScript", (t) => {
  if (typeof nodeModule.stripTypeScriptTypes !== "function") {
    t.skip(`node ${process.version} has no module.stripTypeScriptTypes (Node 22.13+)`);
    return;
  }
  // The check must be able to fail, or it is a green no-op.
  assert.ok(syntaxErrors("export function f( {"), "the syntax check accepted a broken file");
  assert.ok(syntaxErrors("enum E { A }"), "the syntax check accepted an enum, which Node cannot strip");
  assert.ok(syntaxErrors("const a = 1;\nconst a = 2;"), "the syntax check missed a redeclaration");
  const files = [...[...WRITE_PATHS.map((n) => `${n}/index.ts`), ...SHARED].map((f) => join(FUNCS, f)), join(ROOT, "src", "lib", "alreadyInKg.ts")];
  const bad = files.map((f) => [relative(ROOT, f), syntaxErrors(readFileSync(f, "utf8"))]).filter(([, e]) => e);
  assert.deepEqual(bad, [], "these files do not parse");
});

// ── The helpers, driven with a fake client ─────────────────────────────────────────────────────

/** A stand-in for supabase-js: tables in memory, unique keys that answer 23505 the way PostgREST
 *  does, hooks that run just before an insert (another writer, a failure), and a log of every write. */
function fakeDb(tables = {}, { unique = {}, beforeInsert = {}, rpc = {} } = {}) {
  const store = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const log = [];
  let seq = 0;
  const rowsOf = (t) => (store[t] ??= []);
  const copy = (v) => structuredClone(v);
  const violation = (t, row) => {
    for (const [name, key] of Object.entries(unique[t] ?? {})) {
      const k = key(row);
      if (k != null && rowsOf(t).some((r) => key(r) === k)) {
        return { code: "23505", message: `duplicate key value violates unique constraint "${name}"`, details: `Key (${name})=(${k}) already exists.` };
      }
    }
    return null;
  };
  const from = (t) => {
    const q = { op: "select", filters: [], one: null, payload: null, range: null };
    const run = () => {
      const pick = () => rowsOf(t).filter((r) => q.filters.every((f) => f(r)));
      if (q.op === "insert") {
        const hook = beforeInsert[t];
        const failed = hook ? hook(q.payload, store) : null;
        if (failed) return { data: null, error: failed };
        const row = { id: `${t}-${++seq}`, created_at: `2026-11-17T00:00:${String(seq).padStart(2, "0")}Z`, resource_id: null, ...copy(q.payload) };
        const err = violation(t, row);
        if (err) return { data: null, error: err };
        rowsOf(t).push(row);
        log.push(`insert ${t}`);
        return { data: copy(row), error: null };
      }
      if (q.op === "update") {
        const hit = pick();
        for (const r of hit) Object.assign(r, copy(q.payload));
        log.push(`update ${t} (${hit.length})`);
        return { data: copy(hit), error: null };
      }
      if (q.op === "delete") {
        const hit = new Set(pick());
        store[t] = rowsOf(t).filter((r) => !hit.has(r));
        log.push(`delete ${t} (${hit.size})`);
        return { data: null, error: null };
      }
      let hit = pick();
      const count = hit.length;
      if (q.range) hit = hit.slice(q.range[0], q.range[1] + 1);
      if (q.one) {
        if (hit.length > 1 || (q.one === "single" && hit.length === 0)) return { data: null, error: { code: "PGRST116", message: `${hit.length} rows` } };
        return { data: hit[0] ? copy(hit[0]) : null, error: null };
      }
      return { data: copy(hit), error: null, count };
    };
    const b = {
      select() { return b; },
      insert(p) { q.op = "insert"; q.payload = p; return b; },
      update(p) { q.op = "update"; q.payload = p; return b; },
      delete() { q.op = "delete"; return b; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return b; },
      is(c, v) { q.filters.push((r) => (r[c] ?? null) === v); return b; },
      order() { return b; },
      range(a, z) { q.range = [a, z]; return b; },
      single() { q.one = "single"; return b; },
      maybeSingle() { q.one = "maybe"; return b; },
      then(ok, ko) { return Promise.resolve().then(run).then(ok, ko); },
    };
    return b;
  };
  return {
    store, log,
    from,
    rpc: async (name, args) => {
      log.push(`rpc ${name}`);
      if (rpc[name]) return rpc[name](args);
      return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` }, status: 404 };
    },
  };
}

const kgWrite = () => import(pathToFileURL(KG_WRITE).href);
const nameUnique = { investigators: { investigators_name_key: (r) => r.name ?? null } };

test("a new person is written first, then the spine row, attached only while the person has none", async () => {
  const K = await kgWrite();
  const db = fakeDb({ investigators: [], resources: [] }, { unique: nameUnique });
  const r = await K.findOrCreateInvestigator(K.kgSession(db), { name: "Ada Lovelace", reporterProfileId: 7 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.created, true);
  assert.deepEqual(db.log, ["insert investigators", "insert resources", "update investigators (1)"]);
  const [person] = db.store.investigators;
  assert.equal(person.reporter_profile_id, 7, "the RePORTER profile id is stored with the new person");
  assert.equal(db.store.resources.length, 1);
  assert.equal(person.resource_id, db.store.resources[0].id);
  assert.equal(db.store.resources[0].resource_type, "investigator");
});

test("a spine row that cannot be attached is deleted again, never left as an orphan", async () => {
  const K = await kgWrite();
  const db = fakeDb({ investigators: [], resources: [] }, {
    unique: nameUnique,
    // Another writer attaches a node to the new person between our two inserts.
    beforeInsert: { resources: (_row, store) => { if (store.investigators[0]) store.investigators[0].resource_id = "resources-theirs"; return null; } },
  });
  const r = await K.findOrCreateInvestigator(K.kgSession(db), { name: "Ada Lovelace" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.spine.created, false);
  assert.deepEqual(db.log, ["insert investigators", "insert resources", "update investigators (0)", "delete resources (1)"]);
  assert.equal(db.store.resources.length, 0, "our spine row is gone");
  assert.equal(db.store.investigators[0].resource_id, "resources-theirs");
});

test("a person insert refused with 23505 writes no spine row", async () => {
  const K = await kgWrite();
  // The refusal comes from a key this run cannot see (the row is not readable to it): nothing to reuse.
  const db = fakeDb({ investigators: [], resources: [] }, {
    beforeInsert: { investigators: () => ({ code: "23505", message: 'duplicate key value violates unique constraint "uq_investigators_orcid_key"', details: "Key (kg_orcid_key(orcid))=(0000-0002-1825-0097) already exists." }) },
  });
  const r = await K.findOrCreateInvestigator(K.kgSession(db), { name: "Ada Lovelace", orcid: "0000-0002-1825-0097" });
  assert.equal(r.ok, false);
  assert.equal(r.already_in_kg, true);
  assert.equal(r.constraint, "uq_investigators_orcid_key");
  assert.match(r.detail, /already exists/);
  assert.deepEqual(db.log, [], "nothing was written: no person, and no spine row to orphan");
});

test("a person another writer inserted first is read again and reused", async () => {
  const K = await kgWrite();
  const db = fakeDb({ investigators: [], resources: [] }, {
    unique: nameUnique,
    beforeInsert: { investigators: (row, store) => { if (!store.investigators.length) store.investigators.push({ id: "theirs", name: row.name, resource_id: "resources-theirs" }); return null; } },
  });
  const r = await K.findOrCreateInvestigator(K.kgSession(db), { name: "Ada Lovelace" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.row.id, "theirs");
  assert.equal(r.created, false);
  assert.match(r.note, /already in the KG \(investigators_name_key\)/);
  assert.ok(!db.log.includes("insert resources"), "no spine row for a person this run did not create");
});

test("people are matched by ORCID, profile id, email, name key, then a unique first and last name", async () => {
  const K = await kgWrite();
  const rows = [
    { id: "p1", name: "Bijan Pesaran", email: "bp@example.org", orcid: "https://orcid.org/0000-0002-1825-009x" },
    { id: "p2", name: "Patrick McGrath", email: "pm@example.org" },
    { id: "p3", name: "Patrick J McGrath", email: null },
    { id: "p4", name: "Sam A Lee", email: null },
    { id: "p5", name: "Sam B Lee", email: null },
    { id: "p6", name: "Ming Zhan", email: "mz@example.org", secondary_emails: ["Ming.Zhan@Example.ORG"], reporter_profile_id: 42 },
  ];
  const m = (p) => { const r = K.matchPeople(rows, p); return [r.row?.id ?? null, r.by, r.ambiguous]; };
  assert.deepEqual(m({ name: "Someone Else", orcid: "0000-0002-1825-009X" }), ["p1", "orcid", false]);
  assert.deepEqual(m({ name: "M. Zhan", reporterProfileId: "42" }), ["p6", "reporter_profile_id", false]);
  assert.deepEqual(m({ name: "Zhan Ming", email: " ming.zhan@example.org " }), ["p6", "email", false]);
  assert.deepEqual(m({ name: "BIJAN  PESARAN" }), ["p1", "name", false]);
  assert.deepEqual(m({ name: "Patrick T McGrath" }), ["p2", "first_last", false], "unique among the matches with an email");
  assert.deepEqual(m({ name: "Sam C Lee" }), [null, "first_last", true], "two namesakes and no email to tell them apart");
  assert.deepEqual(m({ name: "Nobody Here" }), [null, null, false]);
  assert.deepEqual(K.matchPeople(rows, { name: "Bijan Pesaran", email: "mz@example.org" }, ["email", "orcid", "name"]).row.id, "p6",
    "seed-consortium's order: email first");

  const db = fakeDb({ investigators: rows, resources: [] });
  const amb = await K.findOrCreateInvestigator(K.kgSession(db), { name: "Sam C Lee" });
  assert.equal(amb.ok, false);
  assert.deepEqual(amb.ambiguous, ["p4", "p5"]);
  assert.deepEqual(db.log, [], "an ambiguous first and last name writes nothing");
});

test("publications are found by PMID key, then DOI key, and a 23505 is read again and reused", async () => {
  const K = await kgWrite();
  const pubs = [
    { id: "a", pmid: "0041331138", doi: null, title: "CaBLAM" },
    { id: "b", pmid: null, doi: "10.7554/eLife.89892", title: "eLife paper" },
  ];
  const db = fakeDb({ publications: pubs });
  const kg = K.kgSession(db);
  const byPmid = await K.findOrCreatePublication(kg, { pmid: "PMID: 41331138", doi: null, title: "CaBLAM" });
  assert.deepEqual([byPmid.ok, byPmid.row.id, byPmid.matchedBy, byPmid.created], [true, "a", "pmid", false]);
  const byDoi = await K.findOrCreatePublication(kg, { pmid: "40000001", doi: "https://doi.org/10.7554/ELIFE.89892/", title: "x" });
  assert.deepEqual([byDoi.row.id, byDoi.matchedBy], ["b", "doi"]);
  const conflict = await K.findOrCreatePublication(kg, { pmid: "41331138", doi: "10.7554/elife.89892", title: "x" });
  assert.equal(conflict.row.id, "a", "the PMID's record is reused");
  assert.match(conflict.note, /two records/);
  assert.deepEqual(db.log, [], "nothing written for papers already in the KG");
  const none = await K.findOrCreatePublication(kg, { pmid: "", doi: "not a doi", title: "keyless" });
  assert.equal(none.ok, false, "a paper with neither key cannot be recognised next time, so it is not written");

  const race = fakeDb({ publications: [] }, {
    unique: { publications: { uq_publications_pmid_key: (r) => (r.pmid ? String(r.pmid).replace(/^0+/, "") : null) } },
    beforeInsert: { publications: (row, store) => { if (!store.publications.length) store.publications.push({ id: "theirs", pmid: "042", title: row.title }); return null; } },
  });
  const raced = await K.findOrCreatePublication(K.kgSession(race), { pmid: "42", title: "t" });
  assert.deepEqual([raced.ok, raced.row?.id, raced.created], [true, "theirs", false]);
  assert.match(raced.note, /uq_publications_pmid_key/);
});

test("a publication's spine row is attached only while it has none", async () => {
  const K = await kgWrite();
  const db = fakeDb({ publications: [{ id: "a", pmid: "1", title: "T" }], resources: [] });
  const kg = K.kgSession(db);
  const [pub] = await K.loadPublications(kg);
  const s = await K.ensureSpineRow(kg, "publications", pub, { name: "T", resource_type: "publication", external_url: "https://pubmed.ncbi.nlm.nih.gov/1/" });
  assert.deepEqual([s.ok, s.created], [true, true]);
  assert.equal(db.store.publications[0].resource_id, s.resourceId);
  const again = await K.ensureSpineRow(kg, "publications", pub, { name: "T", resource_type: "publication" });
  assert.deepEqual([again.created, db.store.resources.length], [false, 1], "a second call writes nothing");
});

test("organizations are found by name key, and a 23505 is read again and reused", async () => {
  const K = await kgWrite();
  const db = fakeDb({ organizations: [{ id: "ucsd", name: "UNIVERSITY OF CALIFORNIA, SAN DIEGO", resource_id: "r1" }] });
  const kg = K.kgSession(db);
  const found = await K.findOrCreateOrganization(kg, "University of California San Diego");
  assert.deepEqual([found.ok, found.row.id, found.created], [true, "ucsd", false]);
  assert.deepEqual(db.log, []);
  const made = await K.findOrCreateOrganization(kg, "Duke University");
  assert.deepEqual([made.ok, made.created], [true, true]);
  const again = await K.findOrCreateOrganization(kg, "DUKE UNIVERSITY");
  assert.equal(again.row.id, made.row.id, "the run's cache knows the organization it just wrote");

  const race = fakeDb({ organizations: [] }, {
    unique: { organizations: { uq_organizations_name_key: (r) => String(r.name).toLowerCase().replace(/[^a-z0-9]/g, "") } },
    beforeInsert: { organizations: (_row, store) => { if (!store.organizations.length) store.organizations.push({ id: "theirs", name: "Duke University" }); return null; } },
  });
  const raced = await K.findOrCreateOrganization(K.kgSession(race), "DUKE UNIVERSITY");
  assert.deepEqual([raced.ok, raced.row?.id, raced.created], [true, "theirs", false]);
});

test("version links are reported as unavailable, not thrown, before 20261117181500 is applied", async () => {
  const K = await kgWrite();
  const missing = await K.linkPublicationVersions(fakeDb(), ["a", "b"]);
  assert.deepEqual([missing.available, missing.note], [false, "unavailable: 20261117181500 not applied"]);
  const undefinedFn = await K.linkPublicationVersions(fakeDb({}, {
    rpc: { kg_link_publication_versions: () => ({ data: null, error: { code: "42883", message: "function does not exist" }, status: 404 }) },
  }), ["a"]);
  assert.equal(undefinedFn.available, false);
  let args = null;
  const applied = await K.linkPublicationVersions(fakeDb({}, {
    rpc: { kg_link_publication_versions: (a) => { args = a; return { data: [
      { subject_id: "n", object_id: "v", outcome: "done", detail: "PMID 1 revision_of preprint PMID 2" },
      { subject_id: "n2", object_id: "v2", outcome: "noop", detail: "already linked" },
    ], error: null, status: 200 }; } },
  }), ["a", "a", "b"]);
  assert.deepEqual(args, { _publication_ids: ["a", "b"], _basis: "algorithmic" });
  assert.deepEqual([applied.available, applied.done, applied.noop, applied.details.length], [true, 1, 1, 1]);
});

test("23505 errors are recognised from supabase-js and from a PostgREST body inside an Error", async () => {
  const K = await kgWrite();
  const body = new Error('409 {"code":"23505","details":"Key (kg_fon_key(fon))=(RFANS27002) already exists.","hint":null,"message":"duplicate key value violates unique constraint \\"uq_funding_opportunities_fon_key\\""}');
  assert.equal(K.isUniqueViolation(body), true);
  assert.equal(K.violatedConstraint(body), "uq_funding_opportunities_fon_key");
  assert.equal(K.violationDetail(body), "Key (kg_fon_key(fon))=(RFANS27002) already exists.");
  assert.equal(K.isUniqueViolation({ code: "23503", message: "foreign key" }), false);
  assert.equal(K.isMissingFunction({ code: "PGRST202" }), true);
});

test("the matchers fold URLs, FONs and resource names with the identity keys", async () => {
  const K = await kgWrite();
  const calls = [{ id: "c1", fon: "RFA-NS-27-002", url: "https://grants.nih.gov/grants/guide/rfa-files/RFA-NS-27-002.html" }];
  assert.deepEqual(K.matchFundingCalls(calls, { fon: "rfa ns 27 002" }).byFon.map((r) => r.id), ["c1"]);
  assert.deepEqual(K.matchFundingCalls(calls, { fon: "RFA-NS-26-011", url: "http://www.grants.nih.gov/grants/guide/rfa-files/rfa-ns-27-002.html/" }).byUrl.map((r) => r.id), ["c1"]);
  const res = [
    { id: "s1", name: "Lightning Pose", resource_type: "software", external_url: "https://lightning-pose.readthedocs.io", repoUrl: "https://github.com/paninski-lab/lightning-pose" },
    { id: "d1", name: "Lightning Pose", resource_type: "dataset", external_url: null },
  ];
  const hits = (q) => K.matchResources(res, q).map((h) => `${h.row.id}:${h.by.join("+")}:${h.same ? "same" : "hint"}`);
  assert.deepEqual(hits({ type: "software", name: "lightning-pose" }), ["s1:name:same"]);
  assert.deepEqual(hits({ type: "software", name: "LP", repoUrl: "github.com/paninski-lab/lightning-pose/" }), ["s1:repo_url:hint"],
    "a repository URL alone is a hint, not the same record");
  assert.deepEqual(hits({ type: "software", repoUrl: "https://github.com/paninski-lab/lightning-pose" }), ["s1:repo_url:same"],
    "with no name to compare, the URL is all there is");
  assert.deepEqual(hits({ type: "ml_model", name: "Lightning Pose" }), [], "never across resource types");
});

// ── Identity, not resemblance: a URL or a name alone never makes two records one (review 2026-11-17) ──

test("add_resource's rule: a different-named resource that shares only a homepage or repository URL is never updated", async () => {
  const K = await kgWrite();
  const dlc = { id: "dlc", name: "DeepLabCut", resource_type: "software", external_url: "https://www.mackenziemathislab.org/deeplabcut",
    metadata: { repoUrl: "https://github.com/DeepLabCut/DeepLabCut" } };
  const live = { id: "live", name: "DeepLabCut-Live", resource_type: "software", external_url: "https://www.mackenziemathislab.org/deeplabcut", metadata: {} };
  const ds = { id: "ds", name: "DeepLabCut", resource_type: "dataset", external_url: null };
  const d = (rows, q) => K.decideResource(rows, { type: "software", ...q });

  const homepage = d([dlc], { name: "DeepLabCut-Live", url: "https://www.mackenziemathislab.org/deeplabcut/" });
  assert.equal(homepage.action, "insert", "the homepage DeepLabCut-Live shares with DeepLabCut does not make it DeepLabCut");
  assert.match(homepage.note, /The software "DeepLabCut" \(id dlc\) has the same homepage URL\. It was not changed/);
  assert.match(homepage.note, /same_as="dlc"/);
  const repo = d([dlc], { name: "DLC tools", repoUrl: "github.com/DeepLabCut/DeepLabCut/" });
  assert.deepEqual([repo.action, /same repository URL/.test(repo.note)], ["insert", true]);

  const byName = d([dlc, live, ds], { name: "deep-lab-cut", url: "https://www.mackenziemathislab.org/deeplabcut" });
  assert.deepEqual([byName.action, byName.row?.id, byName.matchedBy], ["update", "dlc", "name+url"]);
  assert.match(byName.note, /"DeepLabCut-Live" \(id live\) has the same homepage URL\. It was not changed/, "the URL twin is named, not refused");
  const twice = d([dlc, { ...dlc, id: "dlc2", name: "deeplabcut" }], { name: "DeepLabCut" });
  assert.equal(twice.action, "refuse");
  assert.match(twice.error, /2 software records match "DeepLabCut".*Merge them first; nothing was written/);

  const alias = d([dlc, live], { name: "DLC", sameAs: "dlc" });
  assert.deepEqual([alias.action, alias.row?.id, alias.matchedBy], ["update", "dlc", "same_as"], "same_as is the explicit way");
  assert.deepEqual([d([dlc], { name: "DLC", sameAs: "DeepLabCut" }).row?.id], ["dlc"], "same_as may name the record");
  assert.match(d([dlc], { name: "DLC", sameAs: "nope" }).error, /same_as="nope" names no software in the KG/);
  assert.match(d([dlc, ds], { name: "DLC", sameAs: "ds" }).error, /is the dataset "DeepLabCut" \(id ds\), not a software/);
  assert.match(d([dlc, live], { name: "DeepLabCut-Live", sameAs: "dlc" }).error, /already in the KG as "DeepLabCut-Live" \(id live\), not "DeepLabCut" \(id dlc\)/,
    "same_as cannot override the record that has this name");

  const cjk = { id: "cjk", name: "深度标注", resource_type: "software", external_url: "https://lab.example/tools" };
  assert.deepEqual([d([cjk], { name: "深度标注", url: "https://lab.example/tools" }).action, d([cjk], { name: "别的工具", url: "https://lab.example/tools" }).action],
    ["update", "insert"], "a name with no name key is compared exactly");
  assert.match(d([ds], { name: "DeepLabCut" }).note, /Also in the KG under another type: dataset "DeepLabCut" \(id ds\)/);
});

test("add_funding_opportunity's rule: the FON is the call; a shared notice URL is a hint, never a refusal", async () => {
  const K = await kgWrite();
  const page = "https://grants.nih.gov/funding/find-a-fit-for-your-research/highlighted-topics/18";
  const rows = [
    { id: "f1", fon: "RFA-NS-28-001", url: null, notes: null },
    { id: "f0", fon: "RFA-NS-27-002", url: "https://simpler.grants.gov/opportunity/ffe98704", notes: null },
    { id: "n1", fon: "NOT-MH-25-155", url: page, notes: null },
  ];
  const byFon = K.decideFundingCall(rows, { fon: "rfa ns 28 001", url: "simpler.grants.gov/opportunity/ffe98704/" });
  assert.deepEqual([byFon.action, byFon.row?.id, byFon.matchedBy], ["update", "f1", "fon"]);
  assert.match(byFon.notes.join(" "), /Its notice URL is also on RFA-NS-27-002 \(id f0\)\. A URL can be a landing page/);
  const landing = K.decideFundingCall(rows, { fon: "NOT-MH-25-156", url: page });
  assert.equal(landing.action, "insert", "a second call on one landing page is added, not refused");
  assert.match(landing.notes.join(" "), /also on NOT-MH-25-155 \(id n1\)/);
  const sup = K.decideFundingCall(rows, { fon: "RFA-NS-29-001", url: "https://simpler.grants.gov/opportunity/ffe98704", supersedes: "RFA-NS-27-002" });
  assert.deepEqual([sup.action, sup.row?.id, sup.matchedBy], ["update", "f0", "supersedes"]);
  assert.match(sup.notes[0], /RFA-NS-27-002 is now RFA-NS-29-001/);
  const both = K.decideFundingCall(rows, { fon: "RFA-NS-28-001", supersedes: "RFA-NS-27-002" });
  assert.deepEqual([both.row?.id, /RFA-NS-27-002 \(id f0\) is still a separate row/.test(both.notes.join(" "))], ["f1", true]);
  const twice = K.decideFundingCall([...rows, { id: "f2", fon: "RFA NS 28 001", url: null }], { fon: "RFA-NS-28-001" });
  assert.match(twice.error, /RFA-NS-28-001 \(id f1\), RFA NS 28 001 \(id f2\) are one call recorded 2 times/);
  const none = K.decideFundingCall(rows, { fon: "PAR-26-001", supersedes: "PAR-25-999" });
  assert.deepEqual([none.action, none.notes], ["insert", ["No call with FON PAR-25-999 is in the KG, so nothing was superseded"]]);
});

test("people: a name that fits a record with another email, or several records, is ambiguous and writes nothing", async () => {
  const K = await kgWrite();
  const rows = [
    { id: "ns", name: "CHUCK  MIKELL", email: "someone.else@elsewhere.example" },
    { id: "a", name: "Li Na", email: "lina@a.example" },
    { id: "b", name: "Lina", email: "lina@b.example" },
    { id: "tw", name: "BIJAN  PESARAN", email: null },
  ];
  const seed = (p) => K.matchPeople(rows, p, ["email", "orcid", "name"]);
  const ns = seed({ name: "Chuck Mikell", email: "charles.mikell@stonybrookmedicine.edu" });
  assert.deepEqual([ns.row, ns.by, ns.ambiguous], [null, "name", true], "a namesake with another email is not this person");
  assert.match(ns.reason, /matched only by name to "CHUCK {2}MIKELL" \(id ns\), whose email is not this person's/);
  assert.doesNotMatch(ns.reason, /someone\.else/, "the reason does not repeat another person's address");
  const tw = seed({ name: "Bijan Pesaran", email: "bp@example.org" });
  assert.deepEqual([tw.row?.id, tw.ambiguous], ["tw", false], "a twin with no email is still reused (the RePORTER-twin case)");
  const two = K.matchPeople(rows, { name: "LI NA" });
  assert.deepEqual([two.row, two.by, two.ambiguous], [null, "name", true], "two records with the name key are two candidates, not one");
  assert.match(two.reason, /2 records match by name/);
  assert.deepEqual(K.matchPeople(rows, { name: "LI NA", email: "lina@b.example" }).row.id, "b", "an email still decides it");

  const db = fakeDb({ investigators: rows, resources: [] });
  const made = await K.findOrCreateInvestigator(K.kgSession(db), { name: "Chuck Mikell", email: "charles.mikell@stonybrookmedicine.edu" });
  assert.deepEqual([made.ok, made.ambiguous], [false, ["ns"]]);
  assert.deepEqual(db.log, [], "no second Chuck Mikell, and nothing written to the namesake");
});

// ── src: the pages that write an identity key say a refusal as what it is ─────────────────────────

const ALREADY_IN_KG = join(ROOT, "src", "lib", "alreadyInKg.ts");
const srcFile = (p) => read(`src/${p}`);
const srcFiles = (dir = join(ROOT, "src")) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? srcFiles(p) : /\.tsx?$/.test(p) ? [p] : [];
});

test("a unique violation is said as the key it is; every other error is left alone", async () => {
  const L = await import(pathToFileURL(ALREADY_IN_KG).href);
  const pg = (constraint, key) => ({ code: "23505", message: `duplicate key value violates unique constraint "${constraint}"`, details: `Key (expr(col))=(${key}) already exists.`, hint: null });
  assert.deepEqual(L.uniqueViolation(pg("uq_investigators_orcid_key", "0000-0003-9999-0001")), { constraint: "uq_investigators_orcid_key", key: "0000-0003-9999-0001" });
  assert.equal(L.uniqueViolation({ code: "42501", message: "only curators can change email" }), null);
  assert.equal(L.alreadyInKgMessage(new Error("Failed to fetch")), null, "not a duplicate: the caller shows it as it is");
  const inBody = new Error('409 {"code":"23505","details":"Key (kg_fon_key(fon))=(RFADA26001) already exists.","message":"duplicate key value violates unique constraint \\"uq_funding_opportunities_fon_key\\""}');
  assert.match(L.alreadyInKgMessage(inBody, { fon: "RFA-DA-26-001" }), /^The funding opportunity RFA-DA-26-001 is already in the KG/);
  assert.match(L.alreadyInKgMessage(pg("uq_investigators_orcid_key", "0000-0003-9999-0001")), /ORCID iD 0000-0003-9999-0001 is already on another person's record.*ask a curator to merge/);
  assert.match(L.alreadyInKgMessage(pg("uq_publications_doi_key", "10.1038/abc"), { doi: "https://doi.org/10.1038/ABC" }), /DOI https:\/\/doi\.org\/10\.1038\/ABC is already in the KG/);
  assert.match(L.alreadyInKgMessage(pg("uq_projects_award_key", "R34DA059506"), { award: "R34DA059506" }), /award R34DA059506 is already in the KG under another spelling/);
  assert.match(L.alreadyInKgMessage(pg("uq_publications_resource_id", "x")), /node in the KG belongs to another record/, "resource_id is not read as a DOI or PMID");
  assert.match(L.alreadyInKgMessage(pg("some_new_key", "x")), /already in the KG \(some_new_key\)/);
});

test("the member's own profile saves without an ORCID iD another record holds, and says so", async () => {
  const L = await import(pathToFileURL(ALREADY_IN_KG).href);
  const args = { _institution: "New Institute", _orcid: "0000-0003-9999-0001", _research_areas: ["Motor control"], _skills: [], _secondary_emails: [], _requested_working_groups: [] };
  const calls = [];
  const held = { code: "23505", message: 'duplicate key value violates unique constraint "uq_investigators_orcid_key"', details: "Key (kg_orcid_key(orcid))=(0000-0003-9999-0001) already exists." };
  const r = await L.saveOwnProfile(async (a) => { calls.push(a); return a._orcid ? { data: null, error: held } : { data: { ok: true }, error: null }; }, args);
  assert.deepEqual(calls.map((a) => a._orcid), ["0000-0003-9999-0001", null], "saved again with the stored ORCID kept (a null _orcid)");
  assert.deepEqual(calls[1], { ...args, _orcid: null }, "every other field is sent unchanged");
  assert.deepEqual([r.error, r.data], [null, { ok: true }]);
  assert.match(r.orcidNotSaved, /already on another person's record.*ask a curator to merge/);

  for (const other of [
    { code: "42501", message: "x@y belongs to another member; ask a curator to merge the records" },
    { code: "23505", message: 'duplicate key value violates unique constraint "uq_investigators_resource_id"', details: "Key (resource_id)=(r1) already exists." },
  ]) {
    const seen = [];
    const r2 = await L.saveOwnProfile(async (a) => { seen.push(a); return { data: null, error: other }; }, args);
    assert.deepEqual([seen.length, r2.error, r2.orcidNotSaved], [1, other, null], `${other.code} ${other.message}: returned as it came, and nothing is retried`);
  }
});

test("every src page that writes an identity key turns a 23505 into alreadyInKg's message", () => {
  // WHY (review db_edge#4): after 20261117181500 these writes are refused by a uq_* index, and showed the
  // raw Postgres text, or (InvestigatorSummary) no reason at all.
  const writers = {
    "components/profile/MemberProfileEditor.tsx": /saveOwnProfile\(/,                         // investigators.orcid (member_self_update)
    "components/entity-summary/summaries/InvestigatorSummary.tsx": /alreadyInKgMessage\(err/,   // investigators.orcid, inline edit
    "pages/Publications.tsx": /alreadyInKgMessage\(err, \{ doi:/,                               // publications.doi
    "components/funding/AddFundingOpportunityDialog.tsx": /alreadyInKgMessage\(error, \{ fon/,  // funding_opportunities.fon
    "components/project-profile/useProjectProfileEditor.ts": /alreadyInKgMessage\(e, \{ award:/, // projects.grant_number (upsert)
  };
  for (const [p, use] of Object.entries(writers)) {
    const s = srcFile(p);
    assert.match(s, /from "@\/lib\/alreadyInKg"/, `${p} does not import @/lib/alreadyInKg`);
    assert.match(s, use, `${p} does not say a 23505 as what it is`);
  }
  // Any other src insert or upsert into a table with an identity index must be added to the list above.
  const keyed = /\.from\(\s*["'](publications|funding_opportunities|grants|projects|organizations)["'](?:\s+as\s+any)?\s*\)/g;
  const unhandled = [];
  for (const p of srcFiles()) {
    const rel = relative(join(ROOT, "src"), p).replace(/\\/g, "/");
    if (rel.startsWith("integrations/")) continue;
    const s = readFileSync(p, "utf8");
    for (const m of s.matchAll(keyed)) {
      const statement = s.slice(m.index, m.index + 300).split(";")[0];
      if (/\.(insert|upsert)\(/.test(statement) && !(rel in writers)) unhandled.push(`src/${rel}:${lineOf(s, m.index)}`);
    }
  }
  assert.deepEqual([...new Set(unhandled)], [], "src inserts or upserts into an identity-keyed table that show a 23505 raw");
  const selfUpdates = srcFiles()
    .filter((p) => { const s = readFileSync(p, "utf8"); return /rpc\(\s*["']member_self_update["']/.test(s) && !/saveOwnProfile\(/.test(s); })
    .map((p) => relative(ROOT, p));
  assert.deepEqual(selfUpdates, [], "member_self_update called without saveOwnProfile: a held ORCID iD refuses the whole save");
});
