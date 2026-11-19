#!/usr/bin/env python3
"""CI gate for the knowledge graph (build phase 7). Fails on a regression, never on a known gap.

  1. RED   -- on fixtures/contradictions.ttl each validation shape reports exactly the focus nodes
              and values planted for it, kg/quality.py duplicates() exactly the groups planted
              (each with its kind: a folded pair for every identifier it checks, an ORCID written
              with x and with X, a DOI with and without its resolver, ...; unlinked preprint +
              published pairs; same-title groups a link must not resolve), and revision_links()
              exactly the links planted (RED_EXPECTED below). "Fires at least once" is not enough:
              a shape keyed on the wrong slot still fires, on another shape's pair.
  2. GREEN -- fixtures/clean.ttl conforms, holds no possible duplicate, no unlinked pair and no
              revision_of to check; its same-title pairs linked by revision_of count as linked and
              its records that share only a URL as advisory (GREEN_EXPECTED)
  3. identity -- kg/identity_keys.py gives every vector's `want` in kg/identity_keys.json
  4. export -- no shape fires on the export more often than quality_baseline.json allows,
               and no shape that is quiet in the baseline starts firing
  5. quality -- every competency question answered in the baseline still answers, every shape
               that had data to check still does, and there are no more possible duplicates,
               unlinked preprint + published pairs, same-title versions to check (a link from the
               preprint, a preprint later than its paper), or revision_of links to check (reversed,
               or between two titles) than the baseline has. Each says what a curator does: a
               duplicate is merged; a preprint and its paper are linked or corrected, never merged
  6. generated (--check-generated, needs linkml) -- bbqs.owl.ttl and bbqs.shapes.gen.ttl say what
               gen-owl / gen-shacl produce from bbqs.linkml.yaml today, statement for statement,
               blank nodes included (an owl:hasKey list, an OWL restriction, a SHACL property shape)

    python kg/ci_check.py [--export PATH] [--check-generated]
    python kg/ci_check.py --update-baseline     # after a real improvement; commit the new baseline

An improvement (fewer violations, more answers) passes and prints a reminder to update the
baseline, so the gate tightens as the graph gets better.
"""
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

import click
from rdflib import BNode, Graph, URIRef
from rdflib.collection import Collection
from rdflib.namespace import RDF, SH

import identity_keys
from quality import BBQS, BID, FOLD, HERE, IDENTIFIERS, KGQuality, folded

BASELINE = HERE / "quality_baseline.json"
RED = HERE / "fixtures" / "contradictions.ttl"
GREEN = HERE / "fixtures" / "clean.ttl"

# RDF lists whose order means nothing: gen-shacl writes sh:ignoredProperties from a set, so the
# order of its members changes from run to run. They are compared as sets.
UNORDERED = {SH.ignoredProperties}
SHOWN = 10                     # differing statements printed for a stale file

# The identifiers duplicates() must compare, each with a folded pair in the RED fixture. Pinned here
# so that dropping one from quality.py IDENTIFIERS fails the gate instead of shrinking the check.
REQUIRED_IDENTIFIERS = ("orcid", "doi", "pmid", "fon", "grant_number", "url", "external_url", "repo_url")

# What the fixtures must report, node for node: bid: local names, values as the shape reports them
# (a bbqs: class as bbqs:<Name>). Edit these by hand with the fixture, never from a run's output:
# each entry is the one result its planted case exists for. A shape keyed on the wrong slot, a
# branch of a shape removed, or a rule of version_kind() loosened changes a row here.
RED_EXPECTED = {
    "shapes": {
        "AuthorOrcidResolvesShape": {("pub-1", "pub-1")},
        "AwardUniquePerProjectShape": {("proj-a", "proj-b")},
        "ConflictingVerifiedProvenanceShape": {("prov-a", "prov-a")},
        "ConsortiumRoleNotAProjectRoleShape": {("inv-pi-label", "Principal Investigator (PI)"), ("inv-token", "postdoc")},
        "DoiUniquePerPublicationShape": {("pub-doi-a", "pub-doi-b")},
        "EmailUniquePerPersonShape": {("inv-email-a", "inv-email-a")},
        "FonUniquePerCallShape": {("fo-a", "fo-b")},
        "GradedProvenancePrecedenceShape": {("prov-c", "prov-c")},
        "HeldByResolvesShape": {("role-dangling", "ghost-investigator"), ("role-two", "")},
        "MechanismMatchesGrantNumberShape": {("proj-1", "proj-1")},
        "NodeHasProvenanceShape": {("proj-a", "proj-a"), ("proj-b", "proj-b"), ("proj-award-a", "proj-award-a"),
                                   ("proj-award-b", "proj-award-b"), ("proj-no-prov", "proj-no-prov")},
        "OneClassPerNodeShape": {("dual-1", "bbqs:ResearchOrganization")},
        "OneRolePerPersonPerGrantShape": {("role-1", "role-1")},
        "OrcidUniquePerPersonShape": {("inv-dup-a", "inv-dup-b")},
        "PmidUniquePerPublicationShape": {("pub-pmid-a", "pub-pmid-b")},
        "ProjectIdentifiersAgreeShape": {("proj-renumbered", "U24MH136628")},
        "ProjectIsAnAwardShape": {("proj-no-award", "")},
        "ProjectRoleTokenShape": {("role-1", "Principal Investigator")},
        # #25, one row per branch: an object that is no Publication, a subject that is none, a link
        # to itself, a link both ways (both ends report it)
        "RevisionOfLinksTwoPublicationsShape": {("pub-rev-a", "ds-rev"), ("ds-rev-subject", "pub-rev-target"),
                                                ("pub-rev-self", "pub-rev-self"), ("pub-rev-x", "pub-rev-y"),
                                                ("pub-rev-y", "pub-rev-x")},
        "StudiesSpeciesResolvesShape": {("proj-1", "Freely moving animals")},
        "UrlFieldsAreUrlsShape": {("job-1", "https://jobs.example.org/one ; https://jobs.example.org/two")},
    },
    # (by, kind, nodes) for every group duplicates() reports
    "groups": {
        ("orcid", "duplicate", ("inv-dup-a", "inv-dup-b")),
        ("orcid", "duplicate", ("inv-orcid-X", "inv-orcid-x")),
        ("doi", "duplicate", ("pub-doi-a", "pub-doi-b")),
        ("doi", "duplicate", ("pub-doi-c", "pub-doi-d")),
        ("doi", "duplicate", ("pub-doi-e", "pub-doi-f")),          # unreadable, compared as written
        ("doi", "duplicate", ("pub-doi-g", "pub-doi-h")),          # doi.org/ and www.doi.org/
        ("doi", "duplicate", ("pub-vkd-paper", "pub-vkd-pre1")),
        ("pmid", "duplicate", ("pub-pmid-a", "pub-pmid-b")),
        ("pmid", "duplicate", ("pub-pmid-c", "pub-pmid-d")),
        ("fon", "duplicate", ("fo-a", "fo-b")),
        ("fon", "duplicate", ("fo-c", "fo-d")),
        ("grant_number", "duplicate", ("proj-a", "proj-b")),
        ("grant_number", "duplicate", ("proj-award-a", "proj-award-b")),
        ("url", "duplicate", ("fo-e", "fo-f")),                    # a URL with a name match
        ("external_url", "duplicate", ("sw-a", "sw-b")),
        ("repo_url", "duplicate", ("sw-c", "sw-d")),
        ("title", "versions", ("pub-ver-preprint", "pub-ver-published")),
        ("title", "versions", ("pub-lm-paper", "pub-lm-pre")),     # 10.1101/lm... is a journal's DOI
        ("title", "versions", ("pub-alpha-paper", "pub-alpha-pre")),   # by bbqs:title; beta stays out
        ("title", "duplicate", ("pub-vk2-a", "pub-vk2-b", "pub-vk2-pre")),     # two papers, linked
        ("title", "duplicate", ("pub-vk3-a", "pub-vk3-b", "pub-vk3-pre")),     # two papers, unlinked
        ("title", "duplicate", ("pub-vkd-paper", "pub-vkd-pre1", "pub-vkd-pre2")),   # one DOI twice
        ("title", "versions_to_check", ("pub-late-paper", "pub-late-pre")),          # preprint later
        ("title", "versions_to_check", ("pub-wrongway-paper", "pub-wrongway-pre")),  # link from the preprint
        # chronology, one signal each (PubMed id, then the DOI's posting date, then the year):
        ("title", "versions_to_check", ("pub-pmidlate-paper", "pub-pmidlate-pre")),  # PubMed id alone: later
        ("title", "versions", ("pub-drift-paper", "pub-drift-pre")),       # the year alone would say later
        ("title", "versions", ("pub-posted-paper", "pub-posted-pre")),     # the DOI's date, not the year
        ("title", "versions_to_check", ("pub-yearlate-paper", "pub-yearlate-pre")),  # the year alone: later
        ("title", "versions", ("pub-noyear-paper", "pub-noyear-pre")),     # no year, PubMed order kept
    },
    # (subject, object, problems) for every link revision_links() reports
    "revision_links": {
        ("pub-wrongway-pre", "pub-wrongway-paper", ("reversed",)),
        ("pub-other-paper", "pub-other-pre", ("titles_differ",)),
        ("pub-rev-x", "pub-rev-y", ("titles_differ",)),
        ("pub-rev-y", "pub-rev-x", ("titles_differ",)),
    },
}
GREEN_EXPECTED = {
    "shapes": {},
    "groups": {
        ("title", "linked_versions", ("pub-preprint", "pub-published")),
        ("title", "linked_versions", ("pub-lm-preprint", "pub-lm-published")),
        ("title", "linked_versions", ("pub-hand-preprint", "pub-hand-published")),  # linked by hand, PubMed order aside
        ("external_url", "advisory", ("sw-dlc", "sw-dlc-live")),   # one lab homepage, two tools
        ("url", "advisory", ("fo-topic-1", "fo-topic-2")),         # one NIH topic page, two calls
    },
    "revision_links": set(),
}


def compact(value: str) -> str:
    """A node or value as RED_EXPECTED writes it: bid: local name, bbqs: prefix, literal as is."""
    v = str(value)
    if v.startswith(BID):
        return v[len(BID):]
    return "bbqs:" + v[len(str(BBQS)):] if v.startswith(str(BBQS)) else v


def fixture_results(q: KGQuality) -> dict:
    """What a fixture reports, in RED_EXPECTED's form."""
    shapes = {}
    for focus, results in q.violations().items():
        for r in results:
            shapes.setdefault(r["shape"], set()).add((compact(focus), compact(r["value"])))
    groups = {(g["by"], g["kind"], tuple(sorted(compact(n) for n in g["nodes"]))) for g in q.duplicates()["groups"]}
    links = {(compact(r["subject"]), compact(r["object"]), tuple(r["problems"])) for r in q.revision_links()["links"]}
    return {"shapes": shapes, "groups": groups, "revision_links": links}


def compare_fixture(label: str, got: dict, want: dict, errors: list[str]) -> bool:
    """Every difference between what a fixture reports and what it must, one error per section."""
    ok = True
    for shape in sorted(set(got["shapes"]) | set(want["shapes"])):
        have, need = got["shapes"].get(shape, set()), want["shapes"].get(shape, set())
        if have != need:
            ok = False
            errors.append(f"{label} fixture: {shape} reports {sorted(have) or 'nothing'}, it must report "
                          f"{sorted(need) or 'nothing'} (missing {sorted(need - have)}, unexpected {sorted(have - need)})")
    for section in ("groups", "revision_links"):
        missing, unexpected = want[section] - got[section], got[section] - want[section]
        if missing or unexpected:
            ok = False
            errors.append(f"{label} fixture: {'duplicates()' if section == 'groups' else 'revision_links()'} "
                          f"is missing {sorted(missing)} and reports unexpected {sorted(unexpected)}")
    return ok


def validation_shape_names(q: KGQuality) -> set[str]:
    return {r["shape"] for r in q.shape_exercise()}


def statements(graph: Graph) -> Counter:
    """Every triple whose subject is not a blank node, each blank-node object written out in full
    (a restriction, an RDF list, a property shape), so two files that say the same thing compare
    equal whatever labels or order the serializer gave their blank nodes; a blank node no named
    subject reaches is written out on its own. Generated OWL and SHACL hang trees of blank nodes off
    named terms, so this is exact for them, and quick, where isomorphism is too slow. Triple counts
    and the triples without a blank node were compared before, which missed a key that names
    another slot: owl:hasKey ( bbqs:orcid ) and ( bbqs:scholar_id ) differ only inside a list."""
    nm = graph.namespace_manager
    memo = {}

    def term(t):
        if isinstance(t, BNode):
            return node(t)
        try:
            return t.n3(nm)
        except Exception:                      # a term the namespace manager cannot shorten
            return t.n3()

    def node(b):
        if b in memo:
            return memo[b]
        memo[b] = "[ <cycle> ]"
        if (b, RDF.first, None) in graph:
            items = [term(x) for x in Collection(graph, b)]
            if any(p in UNORDERED for _s, p in graph.subject_predicates(b)):
                items.sort()
            text = "( " + " ".join(items) + " )"
        else:
            text = "[ " + " ; ".join(sorted(f"{term(p)} {term(o)}" for p, o in graph.predicate_objects(b))) + " ]"
        memo[b] = text
        return text

    out = Counter(f"{term(s)} {term(p)} {term(o)}" for s, p, o in graph if not isinstance(s, BNode))
    reached, stack = set(), [o for s, _p, o in graph if not isinstance(s, BNode) and isinstance(o, BNode)]
    while stack:
        b = stack.pop()
        if b not in reached:
            reached.add(b)
            stack += [x for x in graph.objects(b, None) if isinstance(x, BNode)]
    for b in {s for s in graph.subjects() if isinstance(s, BNode)} - reached:
        out[f"(unreached) {term(b)}"] += 1
    return out


def generator_error(stderr: str) -> str:
    """What a failed generator said: its line naming the error, or else the end of its output (the
    start is DeprecationWarnings)."""
    named = [line.strip() for line in stderr.splitlines() if "Error" in line]
    return named[-1] if named else stderr.strip()[-600:]


def check_generated_artifacts(errors: list[str], kg_dir: Path = HERE):
    schema = kg_dir / "bbqs.linkml.yaml"
    for tool, committed in [("gen-owl", kg_dir / "bbqs.owl.ttl"), ("gen-shacl", kg_dir / "bbqs.shapes.gen.ttl")]:
        try:
            out = subprocess.run([tool, str(schema)], capture_output=True, text=True, encoding="utf-8")
        except FileNotFoundError:
            errors.append(f"{tool} is not installed: pip install -r kg/requirements-generate.txt")
            continue
        if out.returncode:
            errors.append(f"{tool} failed: {generator_error(out.stderr)}")
            continue
        fresh = statements(Graph().parse(data=out.stdout, format="turtle"))
        have = statements(Graph().parse(str(committed), format="turtle"))
        if fresh == have:
            print(f"ok  {committed.name} matches {tool} ({sum(have.values())} statements)")
            continue
        only_committed, only_fresh = have - fresh, fresh - have
        shown = [f"- {s}" for s in sorted(only_committed)] + [f"+ {s}" for s in sorted(only_fresh)]
        clip = lambda s: s if len(s) <= 220 else s[:217] + "..."
        errors.append(f"{committed.name} is stale: regenerate it with {tool} (see kg/README.md). "
                      f"{sum(only_committed.values())} statement(s) only in the committed file (-), "
                      f"{sum(only_fresh.values())} only in what {tool} writes now (+):"
                      + "".join(f"\n      {clip(s)}" for s in shown[:SHOWN])
                      + (f"\n      ... and {len(shown) - SHOWN} more" if len(shown) > SHOWN else ""))


def check_identity(errors: list[str]):
    """kg/identity_keys.py against every vector of kg/identity_keys.json (the rules the database,
    the write paths and this graph share), and the preprint lists against the JSON's."""
    spec = identity_keys.load_spec()
    problems = identity_keys.check(spec)
    if problems:
        errors.append("identity: kg/identity_keys.py disagrees with kg/identity_keys.json:"
                      + "".join(f"\n      {p}" for p in problems[:SHOWN]))
    else:
        print(f"ok  identity keys: kg/identity_keys.py gives all {sum(len(k['vectors']) for k in spec['keys'].values())} vectors")


def check_fixtures(red: KGQuality, green: KGQuality, errors: list[str]):
    """Each fixture reports exactly what it must (RED_EXPECTED, GREEN_EXPECTED), every validation
    shape has its RED results pinned, and duplicates() folds a pair of every required identifier: a
    group whose nodes hold the identifier in different spellings that are one value."""
    shapes = validation_shape_names(red)
    unpinned = sorted(shapes - set(RED_EXPECTED["shapes"]))
    if unpinned:
        errors.append(f"RED fixture: no expected results for {', '.join(unpinned)}: plant a case for each new "
                      "shape in contradictions.ttl and pin what it must report in ci_check.py RED_EXPECTED")
    dropped = [by for by in REQUIRED_IDENTIFIERS if by not in IDENTIFIERS]
    if dropped:
        errors.append(f"quality.py IDENTIFIERS no longer compares {', '.join(dropped)}")
    red_ok = compare_fixture("RED", fixture_results(red), RED_EXPECTED, errors)
    folds = set()
    for grp in red.duplicates()["groups"]:
        by = grp["by"]
        if grp["kind"] == "duplicate" and by in FOLD:
            spellings = {str(o) for n in grp["nodes"] for o in red.graph.objects(URIRef(n), BBQS[by])
                         if folded(by, o) == grp["value"]}
            if len(spellings) > 1:
                folds.add(by)
    unfolded = [by for by in sorted(set(REQUIRED_IDENTIFIERS) | set(IDENTIFIERS)) if by not in folds]
    if unfolded:
        errors.append(f"RED fixture: duplicates() folds no pair of {', '.join(unfolded)} in contradictions.ttl "
                      "(two nodes with one identifier spelled two ways)")
    if red_ok and not unfolded and not unpinned:
        rr = RED_EXPECTED
        print(f"ok  RED fixture: {len(rr['shapes'])} shapes report their {sum(map(len, rr['shapes'].values()))} planted "
              f"results; duplicates() its {len(rr['groups'])} groups (a folded pair of each of "
              f"{len(REQUIRED_IDENTIFIERS)} identifiers); revision_links() its {len(rr['revision_links'])} links")
    if compare_fixture("GREEN", fixture_results(green), GREEN_EXPECTED, errors):
        gg = GREEN_EXPECTED["groups"]
        print(f"ok  GREEN fixture conforms: no possible duplicate, {sum(k == 'linked_versions' for _b, k, _n in gg)} "
              f"pairs linked by revision_of, {sum(k == 'advisory' for _b, k, _n in gg)} shared URLs advisory, "
              "no revision_of to check")


@click.command()
@click.option("--export", "export_path", type=click.Path(exists=True, dir_okay=False, path_type=Path),
              default=KGQuality.DEFAULT_DATA, show_default=True)
@click.option("--check-generated", is_flag=True, help="Also regenerate OWL/SHACL and compare (needs linkml).")
@click.option("--update-baseline", is_flag=True, help="Write the export's current numbers as the new baseline.")
def main(export_path, check_generated, update_baseline):
    """Fail if the KG regressed against kg/quality_baseline.json."""
    q = KGQuality(export_path)
    report = q.report()
    now = {
        "violations": dict(sorted(Counter(v["shape"] for e in report["entities"] for v in e["violations"]
                                          if v["severity"] == "violation").items())),
        "warnings": dict(sorted(Counter(v["shape"] for e in report["entities"] for v in e["violations"]
                                        if v["severity"] == "warning").items())),
        # A "which X has no Y" question (reads: absence) answers whether it lists some X or none.
        "answered": sorted(c["id"] for c in report["competency"] if c["status"] in ("answered", "none")),
        "exercised": sorted(s["shape"] for s in report["shapes"] if s["exercised"]),
        "isolated": report["structure"]["isolated"],
        "nodes": report["structure"]["nodes"],
        # Groups of same-class nodes sharing a name or identifier (kg/quality.py duplicates()).
        "duplicates": report["duplicates"]["count"],
        # Preprint + published pairs with one title and no revision_of link between them yet.
        "versions": report["duplicates"]["versions"],
        # Such pairs whose link runs from the preprint, or whose preprint is later than its paper.
        "versions_to_check": report["duplicates"]["versions_to_check"],
        # revision_of links the pairing rule never makes: from a preprint, or between two titles.
        "revision_links": report["revision_links"]["count"],
    }
    if update_baseline:
        BASELINE.write_text(json.dumps(now, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {BASELINE.name}: {now}")
        return

    errors, improved = [], []
    base = json.loads(BASELINE.read_text(encoding="utf-8"))

    red_q, green_q = KGQuality(RED), KGQuality(GREEN)
    check_fixtures(red_q, green_q, errors)
    check_identity(errors)

    for shape, n in sorted(now["violations"].items()):
        allowed = base["violations"].get(shape, 0)
        if n > allowed:
            errors.append(f"export: {shape} fires {n}x (baseline {allowed})")
    for shape, allowed in base["violations"].items():
        if now["violations"].get(shape, 0) < allowed:
            improved.append(f"{shape} {allowed} -> {now['violations'].get(shape, 0)}")
    print(f"{'ok ' if not any(e.startswith('export') for e in errors) else 'BAD'} export violations: {now['violations']}")
    print(f"--  export warnings (reported, not gated): {now['warnings']}")

    for key, label in [("answered", "competency questions answered"), ("exercised", "shapes with data to check")]:
        lost = sorted(set(base[key]) - set(now[key]))
        gained = sorted(set(now[key]) - set(base[key]))
        if lost:
            errors.append(f"quality: {label} lost: {', '.join(lost)}")
        if gained:
            improved.append(f"{label} gained: {', '.join(gained)}")
        print(f"{'ok ' if not lost else 'BAD'} {label}: {len(now[key])} (baseline {len(base[key])})")
    print(f"--  isolated nodes: {now['isolated']} of {now['nodes']} (baseline {base['isolated']} of {base['nodes']})")
    # A duplicate is stopped when it arrives, not cleaned later: more groups than the baseline fails.
    if "duplicates" in base:
        if now["duplicates"] > base["duplicates"]:
            errors.append(f"quality: possible duplicates rose to {now['duplicates']} groups (baseline {base['duplicates']}); "
                          "merge them in the database, or fix the write path that made them")
        elif now["duplicates"] < base["duplicates"]:
            improved.append(f"possible duplicates {base['duplicates']} -> {now['duplicates']}")
        print(f"{'ok ' if now['duplicates'] <= base['duplicates'] else 'BAD'} possible duplicates: {now['duplicates']} groups (baseline {base['duplicates']})")
    # A preprint and its published version are linked (revision_of), never merged and never left apart.
    if "versions" in base:
        if now["versions"] > base["versions"]:
            errors.append(f"quality: unlinked preprint + published pairs rose to {now['versions']} (baseline {base['versions']}); "
                          "link each with revision_of (public.kg_link_publication_versions, which the importer runs), "
                          "or merge the duplicate that keeps it from pairing")
        elif now["versions"] < base["versions"]:
            improved.append(f"unlinked preprint + published pairs {base['versions']} -> {now['versions']}")
        print(f"{'ok ' if now['versions'] <= base['versions'] else 'BAD'} unlinked preprint + published pairs: "
              f"{now['versions']} (baseline {base['versions']}); {report['duplicates']['linked_versions']} linked")
    # A preprint and its paper whose link or order is wrong: a link or a value to correct, never a merge.
    allowed = base.get("versions_to_check", 0)
    if now["versions_to_check"] > allowed:
        groups = [g for g in report["duplicates"]["groups"] if g["kind"] == "versions_to_check"]
        errors.append(f"quality: same-title preprint + published records to check rose to {now['versions_to_check']} "
                      f"(baseline {allowed}): " + "; ".join(", ".join(g["nodes"]) for g in groups[:SHOWN])
                      + ". A preprint and its paper are two records of one work: never merge them. Correct the link "
                      "(revision_of runs from the published paper to its preprint), or the record whose PMID, DOI or "
                      "year is wrong; a preprint PubMed added after its paper (or posted later, by its DOI) may be "
                      "another work with the same title")
    elif now["versions_to_check"] < allowed:
        improved.append(f"same-title versions to check {allowed} -> {now['versions_to_check']}")
    print(f"{'ok ' if now['versions_to_check'] <= allowed else 'BAD'} same-title versions to check (a link from the "
          f"preprint, or a preprint later than its paper): {now['versions_to_check']} (baseline {allowed})")
    # A version link runs from the published paper to its preprint, between two records of one title.
    allowed = base.get("revision_links", 0)
    if now["revision_links"] > allowed:
        errors.append(f"quality: revision_of links to check rose to {now['revision_links']} (baseline {allowed}): "
                      + "; ".join(f"{r['subject']} -> {r['object']} ({', '.join(r['problems'])})"
                                  for r in report["revision_links"]["links"][:SHOWN])
                      + ". Correct or delete each in resource_links: a published paper revises its preprint, of the same title")
    elif now["revision_links"] < allowed:
        improved.append(f"revision_of links to check {allowed} -> {now['revision_links']}")
    print(f"{'ok ' if now['revision_links'] <= allowed else 'BAD'} revision_of links to check (reversed, or two titles): "
          f"{now['revision_links']} (baseline {allowed}); shared URL only (advisory, not gated): "
          f"{report['duplicates'].get('advisory', 0)}")

    if check_generated:
        check_generated_artifacts(errors)

    if improved:
        print("\nImproved on the baseline -- run `python kg/ci_check.py --update-baseline` and commit it:")
        for i in improved:
            print(f"  {i}")
    if errors:
        print("\nKG gate FAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("\nKG gate passed.")


if __name__ == "__main__":
    main()
