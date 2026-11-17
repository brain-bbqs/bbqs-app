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

test("add_resource matches within its resource_type by name or URL key, never by an ilike pattern", () => {
  const src = fn("bbqs-mcp");
  const at = src.indexOf('T("add_resource"');
  assert.ok(at > 0, "bbqs-mcp has no add_resource tool");
  const body = src.slice(at, src.indexOf("\n  });", at));
  assert.doesNotMatch(body, /replace\(\/\[%_\*\]\/g/, "stripping '%', '_' and '*' from a name changes the name it looks up");
  assert.doesNotMatch(body, /name=ilike\./, "an ilike lookup on the name, across every resource type");
  assert.match(body, /matchResources\(/, "add_resource does not match with matchResources (same type; name, URL or repo URL key)");
  assert.match(body, /already_in_kg/, "a match must be reported as already_in_kg");
});

test("add_funding_opportunity matches the FON key, then the notice URL, and supersedes only when told", () => {
  const src = fn("bbqs-mcp");
  const at = src.indexOf('T("add_funding_opportunity"');
  assert.ok(at > 0, "bbqs-mcp has no add_funding_opportunity tool");
  const body = src.slice(at, src.indexOf("\n  });", at));
  assert.doesNotMatch(body, /on_conflict=fon/, "a blind upsert on the exact FON makes a second row for 'RFA NS 27 002' or for the same notice under its forecast's FON");
  assert.match(body, /matchFundingCalls\(/, "add_funding_opportunity does not match with matchFundingCalls");
  assert.match(body, /\bsupersedes\b/, "no supersedes parameter: a final notice cannot take over its forecast's row");
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
  const files = [...WRITE_PATHS.map((n) => `${n}/index.ts`), ...SHARED];
  const bad = files.map((f) => [f, syntaxErrors(readFileSync(join(FUNCS, f), "utf8"))]).filter(([, e]) => e);
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
  const hits = (q) => K.matchResources(res, q).map((h) => `${h.row.id}:${h.by.join("+")}`);
  assert.deepEqual(hits({ type: "software", name: "lightning-pose" }), ["s1:name"]);
  assert.deepEqual(hits({ type: "software", name: "LP", repoUrl: "github.com/paninski-lab/lightning-pose/" }), ["s1:repo_url"]);
  assert.deepEqual(hits({ type: "ml_model", name: "Lightning Pose" }), [], "never across resource types");
});
