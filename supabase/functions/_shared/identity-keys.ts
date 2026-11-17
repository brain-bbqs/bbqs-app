// The BBQS identity keys: when two records are the same thing, decided by one rule per key.
//
// Each rule is stated once, in kg/identity_keys.json, with the vectors that pin it down, and is
// implemented three times, identically:
//   SQL         public.kg_<key>_key (supabase/migrations/*_prevent_duplicates.sql; the uq_* indexes)
//   TypeScript  this module (what the write paths look up by, through _shared/kg-write.ts)
//   Python      kg/identity_keys.py (kg/quality.py duplicates(), the exporter)
// tests/guards/identity-normalization runs every vector through this module and holds it to the
// migration's self-test block and to the Python module.
//
// The conventions are the ones Postgres (COLLATE "C"), JavaScript and Python can all do the same way:
//   * whitespace is ASCII only: space, \t, \n, \v, \f, \r; "trim" strips those at both ends;
//   * case is mapped for A-Z / a-z only, through a character-code map, never toLowerCase() or
//     toUpperCase(): 'ß'.toUpperCase() is 'SS', and 'İ'.toLowerCase() is two characters;
//   * digits are [0-9];
//   * null means no key: the value is neither enforced nor matched, so two missing values never
//     collide.
//
// No imports, no Deno globals and erasable TypeScript only: the Node guards import this file directly.

export const PREPRINT_VENUES = ["biorxiv", "medrxiv", "arxiv", "research square", "res sq", "ssrn", "psyarxiv", "preprints"];
export const PREPRINT_DOI_PREFIXES = ["10.1101/", "10.64898/", "10.48550/", "10.21203/", "10.2139/", "10.31234/", "10.20944/"];

type Text = string | null | undefined;

const lower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const upper = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
const trim = (s: string) => s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

/** The first ORCID iD anywhere in the value, upper-cased ('...-009x' -> '...-009X'); else null. */
export function orcidKey(v: Text): string | null {
  if (v == null) return null;
  const m = String(v).match(/[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9Xx]/);
  return m ? upper(m[0]) : null;
}

/** A DOI without its resolver prefix or 'doi:', lower-cased, no trailing '/'; null unless it is a DOI. */
export function doiKey(v: Text): string | null {
  if (v == null) return null;
  const d = lower(trim(String(v)).replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:[ \t\n\v\f\r]*)/i, "")).replace(/\/+$/, "");
  return /^10\.[0-9.]+\/[^ \t\n\v\f\r]+$/.test(d) ? d : null;
}

/** A PubMed id as digits without leading zeros ('PMID: 0041331138' -> '41331138'); else null. */
export function pmidKey(v: Text): string | null {
  if (v == null) return null;
  const p = trim(String(v)).replace(/^pmid:[ \t\n\v\f\r]*/i, "");
  return /^[0-9]+$/.test(p) ? (p.replace(/^0+/, "") || null) : null;
}

/** A funding opportunity number, upper-cased, letters and digits only ('rfa ns 27 002' -> 'RFANS27002'). */
export function fonKey(v: Text): string | null {
  return v == null ? null : (upper(String(v)).replace(/[^A-Z0-9]/g, "") || null);
}

/** The NIH core award number in a grant number ('1R34DA059723-01' -> 'R34DA059723'); else null.
 *  What a write path stores as grant_number and sends to create_grant, repoint_grant and nih-grants. */
export function nihAwardCore(v: Text): string | null {
  if (v == null) return null;
  const m = upper(String(v)).match(/[A-Z][A-Z0-9]{2}[A-Z]{2}[0-9]{6}/);
  return m ? m[0] : null;
}

/** The award key: the NIH core when there is one, else the upper-cased number without whitespace. */
export function awardKey(v: Text): string | null {
  if (v == null) return null;
  return nihAwardCore(v) ?? (upper(String(v)).replace(/[ \t\n\v\f\r]/g, "") || null);
}

/** An organization (or person) name: NFKD, lower-cased, letters and digits only. */
export function nameKey(v: Text): string | null {
  return v == null ? null : (lower(String(v).normalize("NFKD")).replace(/[^a-z0-9]/g, "") || null);
}

/** A URL without its scheme, 'www.' and trailing '/', lower-cased. */
export function urlKey(v: Text): string | null {
  if (v == null) return null;
  return lower(trim(String(v)).replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "")) || null;
}

/** A title without markup, folded like a name. Not a key: it pairs a preprint with its published version. */
export function titleKey(v: Text): string | null {
  return v == null ? null : nameKey(String(v).replace(/<[^>]*>/g, ""));
}

/** Is a publication a preprint, by its venue or its DOI's prefix? */
export function isPreprint(journal: Text, doi: Text): boolean {
  const j = lower(String(journal ?? ""));
  const d = doiKey(doi) ?? "";
  return PREPRINT_VENUES.some((x) => j.includes(x)) || PREPRINT_DOI_PREFIXES.some((p) => d.startsWith(p));
}
