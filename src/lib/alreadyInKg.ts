// A write the database refused as a duplicate (23505, unique_violation), said as what it is.
//
// WHY (2026-11-17). Migration 20261117181500 makes the database refuse a second record for an
// identity key: an ORCID iD, a DOI or PMID, a funding call's FON, an award number, an organization's
// name (its uq_* indexes, kg/identity_keys.json). Each page that writes one of those columns then
// meets a 23505 where it met none before, and showed it raw ("duplicate key value violates unique
// constraint "uq_investigators_orcid_key""), or not at all. These helpers say which key is already
// in the KG and what to do about it, and leave every other error alone: a caller shows that one as
// it came.
//
// No imports and only erasable TypeScript, so tests/guards/write-paths-get-or-create.test.mjs can
// load this file in Node.

export interface UniqueViolation {
  /** The index or constraint that refused the write, e.g. uq_investigators_orcid_key. */
  constraint: string | null;
  /** The key the database compared, from "Key (kg_orcid_key(orcid))=(0000-0002-1825-0097) already exists." */
  key: string | null;
}

const textOf = (e: unknown): string => {
  if (e == null) return "";
  if (typeof e === "string") return e;
  const o = e as { message?: unknown; details?: unknown; hint?: unknown };
  return [o.message, o.details, o.hint].filter((x) => typeof x === "string" && x).join(" ");
};

/** The refusal, when `e` is a unique violation (a supabase-js error, or an Error that carries
 *  PostgREST's body); null for every other error. */
export function uniqueViolation(e: unknown): UniqueViolation | null {
  if (!e) return null;
  const t = textOf(e);
  const coded = typeof e === "object" && (e as { code?: unknown }).code === "23505";
  if (!coded && !/"code"\s*:\s*"23505"/.test(t) && !/duplicate key value violates unique constraint/i.test(t)) return null;
  const c = t.match(/unique constraint \\?"([^"\\]+)\\?"/);
  const k = t.match(/Key \((.+?)\)=\((.*?)\) already exists/);
  return { constraint: c ? c[1] : null, key: k ? k[2] : null };
}

export type KeyKind = "orcid" | "doi" | "pmid" | "fon" | "award" | "organization" | "email" | "name" | "node";

/** What a refused key is, by the name of the index or constraint that refused it. A URL is none:
 *  no index refuses a URL another record has (a landing page serves several), so a constraint this
 *  does not know is said generically. */
export function keyKind(constraint: string | null): KeyKind | null {
  const c = (constraint ?? "").toLowerCase();
  if (c.includes("orcid")) return "orcid";
  if (c.includes("doi")) return "doi";
  if (c.includes("pmid")) return "pmid";
  if (c.includes("resource_id")) return "node";
  if (c.includes("fon")) return "fon";
  if (c.includes("award") || c.includes("grant_number")) return "award";
  if (c.includes("organization")) return "organization";
  if (c.includes("email")) return "email";
  if (c.includes("name")) return "name";
  return null;
}

/** A sentence for a write the database refused as a duplicate, or null when `e` is not a unique
 *  violation (then show `e` as it is). `typed` holds what the person typed for each key the write
 *  carried ({ doi }, { fon }), shown instead of the key the database folded it to. */
export function alreadyInKgMessage(e: unknown, typed: Partial<Record<KeyKind, string | null | undefined>> = {}): string | null {
  const v = uniqueViolation(e);
  if (!v) return null;
  const kind = keyKind(v.constraint);
  const shown = String((kind && typed[kind]) ?? "").trim() || v.key || "this value";
  switch (kind) {
    case "orcid":
      return `The ORCID iD ${shown} is already on another person's record in the KG, and one ORCID iD is one person, so it was not saved. If that record is you, ask a curator to merge the two records.`;
    case "doi":
      return `A publication with the DOI ${shown} is already in the KG (DOIs are compared without case or a doi.org prefix), so it was not added again.`;
    case "pmid":
      return `A publication with the PMID ${shown} is already in the KG, so it was not added again.`;
    case "fon":
      return `The funding opportunity ${shown} is already in the KG (FONs are compared without case, spaces or dashes), so it was not added again. Edit that one instead.`;
    case "award":
      return `The award ${shown} is already in the KG under another spelling of its number, so nothing was saved. Ask a curator to correct the number on one of the two records.`;
    case "organization":
      return `The organization ${shown} is already in the KG (names are compared without case or punctuation), so it was not added again.`;
    case "email":
      return `The email address ${shown} is already on another person's record in the KG, so it was not saved. Ask a curator to merge the two records.`;
    case "name":
      return `Another record in the KG already has the name ${shown}, so it was not saved. Ask a curator whether they are one person.`;
    case "node":
      return "This record's node in the KG belongs to another record, so nothing was saved. Ask a curator.";
    default:
      return `This is already in the KG (${v.constraint ?? "a unique key"}), so nothing was saved.`;
  }
}

/** member_self_update's arguments (supabase/migrations/20261028130000_working_group_cross_species.sql). */
export interface OwnProfileArgs {
  _institution: string | null;
  _orcid: string | null;
  _research_areas: string[] | null;
  _skills: string[] | null;
  _secondary_emails: string[] | null;
  _requested_working_groups: string[] | null;
}

export interface OwnProfileSave {
  data: unknown;
  error: unknown;
  /** Set when the ORCID iD was left out because another person's record holds it. */
  orcidNotSaved: string | null;
}

/** Save the signed-in member's own profile with member_self_update. The RPC writes every field in one
 *  UPDATE, so an ORCID iD that is already on another person's record (uq_investigators_orcid_key)
 *  refuses all of them. Then the save is made again without the ORCID (a null _orcid keeps the stored
 *  one), and `orcidNotSaved` says why it was left out. Any other error comes back as it came, and
 *  nothing is retried for it. */
export async function saveOwnProfile(
  call: (args: OwnProfileArgs) => PromiseLike<{ data: unknown; error: unknown }>,
  args: OwnProfileArgs,
): Promise<OwnProfileSave> {
  const first = await call(args);
  const v = uniqueViolation(first.error);
  if (!v || keyKind(v.constraint) !== "orcid" || !args._orcid) return { data: first.data, error: first.error, orcidNotSaved: null };
  const again = await call({ ...args, _orcid: null });
  return { data: again.data, error: again.error, orcidNotSaved: alreadyInKgMessage(first.error, { orcid: args._orcid }) };
}
