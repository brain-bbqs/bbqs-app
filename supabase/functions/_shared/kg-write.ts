// Write paths that look before they write: "if you have something in the KG already, you don't want
// to duplicate it" (Tek's review, 2026-11). Every helper here finds an existing record by the same
// identity key the database's uq_* indexes enforce (./identity-keys.ts, kg/identity_keys.json), reuses
// it, and writes only when nothing matches. A 23505 means someone else wrote the record in between:
// the helper reads the table again and reuses that row, so a race never leaves a second record.
//
// Each helper reads its small table once per run (organizations, investigators, publications), into
// the run's KgSession, and folds the keys here rather than with ilike: an ilike pattern treats the
// name's own '%' and '_' as wildcards, and a fold in two languages drifts.
//
// People are written person first, then their node (the spine row in resources), attached only if
// the person still has none. The 10 orphan investigator spine rows of the 11-04 export came from the
// other order: three functions inserted the spine row, then the person insert failed.
//
// Imports only ./identity-keys.ts and uses no Deno globals, so the Node guards can load it
// (tests/guards/write-paths-get-or-create.test.mjs drives these helpers with a fake client).
import { doiKey, nameKey, orcidKey, pmidKey, urlKey, fonKey } from "./identity-keys.ts";

/** The part of a supabase-js client these helpers use. */
export type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

type Text = string | null | undefined;

export interface OrgRow { id: string; name: string | null; resource_id?: string | null; created_at?: string | null }
export interface PersonRow {
  id: string; name: string | null; email?: string | null; secondary_emails?: string[] | null; orcid?: string | null;
  reporter_profile_id?: number | string | null; resource_id?: string | null; created_at?: string | null;
}
export interface PubRow {
  id: string; pmid?: string | null; doi?: string | null; title?: string | null; journal?: string | null;
  resource_id?: string | null; created_at?: string | null;
}
export interface ResourceRow {
  id: string; name: string | null; resource_type: string; external_url?: string | null;
  metadata?: { repoUrl?: unknown } | null; repoUrl?: unknown;
}
export interface CallRow { id: string; fon: string | null; url?: string | null; notes?: string | null }

export interface SpineResult { ok: boolean; resourceId: string | null; created: boolean; error?: string }

/** What a find-or-create helper did. On failure nothing was written, or only what `error` names. */
export type Found<T> =
  | { ok: true; row: T; created: boolean; matchedBy: string | null; candidates?: number; note?: string; spine?: SpineResult }
  | { ok: false; error: string; already_in_kg?: boolean; constraint?: string | null; detail?: string | null; ambiguous?: string[] };

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

const errText = (e: unknown): string => {
  if (e == null) return "";
  if (typeof e === "string") return e;
  const o = e as { message?: unknown; details?: unknown; hint?: unknown };
  return [o.message, o.details, o.hint].filter((x) => typeof x === "string" && x).join(" ") || String(e);
};
const message = (e: unknown) => errText(e) || "unknown error";

/** A unique violation (23505): a supabase-js error, or an Error carrying a PostgREST error body. */
export function isUniqueViolation(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === "object" && (e as { code?: unknown }).code === "23505") return true;
  const t = errText(e);
  return /"code"\s*:\s*"23505"/.test(t) || /duplicate key value violates unique constraint/i.test(t);
}

/** The constraint or index a unique violation names ('unique constraint "uq_..."'), else null. */
export function violatedConstraint(e: unknown): string | null {
  const m = errText(e).match(/unique constraint \\?"([^"\\]+)\\?"/);
  return m ? m[1] : null;
}

/** The violation's detail ('Key (...)=(...) already exists.'), else null. */
export function violationDetail(e: unknown): string | null {
  if (e && typeof e === "object" && typeof (e as { details?: unknown }).details === "string") return (e as { details: string }).details;
  const m = errText(e).match(/Key \(.*?\)=\(.*?\) already exists\.?/);
  return m ? m[0].replace(/\\"/g, '"') : null;
}

/** An RPC that is not there yet: PostgREST's PGRST202, Postgres's 42883, or a 404. */
export function isMissingFunction(e: unknown, status?: number): boolean {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return code === "PGRST202" || code === "42883" || status === 404 || /PGRST202|Could not find the function/i.test(errText(e));
}

/** What a unique violation refused, for a message: '<constraint>: Key (...)=(...) already exists.' */
export function uniqueViolationText(e: unknown): string {
  const constraint = violatedConstraint(e);
  const detail = violationDetail(e);
  return `${constraint ?? "a unique key"}${detail ? `: ${detail}` : ""}`;
}

/** A unique violation of the ORCID key (uq_investigators_orcid_key): the one identity key a member's
 *  own profile carries. */
export function isOrcidViolation(e: unknown): boolean {
  return isUniqueViolation(e) && /orcid/i.test(uniqueViolationText(e));
}

/** What the member's own profile save did when its ORCID iD was left out. */
export interface ProfileSave { result: unknown; saved: string[]; orcidNotSaved: string | null }

/** member_self_update for update_my_profile. The RPC writes every field in one UPDATE, so an ORCID iD
 *  another record holds (uq_investigators_orcid_key) refuses them all. Then, and only then (an ORCID
 *  23505, an ORCID sent, another field asked), it is called again with a null _orcid, which keeps the
 *  stored ORCID, and the other fields are saved; `orcidNotSaved` says why the ORCID iD was not. If
 *  that second call fails too, its error is thrown with the ORCID notice in front, so the member is
 *  always told the ORCID iD was left out. Any other unique violation is said as such and nothing is
 *  retried; any other error is thrown as it came. `call` throws on an error, as bbqs-mcp's rpc does.
 *  (src/lib/alreadyInKg.ts saveOwnProfile is the profile editor's copy of this rule.) */
export async function saveProfileLeavingOutHeldOrcid(
  call: (args: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>, asked: string[],
): Promise<ProfileSave> {
  try {
    return { result: await call(args), saved: asked, orcidNotSaved: null };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    if (!isOrcidViolation(e) || args._orcid == null) {
      throw new Error(`Nothing was saved: the database refused it as a duplicate of another record (${uniqueViolationText(e)}). Ask a curator.`);
    }
    const notice = `The ORCID iD ${String(args._orcid)} is already on another person's record in the KG (${violatedConstraint(e) ?? "its ORCID key"}), ` +
      "so it was not saved: one ORCID iD is one person. If that record is you, ask a curator to merge the two records.";
    if (!asked.length) throw new Error(`${notice} Nothing else was asked, so nothing was saved.`);
    try {
      return { result: await call({ ...args, _orcid: null }), saved: asked, orcidNotSaved: notice };
    } catch (e2) {
      throw new Error(`${notice} The other fields (${asked.join(", ")}) were not saved either: ${message(e2)}`);
    }
  }
}

function alreadyInKg(e: unknown, what: string): Found<never> {
  return {
    ok: false, already_in_kg: true, constraint: violatedConstraint(e), detail: violationDetail(e),
    error: `${what} is already in the KG (${uniqueViolationText(e)}), but it could not be read back; nothing was written`,
  };
}

// ── The run's reads ─────────────────────────────────────────────────────────────────────────────

/** One run's view of the small tables: each is read once, on first use, and kept current as rows are written. */
export interface KgSession { db: Db; cache: Map<string, unknown[]> }
export const kgSession = (db: Db): KgSession => ({ db, cache: new Map() });

const PAGE = 1000;
const ORG_COLUMNS = "id, name, resource_id, created_at";
const PERSON_COLUMNS = "id, name, email, secondary_emails, orcid, reporter_profile_id, resource_id, created_at";
const PUB_COLUMNS = "id, pmid, doi, title, journal, resource_id, created_at";

/** Every row of a table, in pages (PostgREST caps a response at its max_rows), cached for the run. */
async function readAll<T>(kg: KgSession, table: string, columns: string, refresh = false): Promise<T[]> {
  if (!refresh && kg.cache.has(table)) return kg.cache.get(table) as T[];
  const out: T[] = [];
  for (let from = 0, pages = 0; pages < 100; pages++) {
    const { data, error, count } = await kg.db.from(table).select(columns, { count: "exact" })
      .order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read ${table}: ${message(error)}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    from += page.length;
    if (page.length === 0 || (typeof count === "number" ? out.length >= count : page.length < PAGE)) break;
  }
  kg.cache.set(table, out);
  return out;
}

export const loadOrganizations = (kg: KgSession, refresh = false) => readAll<OrgRow>(kg, "organizations", ORG_COLUMNS, refresh);
export const loadPeople = (kg: KgSession, refresh = false) => readAll<PersonRow>(kg, "investigators", PERSON_COLUMNS, refresh);
export const loadPublications = (kg: KgSession, refresh = false) => readAll<PubRow>(kg, "publications", PUB_COLUMNS, refresh);

// ── Pure matchers (no I/O) ──────────────────────────────────────────────────────────────────────

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const asciiTrim = (s: string) => s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

/** An email as the write paths compare it: ASCII whitespace trimmed, ASCII letters lower-cased.
 *  Close to investigators_email_unique_ci, which is lower(btrim(email)), but not the same rule:
 *  btrim strips spaces only, where this also strips tabs and newlines, and lower() also folds
 *  non-ASCII capitals under a UTF-8 locale, which this leaves alone. So an address with a tab
 *  around it is one person here and two to the index: the row is reused, never inserted.
 *  'JOSÉ@x.org' next to 'josé@x.org' is two here and one to the index: the insert is refused
 *  with 23505 and reported as already in the KG, never written twice. */
export const emailKey = (v: Text): string | null => (v == null ? null : asciiLower(asciiTrim(String(v))) || null);

const profileKey = (v: unknown): string | null => (v == null ? null : asciiTrim(String(v)) || null);

/** First and last name, each folded like a name ('Patrick T. McGrath' -> 'patrick mcgrath'); null for one word. */
export function firstLastKey(name: Text): string | null {
  if (name == null) return null;
  const parts = String(name).split(/[ \t\n\v\f\r]+/).map((t) => nameKey(t)).filter((t): t is string => !!t);
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : null;
}

const byAge = (a: { created_at?: string | null; id: string }, b: { created_at?: string | null; id: string }) =>
  String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.id.localeCompare(b.id);

/** Of several records with one key (a duplicate group), the one to reuse: a KG node first, then the oldest. */
function pickNode<T extends { id: string; resource_id?: string | null; created_at?: string | null }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => Number(!a.resource_id) - Number(!b.resource_id) || byAge(a, b))[0] ?? null;
}

/** Of several people with one key: the curated record (it has an email), then a node, then the oldest. */
function pickPerson(rows: PersonRow[]): PersonRow | null {
  return [...rows].sort((a, b) =>
    Number(!emailKey(a.email)) - Number(!emailKey(b.email)) || Number(!a.resource_id) - Number(!b.resource_id) || byAge(a, b))[0] ?? null;
}

export function matchOrganizations(rows: OrgRow[], name: Text): { row: OrgRow | null; candidates: OrgRow[] } {
  const k = nameKey(name);
  const candidates = k ? rows.filter((r) => nameKey(r.name) === k) : [];
  return { row: pickNode(candidates), candidates };
}

export type PersonKey = "orcid" | "reporter_profile_id" | "email" | "name" | "first_last";
/** The order people are matched in: identifiers first, then the name, then first + last name. */
export const PERSON_KEYS: PersonKey[] = ["orcid", "reporter_profile_id", "email", "name", "first_last"];

export interface PersonQuery {
  name?: Text; email?: Text; secondaryEmails?: Text[] | null; orcid?: Text; reporterProfileId?: number | string | null;
}
export interface PersonMatch {
  row: PersonRow | null; by: PersonKey | null; candidates: PersonRow[]; ambiguous: boolean;
  /** When `ambiguous`: why no record was taken, for the curator who has to decide. */
  reason: string | null;
}

/** The keys that only guess from a name. The others identify a person. */
const NAME_GUESSES: ReadonlySet<PersonKey> = new Set(["name", "first_last"]);
/** Both sides state the identifier, and state it differently. */
const differs = (a: string | null, b: string | null) => !!a && !!b && a !== b;
const personLabel = (rows: PersonRow[]) => rows.map((r) => `"${r.name}" (id ${r.id})`).join("; ");

function peopleBy(key: PersonKey, rows: PersonRow[], p: PersonQuery): PersonRow[] {
  switch (key) {
    case "orcid": {
      const k = orcidKey(p.orcid);
      return k ? rows.filter((r) => orcidKey(r.orcid) === k) : [];
    }
    case "reporter_profile_id": {
      const k = profileKey(p.reporterProfileId);
      return k ? rows.filter((r) => profileKey(r.reporter_profile_id) === k) : [];
    }
    case "email": {
      const want = new Set([p.email, ...(p.secondaryEmails ?? [])].map(emailKey).filter((e): e is string => !!e));
      if (!want.size) return [];
      return rows.filter((r) => [r.email, ...(r.secondary_emails ?? [])].some((e) => want.has(emailKey(e) ?? "")));
    }
    case "name": {
      const k = nameKey(p.name);
      return k ? rows.filter((r) => nameKey(r.name) === k) : [];
    }
    case "first_last": {
      const k = firstLastKey(p.name);
      return k ? rows.filter((r) => firstLastKey(r.name) === k) : [];
    }
  }
}

/** The person a record describes, by the first key in `order` that finds anyone. ORCID, RePORTER
 *  profile id and email are identities: several records with one of them are one person recorded
 *  twice, and the curated one is reused.
 *
 *  The name and first + last name are guesses, because namesakes exist (design D3), so a guess is
 *  `ambiguous` (nothing should be written, and `reason` says why) when:
 *  - the query and a record the name finds both carry an ORCID iD, or both a RePORTER profile id, and
 *    the two differ: they are two people of one name. A roster link decides pi@ (#283), so a
 *    namesake's grant must never land on the other person. (Found in review of #520, 2026-11-19.)
 *  - the query carries an email and a record the name finds carries another one: that record is
 *    somebody else, or a twin only a curator can tell apart. (A record with this person's email was
 *    found by the email step already; a record with no email, a RePORTER twin, is still reused.)
 *  - the name key finds records that carry two or more different emails: two people ("Li Na" and
 *    "Lina"), or a twin only a curator can tell apart. Records with one email between them, or none,
 *    are one person recorded twice, and the curated one is reused (pickPerson: the one with the
 *    email, then a node, then the oldest). That is the documented twin pair (20260811120000): a
 *    curated record and its email-less RePORTER copy whose name differs in case or spacing only;
 *  - first + last name finds several and not exactly one of them carries an email (nih-grants' rule). */
export function matchPeople(rows: PersonRow[], p: PersonQuery, order: PersonKey[] = PERSON_KEYS): PersonMatch {
  const asked = [p.email, ...(p.secondaryEmails ?? [])].map(emailKey).filter((e): e is string => !!e);
  for (const key of order) {
    const hits = peopleBy(key, rows, p);
    if (!hits.length) continue;
    if (!NAME_GUESSES.has(key)) return { row: pickPerson(hits), by: key, candidates: hits, ambiguous: false, reason: null };
    const how = key === "name" ? "name" : "first and last name";
    // An identifier both carry, and carry differently, says they are two people, whatever the name says.
    const anotherOrcid = hits.filter((r) => differs(orcidKey(p.orcid), orcidKey(r.orcid)));
    const anotherProfile = hits.filter((r) => differs(profileKey(p.reporterProfileId), profileKey(r.reporter_profile_id)));
    if (anotherOrcid.length || anotherProfile.length) {
      const which = [anotherOrcid.length ? "ORCID iD" : "", anotherProfile.length ? "RePORTER profile id" : ""].filter(Boolean).join(" or ");
      const others = [...new Set([...anotherOrcid, ...anotherProfile])];
      return {
        row: null, by: key, candidates: hits, ambiguous: true,
        reason: `matched only by ${how} to ${personLabel(others)}, whose ${which} is not this person's: a namesake, ` +
          "so nothing was written to it. If they are one person after all, correct the identifier on that record or merge them.",
      };
    }
    const elsewhere = asked.length ? hits.filter((r) => { const e = emailKey(r.email); return !!e && !asked.includes(e); }) : [];
    if (elsewhere.length) {
      return {
        row: null, by: key, candidates: hits, ambiguous: true,
        reason: `matched only by ${how} to ${personLabel(elsewhere)}, whose email is not this person's: perhaps another person, ` +
          "so nothing was written to it. If they are one person, add this person's address to that record or merge them.",
      };
    }
    if (key === "name") {
      const emails = new Set(hits.map((r) => emailKey(r.email)).filter((e): e is string => !!e));
      if (emails.size < 2) return { row: pickPerson(hits), by: key, candidates: hits, ambiguous: false, reason: null };
      return {
        row: null, by: key, candidates: hits, ambiguous: true,
        reason: `${hits.length} records with ${emails.size} different emails match by name (${personLabel(hits)}); nothing was written. ` +
          "If they are one person, merge them; otherwise record the person's ORCID, RePORTER profile id or email.",
      };
    }
    const withEmail = hits.filter((r) => emailKey(r.email));
    const one = hits.length === 1 ? hits[0] : withEmail.length === 1 ? withEmail[0] : null;
    return {
      row: one, by: key, candidates: hits, ambiguous: !one,
      reason: one ? null : `${hits.length} records match by first and last name (${personLabel(hits)}); nothing was written. ` +
        "Merge them, or record the person's ORCID or RePORTER profile id.",
    };
  }
  return { row: null, by: null, candidates: [], ambiguous: false, reason: null };
}

export interface PubMatch { row: PubRow | null; by: "pmid" | "doi" | null; candidates: PubRow[]; note: string | null }

/** A publication by its PMID key, then its DOI key. When the two keys find different records, the
 *  PMID's is reused and the disagreement is reported. */
export function matchPublications(rows: PubRow[], q: { pmid?: Text; doi?: Text }): PubMatch {
  const pk = pmidKey(q.pmid);
  const dk = doiKey(q.doi);
  const byPmid = pk ? rows.filter((r) => pmidKey(r.pmid) === pk) : [];
  const byDoi = dk ? rows.filter((r) => doiKey(r.doi) === dk) : [];
  if (byPmid.length) {
    const row = pickNode(byPmid)!;
    const other = byDoi.find((r) => r.id !== row.id);
    const note = other
      ? `PMID ${pk} and DOI ${dk} are two records (${row.id}, ${other.id}): reused the PMID's; merge them`
      : null;
    return { row, by: "pmid", candidates: byPmid, note };
  }
  if (byDoi.length) {
    const row = pickNode(byDoi)!;
    const theirs = pmidKey(row.pmid);
    const note = pk && theirs && theirs !== pk ? `DOI ${dk} is recorded with PMID ${theirs}, not ${pk}: reused that record` : null;
    return { row, by: "doi", candidates: byDoi, note };
  }
  return { row: null, by: null, candidates: [], note: null };
}

const repoUrlOf = (r: ResourceRow) => (r.repoUrl ?? r.metadata?.repoUrl ?? null) as Text;

/** A resource the query may describe, and the keys it agrees on. `same` is whether it IS the query's
 *  record: only the name says so. */
export interface ResourceHit { row: ResourceRow; by: string[]; same: boolean }

/** Resources of the same resource_type that agree with the query on its name key (the exact name,
 *  for a name with no name key), its homepage URL key or its repository URL key (either way round).
 *  A URL is not an identity for a tool-like resource (design D7): a lab's tools share its homepage,
 *  a maker's devices share the maker's, and two tools can live in one repository. So a hit by URL
 *  alone is `same: false`, a hint for a curator, always: a query with a blank name has no name to
 *  agree on, which makes it no more the URL's record (decideResource refuses a blank name). */
export function matchResources(
  rows: ResourceRow[], q: { type: string; name?: Text; url?: Text; repoUrl?: Text },
): ResourceHit[] {
  const name = q.name == null ? "" : asciiTrim(String(q.name));
  const nk = nameKey(name);
  const want = new Set([urlKey(q.url), urlKey(q.repoUrl)].filter((u): u is string => !!u));
  const out: ResourceHit[] = [];
  for (const r of rows) {
    if (r.resource_type !== q.type) continue;
    const by: string[] = [];
    if (name && (nk ? nameKey(r.name) === nk : asciiTrim(String(r.name ?? "")) === name)) by.push("name");
    if (want.has(urlKey(r.external_url) ?? "")) by.push("url");
    if (want.has(urlKey(repoUrlOf(r)) ?? "")) by.push("repo_url");
    if (by.length) out.push({ row: r, by, same: by.includes("name") });
  }
  return out;
}

/** What add_resource does with a query: update the one record that is this resource, insert a new
 *  one, or refuse. */
export type ResourceDecision =
  | { action: "update"; row: ResourceRow; matchedBy: string; note: string | null }
  | { action: "insert"; note: string | null }
  | { action: "refuse"; error: string };

const resourceLabel = (r: ResourceRow) => `"${r.name}" (id ${r.id})`;

/** add_resource's rule. The record of this resource_type with the same name is updated; two are a
 *  duplicate to merge first. A record that shares only a homepage or repository URL is never
 *  updated, and a new record beside it is not written on a guess either: the call is refused, and
 *  the caller says which it is. `sameAs` (an id, or a name of this type) is "this is that record
 *  under another name": that record is updated. `distinct` is "this is another resource": it is
 *  inserted and the URL twin named in the note. Either way nothing is written that only SQL could
 *  undo (no tool removes a resource). A blank name is refused: it has nothing to be matched by. */
export function decideResource(
  rows: ResourceRow[], q: { type: string; name?: Text; url?: Text; repoUrl?: Text; sameAs?: Text; distinct?: boolean | null },
): ResourceDecision {
  const name = q.name == null ? "" : asciiTrim(String(q.name));
  const refuse = (error: string): ResourceDecision => ({ action: "refuse", error });
  if (!name) return refuse("A resource needs a name: the name was blank, so nothing could be matched or written. Nothing was written.");
  const hits = matchResources(rows, q);
  let target: { row: ResourceRow; by: string[] } | null = null;

  const sameAs = q.sameAs == null ? "" : asciiTrim(String(q.sameAs));
  if (sameAs && q.distinct === true) {
    return refuse(`same_as="${sameAs}" says this is that record, distinct=true says it is another resource: pass one of them. Nothing was written.`);
  }
  if (sameAs) {
    const byId = rows.find((r) => r.id === sameAs) ?? null;
    const sk = nameKey(sameAs);
    const named = byId || !sk ? [] : rows.filter((r) => r.resource_type === q.type && nameKey(r.name) === sk);
    const row = byId ?? (named.length === 1 ? named[0] : null);
    if (!row) {
      return refuse(named.length > 1
        ? `same_as="${sameAs}" names ${named.length} ${q.type} records (${named.map(resourceLabel).join("; ")}): merge them first, or pass one id. Nothing was written.`
        : `same_as="${sameAs}" names no ${q.type} in the KG: pass the id of the record this one is. Nothing was written.`);
    }
    if (row.resource_type !== q.type) {
      return refuse(`same_as="${sameAs}" is the ${row.resource_type} ${resourceLabel(row)}, not a ${q.type}. Nothing was written.`);
    }
    const named2 = hits.filter((h) => h.same && h.row.id !== row.id);
    if (named2.length) {
      return refuse(`"${name}" is already in the KG as ${named2.map((h) => resourceLabel(h.row)).join("; ")}, not ${resourceLabel(row)} ` +
        "as same_as says: correct same_as, or merge them first. Nothing was written.");
    }
    target = { row, by: ["same_as"] };
  } else {
    const same = hits.filter((h) => h.same);
    if (same.length > 1) {
      return refuse(`${same.length} ${q.type} records match "${name}": ${same.map((h) => `${h.row.name} (id ${h.row.id}, by ${h.by.join(" and ")})`).join("; ")}. ` +
        "Merge them first; nothing was written.");
    }
    target = same[0] ?? null;
  }

  // Records that share only a URL with this one: named, never written.
  const urlOnly = hits.filter((h) => !h.same && h.row.id !== target?.row.id);
  const twins = urlOnly.map((h) => `the ${q.type} ${resourceLabel(h.row)} has the same ${h.by.map((b) => (b === "url" ? "homepage" : "repository")).join(" and ")} URL`).join("; ");
  const why = "a URL can be shared by different things (a lab's tools, a maker's devices), so it does not make them one record";
  const shared = urlOnly.length
    ? `${twins[0].toUpperCase()}${twins.slice(1)}. ${urlOnly.length === 1 ? "It was" : "They were"} not changed: ${why}.`
    : null;
  if (target) return { action: "update", row: target.row, matchedBy: target.by.join("+"), note: shared };
  if (urlOnly.length && q.distinct !== true) {
    // Neither guess is written: updating the twin would overwrite another tool (the DeepLabCut /
    // DeepLabCut-Live case), and a new record that is the twin under another name could only be
    // removed with SQL. The caller knows which it is.
    const ids = urlOnly.map((h) => h.row.id);
    return refuse(`"${name}" is not in the KG under this name, but ${twins}, and ${why}. Nothing was written. ` +
      `If "${name}" is ${urlOnly.length === 1 ? "that record" : "one of them"} under another name, call again with ` +
      `same_as="${ids.length === 1 ? ids[0] : "<its id>"}"${ids.length === 1 ? "" : ` (one of ${ids.join(", ")})`}: that record is updated. ` +
      `If it is another ${q.type}, call again with distinct=true: it is added as its own record.`);
  }
  const key = nameKey(name);
  const namesakes = key ? rows.filter((r) => r.resource_type !== q.type && nameKey(r.name) === key) : [];
  const notes = [
    shared ? `Added as its own record (distinct=true). ${shared}` : null,
    namesakes.length ? `Also in the KG under another type: ${namesakes.map((r) => `${r.resource_type} "${r.name}" (id ${r.id})`).join(", ")}. If it is the same thing, retype one and merge them.` : null,
  ].filter(Boolean);
  return { action: "insert", note: notes.length ? notes.join(" ") : null };
}

/** Funding calls with the same FON key, and calls whose notice URL has the same URL key. */
export function matchFundingCalls(rows: CallRow[], q: { fon?: Text; url?: Text }): { byFon: CallRow[]; byUrl: CallRow[] } {
  const fk = fonKey(q.fon);
  const uk = urlKey(q.url);
  return {
    byFon: fk ? rows.filter((r) => fonKey(r.fon) === fk) : [],
    byUrl: uk ? rows.filter((r) => urlKey(r.url) === uk) : [],
  };
}

/** What add_funding_opportunity does with a call: update the one row that is this call, insert a new
 *  one, or refuse. `notes` are for the curator; `sharing` are the other calls with its URL key. */
export type CallDecision =
  | { action: "update"; row: CallRow; matchedBy: "fon" | "supersedes"; notes: string[]; sharing: CallRow[] }
  | { action: "insert"; notes: string[]; sharing: CallRow[] }
  | { action: "refuse"; error: string };

const callLabel = (r: CallRow) => `${r.fon} (id ${r.id})`;

/** add_funding_opportunity's rule. A call is its FON key: that row is updated, two are a duplicate to
 *  merge first. The notice URL is a hint, never an identity: a landing page (an NIH highlighted
 *  topic, a program page) lists several calls, so another call with the same URL key is named in a
 *  note and nothing is refused for it. `supersedes` (the forecast's FON) is the one way a final
 *  notice takes over its forecast's row. */
export function decideFundingCall(rows: CallRow[], q: { fon: Text; url?: Text; supersedes?: Text }): CallDecision {
  const { byFon, byUrl } = matchFundingCalls(rows, q);
  const sk = q.supersedes == null ? null : fonKey(q.supersedes);
  const superseded = sk ? rows.filter((r) => fonKey(r.fon) === sk && !byFon.includes(r)) : [];
  const dup = byFon.length > 1 ? byFon : superseded.length > 1 ? superseded : null;
  if (dup) return { action: "refuse", error: `${dup.map(callLabel).join(", ")} are one call recorded ${dup.length} times: merge them first. Nothing was written.` };

  const target = byFon[0] ?? superseded[0] ?? null;
  const notes: string[] = [];
  if (byFon[0] && superseded[0]) notes.push(`${callLabel(superseded[0])} is still a separate row for this call (its forecast?): merge it into this one`);
  const sharing = byUrl.filter((r) => r.id !== target?.id && r.id !== superseded[0]?.id);
  if (sharing.length) {
    notes.push(`Its notice URL is also on ${sharing.map(callLabel).join(", ")}. A URL can be a landing page that lists several calls, ` +
      "so that is only a hint and nothing was refused for it. " +
      (target
        ? "If one of them is this same call (its forecast), merge it into this one."
        : `If ${String(q.fon).trim()} is the final notice that replaces one of them, that forecast's row should have become this call: merge the two (supersedes="<the forecast's FON>" does it in one step when the final notice is added).`));
  }
  if (byFon[0]) return { action: "update", row: byFon[0], matchedBy: "fon", notes, sharing };
  if (superseded[0]) {
    return { action: "update", row: superseded[0], matchedBy: "supersedes", notes: [`${superseded[0].fon} is now ${String(q.fon).trim()}; its old FON is kept in notes`, ...notes], sharing };
  }
  if (q.supersedes != null) notes.push(`No call with FON ${q.supersedes} is in the KG, so nothing was superseded`);
  return { action: "insert", notes, sharing };
}

// ── Find or create ──────────────────────────────────────────────────────────────────────────────

/** An organization by its name key; created (name only, as given) when there is none. */
export async function findOrCreateOrganization(kg: KgSession, name: Text): Promise<Found<OrgRow>> {
  const clean = name == null ? "" : String(name).trim();
  if (!nameKey(clean)) return { ok: false, error: `${JSON.stringify(name)} has no name key (no letters or digits); not written` };
  try {
    const all = await loadOrganizations(kg);
    const m = matchOrganizations(all, clean);
    if (m.row) return { ok: true, row: m.row, created: false, matchedBy: "name", candidates: m.candidates.length };
    const ins = await kg.db.from("organizations").insert({ name: clean }).select(ORG_COLUMNS).single();
    if (!ins.error && ins.data) {
      all.push(ins.data as OrgRow);
      return { ok: true, row: ins.data as OrgRow, created: true, matchedBy: null };
    }
    if (!isUniqueViolation(ins.error)) return { ok: false, error: `organization ${clean}: ${message(ins.error)}` };
    const again = matchOrganizations(await loadOrganizations(kg, true), clean);
    if (again.row) {
      return { ok: true, row: again.row, created: false, matchedBy: "name", note: `already in the KG (${violatedConstraint(ins.error) ?? "unique key"})` };
    }
    return alreadyInKg(ins.error, `organization ${clean}`);
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** A person, by PERSON_KEYS (or `order`); created when nobody matches, person first. The insert is
 *  { name, email, secondary_emails, orcid, reporter_profile_id } as far as they are given, plus `extra`.
 *  Then the person's spine row is written and attached only if the person still has none; if it
 *  cannot be attached it is deleted. A 23505 on the person writes no spine row at all. */
export async function findOrCreateInvestigator(
  kg: KgSession, p: PersonQuery & { name: string },
  opts: { extra?: Record<string, unknown>; order?: PersonKey[] } = {},
): Promise<Found<PersonRow>> {
  const name = String(p.name ?? "").trim();
  if (!name) return { ok: false, error: "a person with no name; not written" };
  const order = opts.order ?? PERSON_KEYS;
  try {
    const all = await loadPeople(kg);
    const m = matchPeople(all, p, order);
    if (m.row) return { ok: true, row: m.row, created: false, matchedBy: m.by, candidates: m.candidates.length };
    // A name that fits a record with another email, or several records: not this person's to create
    // (a second record) or to reuse (another person's). A curator decides; nothing is written.
    if (m.ambiguous) return { ok: false, ambiguous: m.candidates.map((r) => r.id), error: `${name}: ${m.reason}` };

    // 1. The person.
    const row: Record<string, unknown> = { name };
    if (emailKey(p.email)) row.email = asciiTrim(String(p.email));
    if (p.secondaryEmails?.length) row.secondary_emails = p.secondaryEmails.filter((e) => emailKey(e)).map((e) => asciiTrim(String(e)));
    if (orcidKey(p.orcid)) row.orcid = asciiTrim(String(p.orcid));
    if (profileKey(p.reporterProfileId)) row.reporter_profile_id = p.reporterProfileId;
    Object.assign(row, opts.extra ?? {});
    const ins = await kg.db.from("investigators").insert(row).select(PERSON_COLUMNS).single();
    if (ins.error || !ins.data) {
      if (!isUniqueViolation(ins.error)) return { ok: false, error: `${name}: ${message(ins.error ?? "the insert returned no row")}` };
      // Someone wrote this person in between. investigators_name_key is exact, so a name with no
      // name key (no Latin letters or digits) is looked up exactly.
      const fresh = await loadPeople(kg, true);
      const m2 = matchPeople(fresh, p, order);
      if (m2.ambiguous) {
        return {
          ok: false, already_in_kg: true, constraint: violatedConstraint(ins.error), detail: violationDetail(ins.error),
          ambiguous: m2.candidates.map((r) => r.id), error: `${name}: refused by ${violatedConstraint(ins.error) ?? "a unique key"}, and ${m2.reason}`,
        };
      }
      const again = m2.row ?? fresh.find((r) => (r.name ?? "").trim() === name) ?? null;
      if (again) {
        return { ok: true, row: again, created: false, matchedBy: m2.row ? m2.by : "exact name", note: `already in the KG (${violatedConstraint(ins.error) ?? "unique key"})` };
      }
      return alreadyInKg(ins.error, name);
    }
    const person = ins.data as PersonRow;
    all.push(person);

    // 2. Then its node.
    const spine = await ensureSpineRow(kg, "investigators", person, { name, resource_type: "investigator" });
    return { ok: true, row: person, created: true, matchedBy: null, spine };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** A publication by its PMID key, then its DOI key; inserted (`row` as given) when neither matches. */
export async function findOrCreatePublication(
  kg: KgSession, row: Record<string, unknown> & { pmid?: Text; doi?: Text; title?: Text },
): Promise<Found<PubRow>> {
  const label = pmidKey(row.pmid) ? `PMID ${pmidKey(row.pmid)}` : `DOI ${doiKey(row.doi)}`;
  if (!pmidKey(row.pmid) && !doiKey(row.doi)) {
    return { ok: false, error: `"${row.title ?? "untitled"}" has neither a PMID nor a DOI to recognise it by; not written` };
  }
  try {
    const all = await loadPublications(kg);
    const m = matchPublications(all, row);
    if (m.row) return { ok: true, row: m.row, created: false, matchedBy: m.by, candidates: m.candidates.length, note: m.note ?? undefined };
    const ins = await kg.db.from("publications").insert(row).select(PUB_COLUMNS).single();
    if (!ins.error && ins.data) {
      all.push(ins.data as PubRow);
      return { ok: true, row: ins.data as PubRow, created: true, matchedBy: null };
    }
    if (!isUniqueViolation(ins.error)) return { ok: false, error: `${label}: ${message(ins.error)}` };
    const again = matchPublications(await loadPublications(kg, true), row);
    if (again.row) {
      return { ok: true, row: again.row, created: false, matchedBy: again.by, note: `already in the KG (${violatedConstraint(ins.error) ?? "unique key"})` };
    }
    return alreadyInKg(ins.error, label);
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Give a detail row (an investigator, a publication) its node, if it has none: insert the spine row,
 *  then attach it only where resource_id is still NULL. If it was not attached (someone attached one
 *  first, or the update failed) the new spine row is deleted again, so it can never be an orphan. */
export async function ensureSpineRow(
  kg: KgSession, table: string, row: { id: string; resource_id?: string | null },
  spine: { name: string; resource_type: string; external_url?: string | null; description?: string | null },
): Promise<SpineResult> {
  if (row.resource_id) return { ok: true, resourceId: row.resource_id, created: false };
  try {
    const ins = await kg.db.from("resources").insert(spine).select("id").single();
    if (ins.error || !ins.data) return { ok: false, resourceId: null, created: false, error: `no spine row: ${message(ins.error ?? "no row returned")}` };
    const id = String(ins.data.id);
    const upd = await kg.db.from(table).update({ resource_id: id }).eq("id", row.id).is("resource_id", null).select("id");
    if (!upd.error && (upd.data ?? []).length === 1) {
      row.resource_id = id;
      return { ok: true, resourceId: id, created: true };
    }
    const del = await kg.db.from("resources").delete().eq("id", id);
    const now = await kg.db.from(table).select("resource_id").eq("id", row.id).maybeSingle();
    row.resource_id = (now.data?.resource_id as string | undefined) ?? null;
    const why = upd.error ? `could not attach it (${message(upd.error)})` : "another node was attached first";
    return {
      ok: !!row.resource_id, resourceId: row.resource_id, created: false,
      error: `${why}; ${del.error ? `and the new spine row ${id} could not be deleted (${message(del.error)}): an orphan to remove` : "the new spine row was deleted"}`,
    };
  } catch (e) {
    return { ok: false, resourceId: null, created: false, error: message(e) };
  }
}

// ── Versions ────────────────────────────────────────────────────────────────────────────────────

export const VERSION_LINKS_UNAVAILABLE = "unavailable: 20261117181500 not applied";

export interface VersionLinks {
  available: boolean; done: number; noop: number; skipped: number; would_link: number; details: string[];
  error?: string; note?: string;
}

/** Link each preprint among `publicationIds`' title groups to its published version
 *  (resource_links revision_of), by the pairing rule public.kg_link_publication_versions() states
 *  once. Before 20261117181500 is applied the RPC is missing: that is reported, never thrown. */
export async function linkPublicationVersions(db: Db, publicationIds: string[], basis = "algorithmic"): Promise<VersionLinks> {
  const out: VersionLinks = { available: true, done: 0, noop: 0, skipped: 0, would_link: 0, details: [] };
  const ids = [...new Set(publicationIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const res = await db.rpc("kg_link_publication_versions", { _publication_ids: ids, _basis: basis });
    if (res.error) {
      if (isMissingFunction(res.error, res.status)) return { ...out, available: false, note: VERSION_LINKS_UNAVAILABLE };
      return { ...out, error: message(res.error) };
    }
    for (const r of (res.data ?? []) as Array<{ outcome: string; detail: string }>) {
      if (r.outcome === "done" || r.outcome === "noop" || r.outcome === "skipped" || r.outcome === "would_link") out[r.outcome]++;
      if (r.outcome !== "noop") out.details.push(`${r.outcome}: ${r.detail}`);
    }
    return out;
  } catch (e) {
    return { ...out, error: message(e) };
  }
}
