#!/usr/bin/env python3
"""CI gate for the knowledge graph (build phase 7). Fails on a regression, never on a known gap.

  1. RED   -- every validation shape fires on fixtures/contradictions.ttl, and kg/quality.py
              duplicates() finds there a folded pair for every identifier it checks (an ORCID
              written with x and with X, a DOI with and without its resolver, ...) and an unlinked
              preprint + published pair
  2. GREEN -- fixtures/clean.ttl conforms, holds no possible duplicate and no unlinked pair, and its
              same-title pair linked by revision_of counts as linked
  3. identity -- kg/identity_keys.py gives every vector's `want` in kg/identity_keys.json
  4. export -- no shape fires on the export more often than quality_baseline.json allows,
               and no shape that is quiet in the baseline starts firing
  5. quality -- every competency question answered in the baseline still answers, every shape
               that had data to check still does, and there are no more possible duplicates or
               unlinked preprint + published pairs than the baseline has
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
from quality import BBQS, FOLD, HERE, IDENTIFIERS, KGQuality

BASELINE = HERE / "quality_baseline.json"
RED = HERE / "fixtures" / "contradictions.ttl"
GREEN = HERE / "fixtures" / "clean.ttl"

# RDF lists whose order means nothing: gen-shacl writes sh:ignoredProperties from a set, so the
# order of its members changes from run to run. They are compared as sets.
UNORDERED = {SH.ignoredProperties}
SHOWN = 10                     # differing statements printed for a stale file


def shape_counts(q: KGQuality, severity: str | None = None) -> Counter:
    """Results per shape; severity=None counts warnings too (the RED/GREEN fixtures test both)."""
    return Counter(v["shape"] for vs in q.violations().values() for v in vs
                   if severity is None or v["severity"] == severity)


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


def check_fixture_duplicates(red: KGQuality, green: KGQuality, errors: list[str]):
    """duplicates() bites on RED and is quiet on GREEN. A group is folded when its nodes hold the
    identifier in different spellings that are one key; every identifier needs one, or its fold is
    untested."""
    d = red.duplicates()
    folded = set()
    for grp in d["groups"]:
        by = grp["by"]
        if grp["kind"] == "duplicate" and by in FOLD:
            spellings = {str(o) for n in grp["nodes"] for o in red.graph.objects(URIRef(n), BBQS[by])
                         if FOLD[by](o) == grp["value"]}
            if len(spellings) > 1:
                folded.add(by)
    unfolded = [by for by in IDENTIFIERS if by not in folded]
    if unfolded:
        errors.append(f"RED fixture: duplicates() folds no pair of {', '.join(unfolded)} in contradictions.ttl "
                      "(two nodes with one identifier spelled two ways)")
    if not d["versions"]:
        errors.append("RED fixture: duplicates() finds no unlinked preprint + published pair in contradictions.ttl")
    if not unfolded and d["versions"]:
        print(f"ok  RED fixture: duplicates() folds a pair of each of {len(IDENTIFIERS)} identifiers "
              f"and finds {d['versions']} unlinked preprint + published pair(s)")
    g = green.duplicates()
    if g["count"] or g["versions"]:
        errors.append(f"GREEN fixture: duplicates() finds {g['count']} possible duplicate(s) and {g['versions']} "
                      f"unlinked pair(s) in clean.ttl: {[x for x in g['groups'] if x['kind'] != 'linked_versions']}")
    if not g["linked_versions"]:
        errors.append("GREEN fixture: duplicates() resolves no same-title pair linked by revision_of in clean.ttl")
    if not (g["count"] or g["versions"]) and g["linked_versions"]:
        print(f"ok  GREEN fixture: no possible duplicates, {g['linked_versions']} pair(s) linked by revision_of")


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
    }
    if update_baseline:
        BASELINE.write_text(json.dumps(now, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {BASELINE.name}: {now}")
        return

    errors, improved = [], []
    base = json.loads(BASELINE.read_text(encoding="utf-8"))

    red_q, green_q = KGQuality(RED), KGQuality(GREEN)
    red = shape_counts(red_q)
    silent = sorted(validation_shape_names(q) - set(red))
    if silent:
        errors.append(f"RED fixture: these shapes no longer fire on contradictions.ttl: {', '.join(silent)}")
    else:
        print(f"ok  RED fixture fires all {len(red)} shapes")

    green = shape_counts(green_q)
    if green:
        errors.append(f"GREEN fixture no longer conforms: {dict(green)}")
    else:
        print("ok  GREEN fixture conforms")
    check_fixture_duplicates(red_q, green_q, errors)
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
