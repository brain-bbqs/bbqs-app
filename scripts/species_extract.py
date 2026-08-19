"""Deterministically extract study species from NIH RePORTER abstracts.

Constitution XI: what the abstract STATES verbatim is tier 1 (a human verifies it against the
quoted sentence in one glance). What I would have to INFER is tier 5 and may only be proposed.
This script never blurs the two -- every candidate carries the exact sentence it came from and
the rule that matched, so the tier is a property of the evidence, not of my confidence.

No LLM judgement in here on purpose: regex + a curated genus lexicon, so the same input always
yields the same output and a reviewer can audit the rule rather than trust the extractor.
"""
import json, re, sys
from collections import OrderedDict

# Animal genera that appear in behavioural neuroscience. Used to accept a Latin species name (Genus species) found
# outside parentheses; without a whitelist, "Neural dynamics" and "Aim two" match the shape.
GENERA = {
    "Homo", "Mus", "Rattus", "Macaca", "Callithrix", "Saimiri", "Cebus", "Sapajus", "Papio",
    "Meriones", "Peromyscus", "Microtus", "Mesocricetus", "Cavia", "Oryctolagus", "Mustela",
    "Ovis", "Capra", "Sus", "Bos", "Equus", "Canis", "Felis", "Suricata", "Loxodonta",
    "Tursiops", "Taeniopygia", "Molothrus", "Serinus", "Gallus", "Columba", "Corvus",
    "Melopsittacus", "Danio", "Carassius", "Oreochromis", "Astatotilapia", "Betta",
    "Drosophila", "Caenorhabditis", "Apis", "Bombus", "Hofstenia", "Xenopus", "Ambystoma",
    "Anolis", "Nomascus", "Pan", "Gorilla", "Pongo", "Eublepharis", "Poecilia", "Neolamprologus",
}

# Common name -> (accepted Latin species name, note). Only names that are unambiguous at species level.
# Deliberately conservative: "rodents", "primates", "songbird" map to NOTHING, because a
# category is not a species and pretending otherwise is how "Requires Verification" got written.
COMMON = OrderedDict([
    (r"\bhuman(s|\s+participants|\s+subjects)?\b", ("Homo sapiens", "")),
    (r"\bmarmoset(s)?\b", ("Callithrix jacchus", "common marmoset assumed")),
    (r"\bhouse\s+mice\b|\bhouse\s+mouse\b", ("Mus musculus", "")),
    (r"\bmouse\b|\bmice\b", ("Mus musculus", "lab mouse assumed")),
    (r"\bMongolian\s+gerbil(s)?\b", ("Meriones unguiculatus", "")),
    (r"\bgerbil(s)?\b", ("Meriones unguiculatus", "species assumed from genus")),
    (r"\bzebra\s*finch(es)?\b", ("Taeniopygia guttata", "")),
    (r"\bbrown-headed\s+cowbird(s)?\b", ("Molothrus ater", "")),
    (r"\bferret(s)?\b", ("Mustela putorius furo", "domestic ferret; subspecies is the accepted name")),
    (r"\bsheep\b", ("Ovis aries", "domestic sheep")),
    (r"\bzebrafish\b", ("Danio rerio", "")),
    (r"\bfruit\s*fl(y|ies)\b", ("Drosophila melanogaster", "species assumed")),
    (r"\bpanther\s+worm(s)?\b", ("Hofstenia miamia", "")),
    (r"\bmeerkat(s)?\b", ("Suricata suricatta", "")),
    (r"\bNorway\s+rat(s)?\b", ("Rattus norvegicus", "")),
    (r"\brat(s)?\b", ("Rattus norvegicus", "lab rat assumed")),
])

# Category words that are NOT species. Recorded so a reviewer can see the abstract only ever
# spoke in categories, rather than seeing an empty result and assuming extraction failed.
CATEGORY = re.compile(
    r"\b(rodents?|primates?|non-?human primates?|songbirds?|birds?|fish(es)?|mammals?|"
    r"vertebrates?|invertebrates?|animals?|insects?|cichlids?)\b", re.I)

SENT = re.compile(r"(?<=[.!?])\s+")


def sentences(text):
    return [s.strip() for s in SENT.split(re.sub(r"\s+", " ", text)) if s.strip()]


def find_parenthetical(text):
    """common name (Genus species) -- the strongest signal an abstract can give."""
    out = []
    for m in re.finditer(r"\(\s*([A-Z][a-z]{2,})\s+([a-z]{3,})(?:\s+([a-z]{3,}))?\s*\)", text):
        genus, sp, sub = m.group(1), m.group(2), m.group(3)
        if genus not in GENERA:
            continue
        name = f"{genus} {sp}" + (f" {sub}" if sub else "")
        out.append((name, m.group(0)))
    return out


# A whitelisted genus followed by any lowercase word is NOT enough: "Hofstenia diverged from
# models such as flies" and "the Hofstenia brain can regenerate" both match that shape, and the
# first version of this script duly reported them as species. An epithet is not an English word
# and is not an inflected verb, so reject both.
NOT_EPITHET = {
    "brain", "brains", "model", "models", "study", "studies", "data", "behavior", "behaviour",
    "neurons", "circuits", "colony", "colonies", "populations", "population", "genome", "larvae",
    "adults", "pups", "cage", "cages", "social", "group", "groups", "and", "are", "was", "were",
    "has", "have", "will", "can", "may", "also", "which", "that", "than", "from", "with", "into",
    "using", "under", "over", "after", "before", "during", "between", "within", "across",
}
INFLECTED = re.compile(r"(ed|ing|ly|tion|ment|ness|ance|ence)$")


def find_bare(text):
    """A Latin species name stated without parentheses, accepted only for a whitelisted genus AND an
    epithet that could actually be one."""
    out = []
    for m in re.finditer(r"\b([A-Z][a-z]{2,})\s+([a-z]{4,})\b", text):
        genus, ep = m.group(1), m.group(2)
        if genus not in GENERA:
            continue
        if ep in NOT_EPITHET or INFLECTED.search(ep):
            continue
        out.append((f"{genus} {ep}", m.group(0)))
    return out


def quote_for(text, needle):
    for s in sentences(text):
        if needle.lower() in s.lower():
            return s if len(s) <= 260 else s[:257] + "..."
    return ""


def analyse(grant, abstract, title):
    blob = f"{title}. {abstract}"
    verbatim, seen = [], set()
    for name, matched in find_parenthetical(blob) + find_bare(blob):
        if name in seen:
            continue
        seen.add(name)
        verbatim.append({"taxon": name, "matched": matched, "quote": quote_for(blob, matched)})

    inferred = []
    for pat, (taxon, note) in COMMON.items():
        if taxon in seen:
            continue
        m = re.search(pat, blob, re.I)
        if not m:
            continue
        seen.add(taxon)
        inferred.append({"taxon": taxon, "matched": m.group(0), "note": note,
                         "quote": quote_for(blob, m.group(0))})

    cats = sorted({c.group(0).lower() for c in CATEGORY.finditer(blob)})
    return {"grant": grant, "verbatim": verbatim, "inferred": inferred, "categories": cats}


def main(path):
    rows = json.load(open(path, encoding="utf-8"))["data"]
    core = lambda r: re.sub(r"^\d+", "", re.sub(r"-\d+$", "", (r or "").strip().upper()))
    results = [analyse(core(r.get("grantNumber")), r.get("abstract") or "", r.get("title") or "")
               for r in rows]
    json.dump(results, open(sys.argv[2], "w", encoding="utf-8"), indent=1)
    t1 = sum(1 for r in results if r["verbatim"])
    t5 = sum(1 for r in results if not r["verbatim"] and r["inferred"])
    none = sum(1 for r in results if not r["verbatim"] and not r["inferred"])
    print(f"grants                                : {len(results)}")
    print(f"TIER 1  Latin species name in abstract : {t1}")
    print(f"TIER 5  common name only, needs review: {t5}")
    print(f"nothing extractable                   : {none}")


if __name__ == "__main__":
    main(sys.argv[1])
