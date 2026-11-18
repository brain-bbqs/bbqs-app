#!/usr/bin/env python3
"""The BBQS identity keys: when two records are the same thing, decided by one rule per key.

Each rule is stated once, in kg/identity_keys.json, with the vectors that pin it down, and is
implemented three times, identically:

  SQL         public.kg_<key>_key   (supabase/migrations/*_prevent_duplicates.sql; the uq_* indexes)
  TypeScript  supabase/functions/_shared/identity-keys.ts   (what the write paths look up by)
  Python      this module           (kg/quality.py duplicates(), publications() and the revision_of
                                     checks; the exporter's ORCID and award forms)

Two of the rules are not identity keys. url_key folds a URL, which duplicates() compares but no
index enforces: a URL can be a landing page that several records share. title_key, is_preprint and
preprint_is_later are the pairing rule's parts: public.kg_link_publication_versions links a
preprint to its published version by them, and kg/quality.py groups publications by title_key of
their bbqs:title, so the export sees the pairs the database makes.

Every implementation must return `want` for every vector. kg/ci_check.py runs this module on them
(`check()`), tests/guards/identity-normalization runs the TypeScript, and the migration's self-test
block runs the SQL when it is applied. tests/guards/kg-identity-keys keeps the declarations in step.

The conventions are what Postgres (COLLATE "C"), JavaScript and Python can all do the same way:

  * whitespace is ASCII only: space, \\t, \\n, \\v, \\f, \\r. "Trim" strips those at both ends;
  * case is mapped for A-Z / a-z only, with str.translate, never .lower() or .casefold()
    ('ß'.casefold() is 'ss', and İ lower-cases to two characters);
  * digits are [0-9], never \\d, which also matches other scripts' digits;
  * a regex with IGNORECASE also has re.ASCII (otherwise 'k' matches the Kelvin sign), and a whole
    value is tested with fullmatch ('$' also matches before a trailing newline);
  * None means no key: the value is neither enforced nor matched, so two missing values never collide.

Standard library only: run `python kg/identity_keys.py` to check this module against the vectors.
"""
import json
import re
import string
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = HERE / "identity_keys.json"

_WS = " \t\n\v\f\r"
_LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)
_UPPER = str.maketrans(string.ascii_lowercase, string.ascii_uppercase)
_ORCID = re.compile(r"[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9Xx]")
# A resolver (scheme optional, then dx. or www. optional, then doi.org/), or "doi", ":" optional.
_DOI_PREFIX = re.compile(r"^((https?://)?((dx|www)\.)?doi\.org/|doi:?[ \t\n\v\f\r]*)", re.I | re.A)
_DOI = re.compile(r"10\.[0-9.]+/[^ \t\n\v\f\r]+")
_PMID_PREFIX = re.compile(r"^pmid:?[ \t\n\v\f\r]*", re.I | re.A)
_DIGITS = re.compile(r"[0-9]+")
_AWARD = re.compile(r"[A-Z][A-Z0-9]{2}[A-Z]{2}[0-9]{6}")
_URL_PREFIX = re.compile(r"^(https?://)?(www\.)?", re.I | re.A)
_TAG = re.compile(r"<[^>]*>")

# Greek letters by name, so that the name and title rules keep them: alpha-synuclein and
# beta-synuclein are two titles, not one. Every capital (U+0391-U+03A9) and small letter
# (U+03B1-U+03C9) of the basic Greek block, and the final sigma, in alphabet order. NFKD has mapped
# the compatibility forms onto these already: the micro sign to mu, the ohm sign to omega, the
# theta, phi, pi, kappa, rho and beta symbols to their letters, an accented letter to the letter and
# a combining mark. Any other Greek character is deleted with the rest of what is not a-z or 0-9.
_GREEK_NAMES = ("alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
                "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi",
                "psi", "omega")
_CAPITALS = [c for c in range(0x0391, 0x03AA) if c != 0x03A2]     # U+03A2 is unassigned
_SMALL = [c for c in range(0x03B1, 0x03CA) if c != 0x03C2]        # U+03C2 is the final sigma
GREEK = {chr(c): n for row in (_CAPITALS, _SMALL) for c, n in zip(row, _GREEK_NAMES)} | {chr(0x03C2): "sigma"}
_GREEK = str.maketrans(GREEK)

# Where a preprint lives: by venue name (lower-cased journal contains one), by DOI prefix, or by
# the shape of a bioRxiv/medRxiv DOI. "res sq" is PubMed's abbreviation for Research Square;
# 10.64898/ is bioRxiv's 2026 DOI prefix. 10.1101/ is not a prefix here: Cold Spring Harbor
# Laboratory Press publishes Genome Res, Genes Dev and Learn Mem under it too (10.1101/gr...,
# 10.1101/gad..., 10.1101/lm...), so a bioRxiv or medRxiv DOI is told by its shape: 10.1101/, an
# optional posting date, and at least six digits.
PREPRINT_VENUES = ("biorxiv", "medrxiv", "arxiv", "research square", "res sq", "ssrn", "psyarxiv", "preprints")
PREPRINT_DOI_PREFIXES = ("10.64898/", "10.48550/", "10.21203/", "10.2139/", "10.31234/", "10.20944/")
PREPRINT_DOI_PATTERNS = (r"^10\.1101/([0-9]{4}\.[0-9]{2}\.[0-9]{2}\.)?[0-9]{6,}",)
_PREPRINT_DOI = [re.compile(p, re.A) for p in PREPRINT_DOI_PATTERNS]
# The posting date a bioRxiv or medRxiv DOI carries (10.1101/ or bioRxiv's 2026 prefix 10.64898/,
# then YYYY.MM.DD.): the date the first version was posted. Its group 1 is the year.
PREPRINT_DOI_DATE = r"^10\.(?:1101|64898)/([0-9]{4})\.[0-9]{2}\.[0-9]{2}\.[0-9]{6,}"
_PREPRINT_DOI_DATE = re.compile(PREPRINT_DOI_DATE, re.A)


def _text(v) -> str:
    return str(v)


def orcid_key(v):
    """The first ORCID iD anywhere in the value, upper-cased ('…-009x' -> '…-009X'); else None."""
    m = _ORCID.search(_text(v)) if v is not None else None
    return m.group(0).translate(_UPPER) if m else None


def doi_key(v):
    """A DOI without its resolver ('https://doi.org/', 'doi.org/', 'www.doi.org/', 'dx.doi.org/') or its
    'doi:' / 'doi ', lower-cased, no trailing '/'; None unless it is a DOI."""
    if v is None:
        return None
    d = _DOI_PREFIX.sub("", _text(v).strip(_WS), count=1).translate(_LOWER).rstrip("/")
    return d if _DOI.fullmatch(d) else None


def pmid_key(v):
    """A PubMed id as digits without leading zeros ('PMID: 0041331138', 'PMID 41331138' -> '41331138'); else None."""
    if v is None:
        return None
    p = _PMID_PREFIX.sub("", _text(v).strip(_WS), count=1)
    return (p.lstrip("0") or None) if _DIGITS.fullmatch(p) else None


def fon_key(v):
    """A funding opportunity number upper-cased, letters and digits only ('rfa ns 27 002' -> 'RFANS27002')."""
    return None if v is None else (re.sub(r"[^A-Z0-9]", "", _text(v).translate(_UPPER)) or None)


def nih_award_core(v):
    """The NIH core award number in a grant number ('1R34DA059723-01' -> 'R34DA059723'); else None.
    What a write path stores as grant_number, and what the exporter links a dandiset's award by."""
    m = _AWARD.search(_text(v).translate(_UPPER)) if v is not None else None
    return m.group(0) if m else None


def award_key(v):
    """A grant's identity: its NIH core when it has one, else the number upper-cased without whitespace."""
    if v is None:
        return None
    return nih_award_core(v) or (re.sub(r"[ \t\n\v\f\r]", "", _text(v).translate(_UPPER)) or None)


def name_key(v):
    """A name compared without case, accents, punctuation or spacing: NFKD, each Greek letter by its
    name (GREEK), then a-z and 0-9 only. It catches case, punctuation, spacing and accents
    ('UNIVERSITY OF CALIFORNIA, SAN DIEGO' = 'University of California San Diego', 'Université' =
    'Universite'); it misses other wording ('State University of New York at Stony Brook' is not
    'STATE UNIVERSITY NEW YORK STONY BROOK'), which is what an organization's ROR id is for."""
    if v is None:
        return None
    s = unicodedata.normalize("NFKD", _text(v)).translate(_GREEK).translate(_LOWER)
    return re.sub(r"[^a-z0-9]", "", s) or None


def url_key(v):
    """A URL without its scheme, a leading www., or a trailing '/', lower-cased ('www.x.org/a' =
    'https://x.org/a/'). Not an identity key: duplicates() compares it, no database index enforces it."""
    if v is None:
        return None
    return _URL_PREFIX.sub("", _text(v).strip(_WS), count=1).rstrip("/").translate(_LOWER) or None


def title_key(v):
    """A title without markup, by the name rule ('Ca<sup>2+</sup>' = 'Ca[2+]'; 'alpha-synuclein' and
    'beta-synuclein', written in Greek, stay apart). Not a key: it pairs a preprint with its published
    version (public.kg_link_publication_versions), and kg/quality.py groups publications by it."""
    return None if v is None else name_key(_TAG.sub("", _text(v)))


def is_preprint(journal, doi) -> bool:
    """Is a paper with this journal and DOI a preprint? By its venue, its DOI's prefix, or the shape of
    a bioRxiv/medRxiv DOI (a Genome Res, Genes Dev or Learn Mem DOI, also 10.1101/, is no preprint)."""
    j = _text(journal if journal is not None else "").translate(_LOWER)
    d = doi_key(doi) or ""
    return (any(x in j for x in PREPRINT_VENUES) or d.startswith(PREPRINT_DOI_PREFIXES)
            or any(p.search(d) for p in _PREPRINT_DOI))


def posted_year(doi):
    """The year a dated bioRxiv/medRxiv DOI was posted ('10.1101/2023.06.25.546478' -> 2023); else None."""
    m = _PREPRINT_DOI_DATE.search(doi_key(doi) or "")
    return int(m.group(1)) if m else None


def preprint_is_later(preprint_year, preprint_pmid, preprint_doi, published_year, published_pmid) -> bool:
    """Is the preprint later than its published version? First by PubMed id, when both have one and they
    differ (their keys, as numbers: PubMed numbers records in the order it adds them). Otherwise by the
    preprint's earliest known date against the published year: the posting year in a dated
    bioRxiv/medRxiv DOI, else the preprint's own year. Else False, as nothing says so.

    The preprint's own year only breaks a tie. bioRxiv and PubMed give a preprint the year of its
    latest version, so that year drifts later as versions are posted: CaBLAM's preprint, posted on
    2023-06-25, has the year 2025. Deciding by it first would refuse real pairs. The pairing rule never
    links a preprint that is later: it is another work with the same title, or a record with a wrong
    PMID, DOI or year."""
    a, b = pmid_key(preprint_pmid), pmid_key(published_pmid)
    if a is not None and b is not None and a != b:
        return int(a) > int(b)
    first = posted_year(preprint_doi)
    if first is None:
        first = preprint_year
    return first is not None and published_year is not None and first > published_year


def load_spec(path=SPEC) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def check(spec: dict | None = None) -> list[str]:
    """Every way this module disagrees with kg/identity_keys.json: a vector it gets wrong, a function
    the JSON names that is not here, a preprint list or the Greek table that differs. Empty when they
    agree. A vector whose input is a list is the function's arguments (preprint, chronology)."""
    spec = spec if spec is not None else load_spec()
    problems = []
    for name, key in spec["keys"].items():
        fn = globals().get(key.get("py", ""))
        if not callable(fn):
            problems.append(f"{name}: kg/identity_keys.py has no function {key.get('py')!r}")
            continue
        for given, want in key["vectors"]:
            got = fn(*given) if isinstance(given, list) else fn(given)
            if got != want:
                problems.append(f"{name}: {key['py']}({given!r}) is {got!r}, the vector says {want!r}")
    pre = spec["keys"].get("preprint", {})
    for field, mine in (("venues", PREPRINT_VENUES), ("doi_prefixes", PREPRINT_DOI_PREFIXES),
                        ("doi_patterns", PREPRINT_DOI_PATTERNS)):
        if sorted(pre.get(field, [])) != sorted(mine):
            problems.append(f"preprint {field}: kg/identity_keys.py has {sorted(mine)}, the JSON {sorted(pre.get(field, []))}")
    date = spec["keys"].get("chronology", {}).get("doi_date")
    if date != PREPRINT_DOI_DATE:
        problems.append(f"chronology doi_date: kg/identity_keys.py has {PREPRINT_DOI_DATE!r}, the JSON {date!r}")
    greek = spec["keys"].get("name", {}).get("greek", {})
    if greek != GREEK:
        diff = sorted(set(greek.items()) ^ set(GREEK.items()))
        problems.append(f"name greek: kg/identity_keys.py's GREEK and the JSON's table differ: {diff[:6]}")
    return problems


if __name__ == "__main__":
    spec = load_spec(sys.argv[1] if len(sys.argv) > 1 else SPEC)
    bad = check(spec)
    n = sum(len(k["vectors"]) for k in spec["keys"].values())
    print("\n".join(bad) if bad else f"kg/identity_keys.py agrees with all {n} vectors")
    sys.exit(1 if bad else 0)
