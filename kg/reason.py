#!/usr/bin/env python3
"""OWL consistency pass (validation layer 3): run the HermiT DL reasoner over a BBQS KG instance graph.

Usage:
    python kg/reason.py <data.ttl> [more.ttl ...]           # each file must be CONSISTENT
    python kg/reason.py --expect-inconsistent <red.ttl> ...  # each file must be INCONSISTENT (RED proof)

Each data file is reasoned on its own against: bbqs.owl.ttl (generated TBox) + every kg/owl/*.ttl
(hand-written axioms: disjointness). Exit 0 when every file meets the expectation, else 1.

What this catches that SHACL does not: contradictions that only appear after *inference* -- a held_by
edge whose target is a Project (range makes it an Investigator; Investigator is disjoint with
Project), two roles-holders on one ProjectRole (max 1), a literal outside its slot's datatype.

Two adjustments are made before reasoning, both printed:
  * Unique-name assumption. OWL is open-world with no UNA: two held_by values on a max-1 slot make the
    reasoner infer they are the SAME person rather than report a clash. Our spine guarantees one IRI
    per entity (invariant #2), so the data individuals are declared owl:AllDifferent. --no-una skips it.
  * xsd:date -> rdfs:Literal. xsd:date is not in the OWL 2 datatype map and HermiT refuses it outright.

HermiT gives no justification for an inconsistency, so on failure a cheap rdflib pass names the likely
culprits (disjoint types, over-cardinality, datatype mismatch). It is a hint, not a proof.

Requires Java on PATH and:  pip install owlready2 rdflib   (owlready2 bundles the HermiT jar)
"""
import glob
import os
import re
import sys
import tempfile

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS, XSD

HERE = os.path.dirname(os.path.abspath(__file__))
TBOX = [os.path.join(HERE, "bbqs.owl.ttl")] + sorted(glob.glob(os.path.join(HERE, "owl", "*.ttl")))
SCHEMA_NS = "https://brain-bbqs.org/schema#"
NUMERIC = {XSD.integer, XSD.int, XSD.long, XSD.decimal, XSD.float, XSD.double}


def load_tbox():
    t = Graph()
    for f in TBOX:
        t.parse(f, format="turtle")
    return t


def individuals(data):
    """Named individuals of the data graph: typed subjects and object-property targets."""
    inds = set()
    for s, p, o in data:
        if p == RDF.type:
            if isinstance(s, URIRef):
                inds.add(s)
        elif isinstance(o, URIRef) and not str(o).startswith(SCHEMA_NS):
            inds.add(o)
            if isinstance(s, URIRef):
                inds.add(s)
    return sorted(inds)


def prepare(tbox, data, una=True):
    g = Graph()
    g += tbox
    g += data
    for s, p, o in list(g):
        if o == XSD.date:
            g.remove((s, p, o))
            g.add((s, p, RDFS.Literal))
        elif isinstance(o, Literal) and o.datatype == XSD.date:
            g.remove((s, p, o))
            g.add((s, p, Literal(str(o))))
    if una:
        inds = individuals(data)
        if len(inds) > 1:
            node, members = BNode(), BNode()
            g.add((node, RDF.type, OWL.AllDifferent))
            g.add((node, OWL.distinctMembers, members))
            Collection(g, members, inds)
    return g


def hermit(g):
    """-> (consistent: bool, unsatisfiable classes: [str], malformed-literal message or None).

    HermiT aborts (rather than reporting a clash) on a literal outside its datatype's lexical space,
    e.g. prose in an xsd:anyURI slot. That is a contradiction too, so it is returned, not raised.
    """
    import owlready2

    with tempfile.NamedTemporaryFile(suffix=".nt", delete=False) as fh:
        path = fh.name
    try:
        g.serialize(destination=path, format="nt", encoding="utf-8")
        world = owlready2.World()
        onto = world.get_ontology("file://" + path).load(format="ntriples")
        try:
            with onto:
                owlready2.sync_reasoner_hermit(world, infer_property_values=False, debug=0)
        except owlready2.OwlReadyInconsistentOntologyError:
            return False, [], None
        except owlready2.OwlReadyJavaError as e:
            m = re.search(r"MalformedLiteralException: (.*)", str(e))
            if not m:
                raise
            return False, [], m.group(1).strip()
        return True, sorted(str(c.iri) for c in world.inconsistent_classes()), None
    finally:
        os.unlink(path)


# ---- heuristic diagnosis (only runs on an inconsistent graph) ----------------------------------------
def _supers(tbox):
    sup = {c: {c} for c in tbox.subjects(RDF.type, OWL.Class) if isinstance(c, URIRef)}
    changed = True
    while changed:
        changed = False
        for c, s in sup.items():
            for x in list(s):
                for o in tbox.objects(x, RDFS.subClassOf):
                    if isinstance(o, URIRef) and o not in s:
                        s.add(o)
                        changed = True
    return sup


def _disjoint_pairs(tbox):
    pairs = set()
    for a, b in tbox.subject_objects(OWL.disjointWith):
        pairs |= {(a, b), (b, a)}
    for n in tbox.subjects(RDF.type, OWL.AllDisjointClasses):
        ms = list(Collection(tbox, tbox.value(n, OWL.members)))
        pairs |= {(a, b) for a in ms for b in ms if a != b}
    return pairs


def diagnose(tbox, data, limit=15):
    nm = tbox.namespace_manager
    q = lambda x: x.n3(nm) if isinstance(x, URIRef) else repr(str(x))
    sup, disjoint = _supers(tbox), _disjoint_pairs(tbox)
    restr = {}
    for c, ss in sup.items():
        restr[c] = [o for s in ss for o in tbox.objects(s, RDFS.subClassOf) if isinstance(o, BNode)]

    # asserted types + one step of range inference through allValuesFrom
    types = {}
    for s, c in data.subject_objects(RDF.type):
        types.setdefault(s, set()).update(sup.get(c, {c}))
    for s, c in list(data.subject_objects(RDF.type)):
        for r in restr.get(c, []):
            av = tbox.value(r, OWL.allValuesFrom)
            if isinstance(av, URIRef) and not str(av).startswith(str(XSD)):
                for o in data.objects(s, tbox.value(r, OWL.onProperty)):
                    if isinstance(o, URIRef):
                        types.setdefault(o, set()).update(sup.get(av, {av}))

    hits = []
    for ind, ts in types.items():
        clash = sorted({tuple(sorted((a, b))) for a in ts for b in ts if (a, b) in disjoint})
        for a, b in clash[:1]:
            hits.append(f"disjoint types   {q(ind)} is both {q(a)} and {q(b)}")
    for s, c in data.subject_objects(RDF.type):
        for r in restr.get(c, []):
            p = tbox.value(r, OWL.onProperty)
            vals = set(data.objects(s, p))
            mx = tbox.value(r, OWL.maxCardinality)
            if mx is not None and len(vals) > int(mx):
                hits.append(f"cardinality      {q(s)} has {len(vals)} {q(p)} (max {mx})")
            av = tbox.value(r, OWL.allValuesFrom)
            if av is not None and str(av).startswith(str(XSD)) and av != XSD.date:
                for v in vals:
                    dt = (v.datatype or XSD.string) if isinstance(v, Literal) else None
                    if dt != av and not (dt in NUMERIC and av in NUMERIC):
                        hits.append(f"datatype         {q(s)} {q(p)} {v.n3(nm)} "
                                    f"-- schema says {q(av)}")
    hits = sorted(set(hits))
    for h in hits[:limit]:
        print("    " + h)
    if len(hits) > limit:
        print(f"    ... and {len(hits) - limit} more")
    if not hits:
        print("    (no single-step culprit found -- the clash needs deeper inference)")


def main(argv):
    args = argv[1:]
    expect_bad = "--expect-inconsistent" in args
    una = "--no-una" not in args
    files = [a for a in args if not a.startswith("--")]
    if not files:
        sys.exit(__doc__)
    try:
        import owlready2  # noqa: F401
    except ImportError:
        sys.exit("owlready2 is not installed. Run:  pip install owlready2   (and have Java on PATH)")

    tbox = load_tbox()
    print(f"TBox: {', '.join(os.path.relpath(f, HERE) for f in TBOX)}  "
          f"UNA={'on' if una else 'off'}  xsd:date->rdfs:Literal")
    ok = True
    for f in files:
        data = Graph().parse(f, format="turtle")
        consistent, unsat, malformed = hermit(prepare(tbox, data, una))
        verdict = "consistent" if consistent else "INCONSISTENT"
        good = (not consistent) if expect_bad else (consistent and not unsat)
        ok &= good
        print(f"{'ok  ' if good else 'FAIL'} {verdict:<12} {os.path.relpath(f, HERE)}  "
              f"({len(data)} triples)")
        if unsat:
            print(f"    unsatisfiable classes (a TBox bug): {', '.join(unsat)}")
        if malformed:
            print(f"    malformed literal: {malformed}")
        elif not consistent and not expect_bad:
            diagnose(tbox, data)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main(sys.argv)
