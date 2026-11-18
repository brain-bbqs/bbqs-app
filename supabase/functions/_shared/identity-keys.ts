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
//
// Two of the rules are not identity keys: urlKey (a URL can be a landing page several records share,
// so no index enforces it) and the pairing rule's parts, titleKey, isPreprint and preprintIsLater,
// by which public.kg_link_publication_versions links a preprint to its published version.

// Where a preprint lives: by venue (the lower-cased journal contains one), by DOI prefix, or by the
// shape of a bioRxiv/medRxiv DOI. 10.1101/ is no prefix here: Cold Spring Harbor Laboratory Press
// publishes Genome Res, Genes Dev and Learn Mem under it too (10.1101/gr..., /gad..., /lm...).
export const PREPRINT_VENUES = ["biorxiv", "medrxiv", "arxiv", "research square", "res sq", "ssrn", "psyarxiv", "preprints"];
export const PREPRINT_DOI_PREFIXES = ["10.64898/", "10.48550/", "10.21203/", "10.2139/", "10.31234/", "10.20944/"];
export const PREPRINT_DOI_PATTERNS = ["^10\\.1101/([0-9]{4}\\.[0-9]{2}\\.[0-9]{2}\\.)?[0-9]{6,}"];
const PREPRINT_DOI = PREPRINT_DOI_PATTERNS.map((p) => new RegExp(p));
// The posting date a bioRxiv or medRxiv DOI carries (10.1101/ or bioRxiv's 2026 prefix 10.64898/,
// then YYYY.MM.DD.): when the first version was posted. Its group 1 is the year.
export const PREPRINT_DOI_DATE = "^10\\.(?:1101|64898)/([0-9]{4})\\.[0-9]{2}\\.[0-9]{2}\\.[0-9]{6,}";
const DOI_DATE = new RegExp(PREPRINT_DOI_DATE);

// Greek letters by name, so the name and title rules keep them (alpha-synuclein and beta-synuclein
// are two titles): every capital (U+0391-U+03A9) and small letter (U+03B1-U+03C9) of the basic Greek
// block, in alphabet order, and the final sigma (U+03C2). NFKD maps the compatibility forms onto
// these first (the micro sign to mu, the ohm sign to omega, an accented letter to letter + mark).
const GREEK_NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
  "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega"];
// The 18th letter, sigma, comes after U+03A2 (unassigned) and U+03C2 (the final sigma).
const letter = (first: number, i: number) => String.fromCharCode(first + i + (i >= 17 ? 1 : 0));
export const GREEK: Record<string, string> = Object.fromEntries([
  ...GREEK_NAMES.map((n, i) => [letter(0x0391, i), n]),
  ...GREEK_NAMES.map((n, i) => [letter(0x03b1, i), n]),
  [String.fromCharCode(0x03c2), "sigma"],
]);

type Text = string | null | undefined;
type Year = number | null | undefined;

const lower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const upper = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
const trim = (s: string) => s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
const greek = (s: string) => Array.from(s, (c) => GREEK[c] ?? c).join("");

/** The first ORCID iD anywhere in the value, upper-cased ('...-009x' -> '...-009X'); else null. */
export function orcidKey(v: Text): string | null {
  if (v == null) return null;
  const m = String(v).match(/[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9Xx]/);
  return m ? upper(m[0]) : null;
}

/** A DOI without its resolver ('https://doi.org/', 'doi.org/', 'www.doi.org/', 'dx.doi.org/') or its
 *  'doi:' / 'doi ', lower-cased, no trailing '/'; null unless it is a DOI. */
export function doiKey(v: Text): string | null {
  if (v == null) return null;
  const d = lower(trim(String(v)).replace(/^((https?:\/\/)?((dx|www)\.)?doi\.org\/|doi:?[ \t\n\v\f\r]*)/i, "")).replace(/\/+$/, "");
  return /^10\.[0-9.]+\/[^ \t\n\v\f\r]+$/.test(d) ? d : null;
}

/** A PubMed id as digits without leading zeros ('PMID: 0041331138', 'PMID 41331138' -> '41331138'); else null. */
export function pmidKey(v: Text): string | null {
  if (v == null) return null;
  const p = trim(String(v)).replace(/^pmid:?[ \t\n\v\f\r]*/i, "");
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

/** An organization (or person) name: NFKD, each Greek letter by its name, lower-cased, letters and
 *  digits only. It catches case, punctuation, spacing and accents; not other wording (an
 *  organization's ROR id is its identity: "State University of New York at Stony Brook" and "STATE
 *  UNIVERSITY NEW YORK STONY BROOK" have two name keys). */
export function nameKey(v: Text): string | null {
  return v == null ? null : (lower(greek(String(v).normalize("NFKD"))).replace(/[^a-z0-9]/g, "") || null);
}

/** A URL without its scheme, 'www.' and trailing '/', lower-cased ('www.x.org/a' = 'https://x.org/a/').
 *  Not an identity key: a URL can be a landing page that several records share. */
export function urlKey(v: Text): string | null {
  if (v == null) return null;
  return lower(trim(String(v)).replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/\/+$/, "")) || null;
}

/** A title without markup, folded like a name. Not a key: it pairs a preprint with its published version. */
export function titleKey(v: Text): string | null {
  return v == null ? null : nameKey(String(v).replace(/<[^>]*>/g, ""));
}

/** Is a publication a preprint, by its venue, its DOI's prefix or the shape of a bioRxiv/medRxiv DOI? */
export function isPreprint(journal: Text, doi: Text): boolean {
  const j = lower(String(journal ?? ""));
  const d = doiKey(doi) ?? "";
  return PREPRINT_VENUES.some((x) => j.includes(x)) || PREPRINT_DOI_PREFIXES.some((p) => d.startsWith(p))
    || PREPRINT_DOI.some((p) => p.test(d));
}

/** The year a dated bioRxiv/medRxiv DOI was posted ('10.1101/2023.06.25.546478' -> 2023); else null. */
export function postedYear(doi: Text): number | null {
  const m = (doiKey(doi) ?? "").match(DOI_DATE);
  return m ? Number(m[1]) : null;
}

/** Is the preprint later than its published version? First by PubMed id, when both have one and they
 *  differ (their keys, compared as numbers); otherwise by the preprint's earliest known date against the
 *  published year: the posting year in a dated bioRxiv/medRxiv DOI, else its own year; else false.
 *  A preprint's own year drifts later as new versions are posted, so it only breaks a tie. The pairing
 *  rule never links a later preprint (public.kg_link_publication_versions skips it and says why). */
export function preprintIsLater(
  preprintYear: Year, preprintPmid: Text, preprintDoi: Text, publishedYear: Year, publishedPmid: Text,
): boolean {
  const a = pmidKey(preprintPmid);
  const b = pmidKey(publishedPmid);
  if (a != null && b != null && a !== b) return a.length !== b.length ? a.length > b.length : a > b;   // keys have no leading zeros
  const first = postedYear(preprintDoi) ?? preprintYear;
  return first != null && publishedYear != null && first > publishedYear;
}
