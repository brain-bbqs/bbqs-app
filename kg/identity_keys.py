#!/usr/bin/env python3
"""The BBQS identity keys: when two records are the same thing, decided by one rule per key.

Each rule is stated once, in kg/identity_keys.json, with the vectors that pin it down, and is
implemented three times, identically:

  SQL         public.kg_<key>_key   (supabase/migrations/*_prevent_duplicates.sql; the uq_* indexes)
  TypeScript  supabase/functions/_shared/identity-keys.ts   (what the write paths look up by)
  Python      this module           (kg/quality.py duplicates(), the exporter's ORCID and award forms)

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
_DOI_PREFIX = re.compile(r"^(https?://(dx\.)?doi\.org/|doi:[ \t\n\v\f\r]*)", re.I | re.A)
_DOI = re.compile(r"10\.[0-9.]+/[^ \t\n\v\f\r]+")
_PMID_PREFIX = re.compile(r"^pmid:[ \t\n\v\f\r]*", re.I | re.A)
_DIGITS = re.compile(r"[0-9]+")
_AWARD = re.compile(r"[A-Z][A-Z0-9]{2}[A-Z]{2}[0-9]{6}")
_URL_PREFIX = re.compile(r"^https?://(www\.)?", re.I | re.A)
_TAG = re.compile(r"<[^>]*>")

# Where a preprint lives: by venue name (lower-cased journal contains one), or by DOI prefix.
# "res sq" is PubMed's abbreviation for Research Square; 10.64898/ is bioRxiv's 2026 DOI prefix.
PREPRINT_VENUES = ("biorxiv", "medrxiv", "arxiv", "research square", "res sq", "ssrn", "psyarxiv", "preprints")
PREPRINT_DOI_PREFIXES = ("10.1101/", "10.64898/", "10.48550/", "10.21203/", "10.2139/", "10.31234/", "10.20944/")


def _text(v) -> str:
    return str(v)


def orcid_key(v):
    """The first ORCID iD anywhere in the value, upper-cased ('…-009x' -> '…-009X'); else None."""
    m = _ORCID.search(_text(v)) if v is not None else None
    return m.group(0).translate(_UPPER) if m else None


def doi_key(v):
    """A DOI without its resolver prefix or 'doi:', lower-cased, no trailing '/'; None unless it is a DOI."""
    if v is None:
        return None
    d = _DOI_PREFIX.sub("", _text(v).strip(_WS), count=1).translate(_LOWER).rstrip("/")
    return d if _DOI.fullmatch(d) else None


def pmid_key(v):
    """A PubMed id as digits without leading zeros ('PMID: 0041331138' -> '41331138'); else None."""
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
    """A name compared without case, accents, punctuation or spacing: NFKD, then a-z and 0-9 only."""
    if v is None:
        return None
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", _text(v)).translate(_LOWER)) or None


def url_key(v):
    """A URL without its scheme, a leading www., or a trailing '/', lower-cased."""
    if v is None:
        return None
    return _URL_PREFIX.sub("", _text(v).strip(_WS), count=1).rstrip("/").translate(_LOWER) or None


def title_key(v):
    """A title without markup, by the name rule ('Ca<sup>2+</sup>' = 'Ca[2+]'). Not a key: it pairs a
    preprint with its published version (public.kg_link_publication_versions, kg/quality.py)."""
    return None if v is None else name_key(_TAG.sub("", _text(v)))


def is_preprint(journal, doi) -> bool:
    """Is a paper with this journal and DOI a preprint? By its venue, or by its DOI's prefix."""
    j = _text(journal if journal is not None else "").translate(_LOWER)
    d = doi_key(doi) or ""
    return any(x in j for x in PREPRINT_VENUES) or d.startswith(PREPRINT_DOI_PREFIXES)


def load_spec(path=SPEC) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def check(spec: dict | None = None) -> list[str]:
    """Every way this module disagrees with kg/identity_keys.json: a vector it gets wrong, a function
    the JSON names that is not here, or a preprint list that differs. Empty when they agree."""
    spec = spec if spec is not None else load_spec()
    problems = []
    for name, key in spec["keys"].items():
        fn = globals().get(key.get("py", ""))
        if not callable(fn):
            problems.append(f"{name}: kg/identity_keys.py has no function {key.get('py')!r}")
            continue
        for given, want in key["vectors"]:
            got = fn(*given) if name == "preprint" else fn(given)
            if got != want:
                problems.append(f"{name}: {key['py']}({given!r}) is {got!r}, the vector says {want!r}")
    pre = spec["keys"].get("preprint", {})
    for field, mine in (("venues", PREPRINT_VENUES), ("doi_prefixes", PREPRINT_DOI_PREFIXES)):
        if sorted(pre.get(field, [])) != sorted(mine):
            problems.append(f"preprint {field}: kg/identity_keys.py has {sorted(mine)}, the JSON {sorted(pre.get(field, []))}")
    return problems


if __name__ == "__main__":
    spec = load_spec(sys.argv[1] if len(sys.argv) > 1 else SPEC)
    bad = check(spec)
    n = sum(len(k["vectors"]) for k in spec["keys"].values())
    print("\n".join(bad) if bad else f"kg/identity_keys.py agrees with all {n} vectors")
    sys.exit(1 if bad else 0)
