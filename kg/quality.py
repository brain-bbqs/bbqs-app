#!/usr/bin/env python3
"""Evaluate the quality of an exported BBQS graph, and build the entity browser from the result.

Four measurements, one report:

  structure   -- nodes/edges per class, connected components, isolated nodes, dangling IRIs, and the
                 class->predicate->class edge matrix (which links actually exist)
  competency  -- runs kg/competency_questions.yaml; each question is answered / empty / n/a / unmodeled
                 (or "none" for a question that asks what is missing, when nothing is). A file of
                 questions proposed but not adopted yet, competency_questions_proposed.yaml, is run too
                 when there is one, for the Inspector only: the gate (ci_check.py) scores the adopted file
  shapes      -- per SHACL validation shape: how many nodes it targets, and whether the data even contains
                 the terms it checks (a shape whose inputs are absent passes vacuously)
  violations  -- the SHACL results, keyed by focus node, so each entity card can show its own

and, for the Publications tab, each paper's tie to the grant it came from (publications()).

    python kg/quality.py                        # kg/export/bbqs.ttl, anon
    python kg/quality.py data.ttl --access full
    # writes kg/export/quality.json and kg/browser/index.html (self-contained, open it directly)

The artifact build can also carry the working-group meeting records (kg/meetings.py), which are
internal: `--internal` embeds them in the `--fragment` only, written outside the repository, and
never in --html or --json, which the public site and the repo carry.

    python kg/quality.py --fragment /elsewhere/inspector.html --internal /elsewhere/meetings.json

Requires rdflib, pyshacl, PyYAML, click (all in kg/.venv).
"""
import json
import os
import re
import subprocess
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import click
import yaml
from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF, SH

from identity_keys import award_key, doi_key, fon_key, orcid_key, pmid_key, preprint_is_later, title_key, url_key
from identity_keys import is_preprint as preprint_by

HERE = Path(__file__).resolve().parent
BBQS = Namespace("https://brain-bbqs.org/schema#")
BID = "https://brain-bbqs.org/id/"

LABEL_PREDICATES = ("name", "title", "label", "common_name", "model_name")
# The identifiers duplicates() compares, each folded by its rule in kg/identity_keys.py: the rule the
# database's uq_* indexes and the write paths use for the same key, so one decision is made one way
# everywhere. fon, grant_number and url (a funding call's notice page) joined on 2026-11-17.
IDENTIFIERS = ("orcid", "doi", "pmid", "fon", "grant_number", "url", "external_url", "repo_url")
FOLD = {
    "orcid": orcid_key,
    "doi": doi_key,
    "pmid": pmid_key,
    "fon": fon_key,
    "grant_number": award_key,
    "url": url_key,
    "external_url": url_key,
    "repo_url": url_key,
}
URLS = {"url", "external_url", "repo_url"}
# Where a shared URL is worth a look: these classes' URLs are usually their own page; jobs and
# announcements share programme pages. Even here a URL is no identity (a lab's homepage serves
# several tools, an NIH topic page lists several calls), so a URL group counts as a duplicate only
# when its records have one name as well; otherwise it is "advisory": listed, not counted.
URL_IDENTIFIES = {"SoftwareTool", "MLModel", "Dataset", "Benchmark", "Protocol", "Standard", "Device",
                  "DeviceManufacturer", "FundingOpportunity", "ResearchOrganization"}
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def folded(by: str, value):
    """An identifier as duplicates() compares it: by its kg/identity_keys.py rule, or, when the rule
    cannot read it (a DOI with a space inside, 'PMID 123 (corrected)'), as written: trimmed of ASCII
    whitespace and ASCII lower-cased. Two equal spellings of an unreadable value are still one value,
    as they were before the rules were strict; such a fold never equals a rule's key, since a value
    that folds to a valid key is one the rule reads."""
    key = FOLD[by](value)
    if key:
        return key
    return str(value).strip(" \t\n\v\f\r").translate(_ASCII_LOWER) or None


def fold_label(text) -> str:
    """A name with markup, case, accents, punctuation and spacing folded away, as publications() compares
    titles: "Bijan  Pesaran" = "Bijan Pesaran", "Ca<sup>2+</sup>" = "Ca[2+]"."""
    s = unicodedata.normalize("NFKD", re.sub(r"<[^>]+>", "", str(text or "")))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", "", s.casefold())


def first_last(text) -> str:
    """A person's first and last name, without middle names or initials: "AVNIEL S GHUMAN" = "Avniel Ghuman"."""
    parts = [p for p in re.split(r"[\s,]+", unicodedata.normalize("NFKD", str(text or "")).casefold()) if p]
    parts = ["".join(c for c in p if c.isalnum()) for p in parts]
    parts = [p for p in parts if p]
    return f"{parts[0]} {parts[-1]}" if len(parts) >= 2 else ""


def is_preprint(g, node) -> bool:
    """A preprint by its venue or its DOI's prefix: kg/identity_keys.py's rule, which
    public.kg_is_preprint applies when it pairs a preprint with its published version."""
    journals = [str(o) for o in g.objects(node, BBQS.journal)] or [None]
    dois = [str(o) for o in g.objects(node, BBQS.doi)] or [None]
    return any(preprint_by(j, d) for j in journals for d in dois)


ROW_LIMIT = 25


def shown(path: Path) -> str:
    try:
        return path.resolve().relative_to(HERE.parent).as_posix()
    except ValueError:
        return str(path)


def commit_stamp() -> str:
    """The commit the report was built from; flags uncommitted kg/ edits so a local build can't
    pass for a clean one."""
    sha = os.environ.get("GITHUB_SHA", "")
    if sha:
        return sha[:8]
    try:
        sha = subprocess.run(["git", "rev-parse", "--short=8", "HEAD"], cwd=HERE, capture_output=True,
                             text=True, check=True).stdout.strip()
        # The report's own outputs don't count: rebuilding them is what dirties them.
        dirty = subprocess.run(["git", "status", "--porcelain", "--", ".", ":!browser/index.html",
                                ":!export/quality.json"], cwd=HERE, capture_output=True,
                               text=True).stdout.strip()
        return f"{sha} + uncommitted kg/ changes" if dirty else sha
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def local(term) -> str:
    s = str(term)
    return s.rsplit("#", 1)[-1] if "#" in s else s.rsplit("/", 1)[-1]


def inside_repo(path: Path) -> bool:
    try:
        Path(path).resolve().relative_to(HERE.parent)
        return True
    except ValueError:
        return False


def bare_orcid(value) -> str:
    """An ORCID as its 16-character id, however it was written (IRI, URL or bare): the ORCID key."""
    return orcid_key(value) or str(value).strip()


_TRANSLIT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "ae", "Ö": "oe", "Ü": "ue", "ß": "ss"})


def fold_name(name) -> str:
    """A person's name for matching only: case, accents, dots, spacing and any (note) ignored, so
    "Jürgen Müller" = "Juergen Mueller" and "Ann  Lee" = "Ann Lee"."""
    text = re.sub(r"\(.*?\)", " ", str(name).translate(_TRANSLIT))
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return " ".join(text.replace(".", " ").casefold().split())


# First-name forms the meeting notes use that are not a prefix of the name the graph holds.
NAME_FORMS = {"joe": "joseph", "liz": "elizabeth", "lizzy": "elizabeth"}


class KGQuality:
    DEFAULT_DATA = HERE / "export" / "bbqs.ttl"
    DEFAULT_TBOX = HERE / "bbqs.owl.ttl"
    DEFAULT_CQS = HERE / "competency_questions.yaml"
    DEFAULT_CQS_PROPOSED = HERE / "competency_questions_proposed.yaml"   # none today: #441's were adopted
    DEFAULT_SHAPES_DIR = HERE / "shapes"
    DEFAULT_JSON = HERE / "export" / "quality.json"
    DEFAULT_HTML = HERE / "browser" / "index.html"
    TEMPLATE = HERE / "browser" / "template.html"

    def __init__(self, data_file=None, access="anon", tbox_file=None, cq_file=None, shape_files=None,
                 source=None, cq_proposed_file=None):
        self.data_file = Path(data_file) if data_file else self.DEFAULT_DATA
        self.access = access
        self.source = source or shown(self.data_file)
        self.graph = Graph().parse(str(self.data_file), format="turtle")
        self.tbox = Graph().parse(str(tbox_file or self.DEFAULT_TBOX), format="turtle")
        self.cq_file = Path(cq_file) if cq_file else self.DEFAULT_CQS
        self.cq_proposed_file = Path(cq_proposed_file) if cq_proposed_file else self.DEFAULT_CQS_PROPOSED
        self.shape_files = [Path(s) for s in shape_files] if shape_files else sorted(
            self.DEFAULT_SHAPES_DIR.glob("*.ttl"))
        self.shapes = Graph()
        for f in self.shape_files:
            self.shapes.parse(str(f), format="turtle")

        g = self.graph
        self.types = {s: local(o) for s, o in g.subject_objects(RDF.type) if str(o).startswith(str(BBQS))}
        self.tbox_terms = {local(s) for s in self.tbox.subjects() if str(s).startswith(str(BBQS))}

    # ---- structure -------------------------------------------------------------------------------

    def label(self, node) -> str:
        if self.types.get(node) == "Project":
            # resources.name holds the grant number on some projects and the title on others, so
            # label every project the same way from the award facts instead.
            gn = self.graph.value(node, BBQS.grant_number)
            title = self.graph.value(node, BBQS.title) or self.graph.value(node, BBQS.name)
            return f"{gn or 'No grant number'} · {title or local(node)}"
        for p in LABEL_PREDICATES:
            v = self.graph.value(node, BBQS[p])
            if v is not None:
                return str(v)
        if self.types.get(node) == "ProjectRole":
            role = self.graph.value(node, BBQS.project_role)
            proj = self.graph.value(node, BBQS.on_project)
            gn = self.graph.value(proj, BBQS.grant_number) if proj is not None else None
            return f"{role or 'role'} on {gn or '?'}"
        return local(node)

    def edges(self):
        """(s, p, o) for every triple linking two typed nodes -- the graph's actual links."""
        return [(s, p, o) for s, p, o in self.graph
                if p != RDF.type and isinstance(o, URIRef) and s in self.types and o in self.types]

    def structure(self) -> dict:
        g, types = self.graph, self.types
        edges = self.edges()
        degree = Counter()
        out_deg, in_deg = Counter(), Counter()
        matrix = Counter()
        for s, p, o in edges:
            degree[s] += 1
            degree[o] += 1
            out_deg[s] += 1
            in_deg[o] += 1
            matrix[(types[s], local(p), types[o])] += 1

        dangling = Counter()
        for s, p, o in g:
            if p != RDF.type and isinstance(o, URIRef) and str(o).startswith(BID) and o not in types:
                dangling[(types.get(s, "?"), local(p))] += 1

        parent = {n: n for n in types}

        def find(n):
            while parent[n] != n:
                parent[n] = parent[parent[n]]
                n = parent[n]
            return n

        for s, _p, o in edges:
            a, b = find(s), find(o)
            if a != b:
                parent[a] = b
        comp_size = Counter(find(n) for n in types)
        sizes = sorted(comp_size.values(), reverse=True)

        per_class = {}
        for cls in sorted(set(types.values())):
            members = [n for n, c in types.items() if c == cls]
            linked = [n for n in members if degree[n]]
            per_class[cls] = {
                "nodes": len(members),
                "isolated": len(members) - len(linked),
                "mean_degree": round(sum(degree[n] for n in members) / len(members), 2),
                "max_degree": max(degree[n] for n in members),
                "out_edges": sum(out_deg[n] for n in members),
                "in_edges": sum(in_deg[n] for n in members),
            }

        return {
            "triples": len(g),
            "nodes": len(types),
            "edges": len(edges),
            "components": len(sizes),
            "largest_component": sizes[0] if sizes else 0,
            "isolated": sum(1 for n in types if not degree[n]),
            "dangling_refs": [{"from_class": c, "predicate": p, "count": n}
                              for (c, p), n in dangling.most_common()],
            "per_class": per_class,
            "edge_matrix": [{"from": a, "predicate": p, "to": b, "count": n}
                            for (a, p, b), n in matrix.most_common()],
            "_degree": degree,
        }

    # ---- competency questions ---------------------------------------------------------------------

    def competency(self, cq_file=None, question_set="adopted") -> list[dict]:
        """Ask every question in a file. A question with `reads: absence` asks what is missing ("which
        X has no Y"): no rows means nothing is, so it is "none", not "empty"."""
        spec = yaml.safe_load(Path(cq_file or self.cq_file).read_text(encoding="utf-8"))
        prologue = "".join(f"PREFIX {k}: <{v}>\n" for k, v in spec["prefixes"].items())
        results = []
        for q in spec["questions"]:
            terms = sorted(set(re.findall(r"\bbbqs:(\w+)", q["sparql"])))
            unmodeled = [t for t in terms if t not in self.tbox_terms]
            row = {k: q[k] for k in ("id", "area", "question", "access")}
            row.update({"set": question_set, "reads": q.get("reads", "rows"),
                        "sparql": q["sparql"].strip(), "terms": terms, "unmodeled": unmodeled,
                        "columns": [], "rows": [], "row_count": 0})
            if not unmodeled:
                res = self.graph.query(prologue + q["sparql"])
                row["columns"] = [str(v) for v in res.vars]
                all_rows = [[None if v is None else str(v) for v in r] for r in res]
                row["row_count"] = len(all_rows)
                row["rows"] = all_rows[:ROW_LIMIT]
            if unmodeled:
                row["status"] = "unmodeled"
            elif row["row_count"] >= q.get("min_rows", 1):
                row["status"] = "answered"
            elif q["access"] == "full" and self.access == "anon":
                row["status"] = "n/a"
            elif q.get("reads") == "absence":
                row["status"] = "none"
            else:
                row["status"] = "empty"
            results.append(row)
        return results

    def competency_proposed(self) -> list[dict]:
        """Questions proposed but not adopted yet, if there is such a file: shown, not counted by the gate."""
        return self.competency(self.cq_proposed_file, "proposed") if self.cq_proposed_file.exists() else []

    # ---- SHACL validation shapes: exercise + violations --------------------------------------------

    def _present(self, term: str) -> bool:
        """Is bbqs:<term> in the data -- as a predicate, or (capitalised) as an instantiated class?

        A heuristic: a term used only inside FILTER NOT EXISTS (e.g. #7's Species lookup) fires the
        shape when absent rather than silencing it, so a missing input is a warning, not proof."""
        if term[:1].isupper():
            return any(True for _ in self.graph.subjects(RDF.type, BBQS[term]))
        return any(True for _ in self.graph.triples((None, BBQS[term], None)))

    def shape_exercise(self) -> list[dict]:
        sg = self.shapes
        out = []
        for shape in sorted(sg.subjects(RDF.type, SH.NodeShape), key=str):
            if isinstance(shape, BNode):
                continue
            target = sg.value(shape, SH.targetClass)
            subjects_of = sorted(sg.objects(shape, SH.targetSubjectsOf), key=str)
            if target is not None:
                targets = sum(1 for _ in self.graph.subjects(RDF.type, target))
            else:
                targets = len({s for p in subjects_of for s in self.graph.subjects(p, None)})
            paths = set()
            for ps in sg.objects(shape, SH.property):
                path = sg.value(ps, SH.path)
                if path is not None and str(path).startswith(str(BBQS)):
                    paths.add(local(path))
            # Each constraint stands alone: a shape is checking something when one property path is
            # present, or one SPARQL constraint has every term it names.
            queries = [set(re.findall(r"\bbbqs:(\w+)", str(sg.value(sp, SH.select) or "")))
                       for sp in sg.objects(shape, SH.sparql)]
            terms = paths.union(*queries)
            missing = sorted(t for t in terms if not self._present(t))
            # A shape marked bbqs:readsAbsence passes by finding nothing (an unresolved claim, say), so
            # an absent input there is the good outcome, not a vacuous check.
            absence = (shape, BBQS["readsAbsence"], Literal(True)) in sg
            checking = (absence or any(self._present(t) for t in paths)
                        or any(all(self._present(t) for t in q) for q in queries))
            out.append({
                "shape": local(shape),
                "target_class": local(target) if target is not None else (
                    "subjects of " + ", ".join(local(p) for p in subjects_of) if subjects_of else None),
                "targets": targets,
                "checks": sorted(terms),
                "missing_inputs": missing,
                "exercised": bool(targets) and checking,
            })
        return out

    def violations(self) -> dict:
        from pyshacl import validate as shacl_validate

        _conforms, results, _text = shacl_validate(
            self.graph, shacl_graph=self.shapes, advanced=True, inference="none")
        owner = {ps: ns for ns, ps in self.shapes.subject_objects(SH.property)}
        by_node = defaultdict(list)
        for r in results.subjects(RDF.type, SH.ValidationResult):
            focus = results.value(r, SH.focusNode)
            shape = results.value(r, SH.sourceShape)
            shape = owner.get(shape, shape)
            by_node[str(focus)].append({
                "shape": local(shape) if not isinstance(shape, BNode) else "property shape",
                "message": str(results.value(r, SH.resultMessage) or ""),
                "value": str(results.value(r, SH.value) or ""),
                "severity": "warning" if results.value(r, SH.resultSeverity) != SH.Violation else "violation",
            })
        return dict(by_node)

    # ---- entity cards ------------------------------------------------------------------------------

    def entities(self, degree: Counter, violations: dict) -> list[dict]:
        g = self.graph
        incoming = defaultdict(list)
        for s, p, o in self.edges():
            incoming[o].append((local(p), s))
        dangling_out = defaultdict(list)
        for s, p, o in g:
            if p != RDF.type and isinstance(o, URIRef) and str(o).startswith(BID) and o not in self.types:
                dangling_out[s].append({"predicate": local(p), "target": str(o)})

        dupes = defaultdict(list)
        for d in self.duplicates()["groups"]:
            if d["kind"] != "duplicate":
                continue
            for n in d["nodes"]:
                dupes[URIRef(n)].append({"by": d["by"], "value": d["value"], "others": [o for o in d["nodes"] if o != n]})
        cards = []
        for node, cls in sorted(self.types.items(), key=lambda kv: (kv[1], self.label(kv[0]).lower())):
            facts, links = defaultdict(list), []
            for p, o in g.predicate_objects(node):
                if p == RDF.type:
                    continue
                if isinstance(o, URIRef) and o in self.types:
                    links.append({"predicate": local(p), "target": str(o)})
                elif isinstance(o, URIRef) and str(o).startswith(BID):
                    continue
                else:
                    facts[local(p)].append(str(o))
            flags = []
            if not degree[node]:
                flags.append("isolated")
            if dangling_out[node]:
                flags.append("dangling")
            severities = {v["severity"] for v in violations.get(str(node), [])}
            flags += [s for s in ("violation", "warning") if s in severities]
            if dupes.get(node):
                flags.append("duplicate")
            cards.append({
                "id": str(node),
                "class": cls,
                "label": self.label(node),
                "facts": dict(sorted(facts.items())),
                "out": sorted(links, key=lambda l: l["predicate"]),
                "in": sorted(({"predicate": p, "source": str(s)} for p, s in incoming[node]),
                             key=lambda l: l["predicate"]),
                "dangling": dangling_out[node],
                "degree": degree[node],
                "flags": flags,
                "violations": violations.get(str(node), []),
                **({"duplicates": dupes[node]} if dupes.get(node) else {}),
            })
        return cards

    # ---- possible duplicates -----------------------------------------------------------------------

    def title_keys(self, node) -> set:
        """A publication's title as the database pairs it: kg/identity_keys.py title_key of its
        bbqs:title (publications.title), or of its label when it has none. Markup, case, accents and
        punctuation fold away; a Greek letter is spelled out, so alpha- and beta-synuclein differ."""
        titles = [str(o) for o in self.graph.objects(node, BBQS.title)] or [self.label(node)]
        return {k for k in map(title_key, titles) if k}

    def _year(self, node):
        for o in sorted(self.graph.objects(node, BBQS.year), key=str):
            if re.fullmatch(r"[0-9]{1,4}", str(o)):
                return int(str(o))
        return None

    def _pmid(self, node):
        values = sorted(str(o) for o in self.graph.objects(node, BBQS.pmid))
        return values[0] if values else None

    def _doi(self, node):
        values = sorted(str(o) for o in self.graph.objects(node, BBQS.doi))
        return values[0] if values else None

    def later(self, preprint, paper) -> bool:
        """Is this preprint later than this paper (kg/identity_keys.py preprint_is_later: by PubMed id,
        else by the posting date in its bioRxiv/medRxiv DOI or else its year, against the paper's
        year)? Then it is no earlier version of it, and the pairing rule never links them."""
        return preprint_is_later(self._year(preprint), self._pmid(preprint), self._doi(preprint),
                                 self._year(paper), self._pmid(paper))

    def version_kind(self, nodes) -> str:
        """What publications sharing one title are, by the pairing rule public.kg_link_publication_versions
        applies (kg/identity_keys.json: title, preprint, chronology):

          "linked_versions": one published record, the rest preprints, and every revision_of inside
              the group runs from that record to a preprint, each preprint linked: resolved. A pair a
              curator linked by hand is resolved whatever its order says, as the database reports it
              (linked, before the order is tested).
          "versions": the same, not all linked yet, and each preprint still to link no later than the
              paper (chronology: by PubMed id, else by the date in its DOI, else by year): a pair to
              link, which the function links once a project credits both.
          "versions_to_check": one published record and its preprints, but a revision_of inside the
              group runs from a preprint (or between two preprints, or to the paper itself), or a
              preprint still to link is later than the paper. The fault is a link or an order, not a
              second record: correct the link, or the record whose PMID, DOI or year is wrong (a
              "preprint" later than its paper may be another work with the same title). Never a
              merge: a preprint and its paper are two records of one work.
          "duplicate": anything else, for a curator to merge. Two records with one DOI or PMID are
              one record whatever links them; two published records, or none, are a duplicate to
              merge before any version link (the function skips them)."""
        nodes, g = set(nodes), self.graph
        for by in ("doi", "pmid"):
            held = set()
            for n in nodes:
                keys = {folded(by, o) for o in g.objects(n, BBQS[by])} - {None}
                if keys & held:
                    return "duplicate"
                held |= keys
        published = [n for n in nodes if not is_preprint(g, n)]
        if len(published) != 1:
            return "duplicate"
        paper = published[0]
        links = {(s, o) for s, o in g.subject_objects(BBQS.revision_of) if s in nodes and o in nodes}
        if any(s != paper or o == paper for s, o in links):
            return "versions_to_check"
        unlinked = nodes - {paper} - {o for _s, o in links}
        if not unlinked:
            return "linked_versions"
        if any(self.later(p, paper) for p in unlinked):
            return "versions_to_check"
        return "versions"

    def revision_links(self) -> dict:
        """revision_of links between two publications that the database's type check accepts but the
        pairing rule never makes: "reversed", a preprint said to revise a published paper (the newer
        revises the older, so the link points from the paper), and "titles_differ", two records whose
        title keys differ (two works, not two versions of one). SHACL #25 checks the rest: an end
        that is not a Publication, a link to itself, a link both ways."""
        g, out = self.graph, []
        for s, o in sorted(g.subject_objects(BBQS.revision_of), key=lambda so: (str(so[0]), str(so[1]))):
            if s == o or self.types.get(s) != "Publication" or self.types.get(o) != "Publication":
                continue
            problems = []
            if is_preprint(g, s) and not is_preprint(g, o):
                problems.append("reversed")
            if not self.title_keys(s) & self.title_keys(o):
                problems.append("titles_differ")
            if problems:
                out.append({"subject": str(s), "object": str(o), "problems": problems})
        return {"count": len(out), "links": out}

    def duplicates(self) -> dict:
        """Nodes of one class that share a name (folded: case, accents, punctuation, spacing), a
        publication's title (title_key, the database's pairing key), or an identifier (ORCID, DOI,
        PMID, FON, grant number, URL; each folded by its kg/identity_keys.py rule, the database's, or
        as written when the rule cannot read it: folded()). A graph built from a database inherits
        its duplicates, and cleaning them gets harder as it grows, so they are counted here and the CI
        gate fails when the count rises: a new one is stopped at the next export, not found later.

        A title shared by publications is one of four things (version_kind()): versions already
        linked by revision_of (`linked_versions`, resolved, not counted); a preprint and its
        published version not linked yet (`versions`, counted apart: linked, never merged); a
        preprint and its paper whose link points the wrong way or whose order is wrong
        (`versions_to_check`, counted apart: a link or a value to correct, never a merge); or a
        duplicate. Two publications with one DOI or one PMID are one record whatever links them.
        A shared URL counts only with a shared name: alone it is `advisory` (listed, not counted),
        since a homepage or a topic page can serve several records. Role records are skipped: their
        labels ("co_pi on <grant>") repeat by design."""
        if getattr(self, "_dupes", None) is not None:
            return self._dupes
        g = self.graph
        groups = defaultdict(set)
        for node, cls in self.types.items():
            if cls == "ProjectRole":
                continue
            if cls == "Publication":
                for key in self.title_keys(node):
                    groups[(cls, "title", key)].add(node)
            else:
                name = fold_label(self.label(node))
                if name:
                    groups[(cls, "name", name)].add(node)
            if cls == "Investigator" and first_last(self.label(node)):
                groups[(cls, "first and last name", first_last(self.label(node)))].add(node)
            for by in IDENTIFIERS:
                if by in URLS and cls not in URL_IDENTIFIES:
                    continue
                for o in g.objects(node, BBQS[by]):
                    v = folded(by, o)
                    if v:
                        groups[(cls, by, v)].add(node)
        out, seen = [], set()
        order = {**{by: (1 if by in URLS else 0) for by in IDENTIFIERS}, "title": 2, "name": 2,
                 "first and last name": 3}
        for (cls, by, value), nodes in sorted(groups.items(), key=lambda kv: (order.get(kv[0][1], 9), kv[0])):
            if len(nodes) < 2 or frozenset(nodes) in seen:
                continue
            seen.add(frozenset(nodes))
            if cls == "Publication" and by == "title":
                kind = self.version_kind(nodes)
            elif by in URLS and len({fold_label(self.label(n)) for n in nodes}) > 1:
                kind = "advisory"
            else:
                kind = "duplicate"
            out.append({"class": cls, "by": by, "value": value, "kind": kind,
                        "nodes": sorted(str(n) for n in nodes)})
        dup = [d for d in out if d["kind"] == "duplicate"]
        self._dupes = {"groups": out, "count": len(dup),
                       "nodes": len({n for d in dup for n in d["nodes"]}),
                       "versions": sum(1 for d in out if d["kind"] == "versions"),
                       "versions_to_check": sum(1 for d in out if d["kind"] == "versions_to_check"),
                       "linked_versions": sum(1 for d in out if d["kind"] == "linked_versions"),
                       "advisory": sum(1 for d in out if d["kind"] == "advisory")}
        return self._dupes

    # ---- publications ------------------------------------------------------------------------------

    def publications(self) -> dict:
        """Each publication's tie to the grant it came from, and what this export holds of its text.

        The tie is a Project's `produced` link, which the exporter writes from project_publications:
        the NIH award credited on the paper's PubMed record. The export allows two checks of it:
        whether an author is on the project's roster, by ORCID, which can only be asked where the
        paper has author ORCIDs and someone on the roster has an ORCID too (otherwise the tie is
        "roster_unchecked"), and whether another record has the same title: a preprint and its
        published version linked by revision_of ("versions_linked"), such a pair not linked yet
        ("preprint_pair"), or a possible duplicate ("same_title"), as duplicates() decides it. Each
        row lists the paper's linked versions (`versions`: the one it revises, or is revised by). The
        text is not in an anon export: publication_fulltext is admin-only, so `texts` lists only the
        text records this export holds (`text_of` links)."""
        g, types = self.graph, self.types
        pubs = sorted((n for n, c in types.items() if c == "Publication"), key=lambda n: (self.label(n).lower(), str(n)))
        produced = defaultdict(set)
        for proj, pub in g.subject_objects(BBQS.produced):
            if types.get(pub) == "Publication" and types.get(proj) == "Project":
                produced[pub].add(proj)
        roster = defaultdict(set)
        for rec, cls in types.items():
            if cls == "ProjectRole":
                proj, person = g.value(rec, BBQS.on_project), g.value(rec, BBQS.held_by)
                if proj is not None and person is not None:
                    roster[proj].add(person)
        by_orcid = defaultdict(set)
        for person, cls in types.items():
            if cls == "Investigator":
                for o in g.objects(person, BBQS.orcid):
                    by_orcid[bare_orcid(o)].add(person)
        texts = defaultdict(list)
        for node, pub in g.subject_objects(BBQS.text_of):
            if types.get(pub) == "Publication":
                texts[pub].append({"id": str(node), **{local(p): str(o) for p, o in g.predicate_objects(node)
                                                       if p != RDF.type and isinstance(o, Literal)}})

        # Same title (markup and punctuation out: "Ca<sup>2+</sup>" = "Ca[2+]"; a Greek letter
        # spelled out), by title_key of bbqs:title, as duplicates() and the database group it.
        same_title = defaultdict(set)
        for n in pubs:
            for key in self.title_keys(n):
                same_title[key].add(n)
        title_kind = {}
        for nodes in same_title.values():
            if len(nodes) > 1:
                kind = self.version_kind(nodes)
                for n in nodes:     # a record in a duplicate group under any of its titles stays one
                    if title_kind.get(n) != "duplicate":
                        title_kind[n] = kind
        versions = defaultdict(list)                        # revision_of, read from both ends
        for newer, older in g.subject_objects(BBQS.revision_of):
            if types.get(newer) == "Publication" and types.get(older) == "Publication":
                versions[newer].append({"id": str(older), "relation": "revises"})
                versions[older].append({"id": str(newer), "relation": "revised_by"})
        by_label = lambda n: (self.label(n), str(n))
        with_orcid = {p for people in by_orcid.values() for p in people}
        rows = []
        for pub in pubs:
            projects = sorted(produced[pub], key=by_label)
            orcids = sorted({bare_orcid(o) for o in g.objects(pub, BBQS.author_orcids)})
            members = set().union(*(roster[p] for p in projects))
            authors = sorted({p for o in orcids for p in by_orcid.get(o, ())}, key=by_label)
            checks = []
            if not projects:
                checks.append("no_project")
            if len(projects) > 1:
                checks.append("several_projects")
            if not orcids:
                checks.append("authors_unchecked")
            elif not members & with_orcid:                # nothing on the roster to compare the ORCIDs with
                checks.append("roster_unchecked")
            elif not any(p in members for p in authors):
                checks.append("no_roster_author")
            # A preprint and its published version are one work in two records: linked, never merged.
            if title_kind.get(pub) == "versions":
                checks.append("preprint_pair")
            elif title_kind.get(pub) == "versions_to_check":
                checks.append("version_to_check")
            elif title_kind.get(pub) == "duplicate":
                checks.append("same_title")
            elif versions[pub]:
                checks.append("versions_linked")
            if g.value(pub, BBQS.doi) is None and g.value(pub, BBQS.pmid) is None:
                checks.append("no_identifier")
            if not texts[pub]:
                checks.append("no_text")
            rows.append({
                "id": str(pub),
                "projects": [{"id": str(p), "grant_number": str(g.value(p, BBQS.grant_number) or ""),
                              "roster": len(roster[p])} for p in projects],
                "author_orcids": len(orcids),
                "investigator_authors": [{"id": str(p), "on_roster": p in members} for p in authors],
                "texts": texts[pub],
                "versions": sorted(versions[pub], key=lambda v: (v["relation"], v["id"])),
                "checks": checks,
            })
        return {"count": len(rows), "checks": dict(Counter(c for r in rows for c in r["checks"])), "rows": rows}

    def match_person(self, name: str, first_name_alone: bool = True) -> tuple[list[str], str | None]:
        """The Investigator nodes that are the person named, and how that was decided: the same name,
        and the same first and last name (both, so a person the graph holds twice, once with a middle
        name, links to both nodes); failing those, the same last name with the first name shortened
        ("Alex" for Alexander, "Joe" for Joseph); or, for a first name alone, the one investigator
        who has it. More than one node means the graph holds the person twice."""
        if not hasattr(self, "_investigators"):
            self._investigators = [(n, fold_name(self.label(n)).split()) for n, c in self.types.items()
                                   if c == "Investigator"]

        def short_for(a, b):
            a = NAME_FORMS.get(a, a)
            return a == b or (len(a) >= 3 and b.startswith(a)) or (len(b) >= 3 and a.startswith(b))

        rules = [
            ("same name", lambda w, x: x == w),
            ("same first and last name", lambda w, x: len(w) > 1 and len(x) > 1 and (x[0], x[-1]) == (w[0], w[-1])),
            ("same last name, and the first name is a short form of it",
             lambda w, x: len(w) > 1 and len(x) > 1 and x[-1] == w[-1] and short_for(w[0], x[0])),
        ]
        w = fold_name(name).split()
        if not w:
            return [], None
        same = {}
        for how, rule in rules[:2]:                        # rule 1 or 2, every node either finds
            for n, x in self._investigators:
                if rule(w, x):
                    same.setdefault(n, how)
        if same:
            first = next(how for how, _rule in rules[:2] if how in same.values())
            return sorted(str(n) for n in same), first
        for how, rule in rules[2:]:
            hits = [n for n, x in self._investigators if rule(w, x)]
            if hits:
                return sorted(str(n) for n in hits), how
        hits = [n for n, x in self._investigators if first_name_alone and len(w) == 1 and x[:1] == w]
        if len(hits) == 1:
            return [str(hits[0])], "first name only: the notes give no last name, and one investigator has it"
        return [], None

    def link_people(self, internal: dict) -> dict:
        """Tie each person the meeting records name to the Investigator nodes that are the same person
        (match_person says how)."""
        for person in internal.get("people") or []:
            person.pop("investigators", None)
            person.pop("match", None)
            if person.get("not_a_person"):          # a shared account (kg/internal_package.py): never an investigator
                continue
            hits, how = self.match_person(person.get("name", ""))
            if hits:
                person["investigators"], person["match"] = hits, how
        return internal

    def anonymize(self, doc: dict) -> dict:
        """Nobody is named in the internal records (the owner's decision, 2026-11-23). The builder
        replaced the names the package knows; this replaces the names the GRAPH knows: every
        investigator's, wherever one stands in a carried text. What the graph names that is not a
        person (an organization, a working group, a device, a maker, a tool, a species) is kept whole."""
        import package_reader as pr
        g = self.graph
        people = [str(v) for n, c in self.types.items() if c == "Investigator"
                  for pred in ("name", "aliases") for v in g.objects(n, BBQS[pred])]
        kept = [str(v) for n, c in self.types.items()
                if c in ("ResearchOrganization", "WorkingGroup", "Device", "DeviceManufacturer", "DeviceCategory", "SoftwareTool",
                         "Species", "Dataset", "FundingOpportunity")
                for pred in ("name", "common_name", "model_name", "aliases") for v in g.objects(n, BBQS[pred])]
        kept += [m.get("group", "") for m in doc.get("meetings") or []] + [a.get("institution", "") for a in doc.get("awards") or []]
        for d in doc.get("devices") or []:
            kept += [d.get("name", ""), d.get("brand_stated", ""), d.get("category", ""), *d.get("sensor", []), *d.get("tools", []),
                     *((d.get("ai_predicted") or {}).values())]
        groups = sorted(({m.get("group", "") for m in doc.get("meetings") or []}
                         | {str(v) for n, c in self.types.items() if c == "WorkingGroup" for v in g.objects(n, BBQS.name)}) - {""})
        scrubber = pr.NameScrubber(people, [k for k in kept if k and len(k) >= 3], groups)
        doc = scrubber.scrub_document(doc)
        doc["names_removed"] = int(doc.get("names_removed") or 0) + scrubber.count
        return doc

    def link_devices(self, doc: dict) -> dict:
        """Tie the device list to the graph. Each award to its Project node by grant number; each
        full name in a "who spoke to it" or "speaker" line to Investigator nodes (match_person: a
        first name alone is not enough there, and a name the source marks for checking, in
        parentheses with VERIFY or "likely", is left out because fold_name drops the parenthesis);
        and each maker or model named to the device catalog's DeviceManufacturer or Device node of
        the same name. A match says that a name is in the catalog, not that the device is checked."""
        g = self.graph

        def core(grant) -> str:              # 1R34DA059716-01 -> R34DA059716
            m = re.search(r"[A-Z]\d{2}[A-Z]{2}\d{6}", str(grant).upper())
            return m.group(0) if m else str(grant).strip().upper()

        projects = defaultdict(set)
        for n, c in self.types.items():
            if c == "Project":
                for gn in g.objects(n, BBQS.grant_number):
                    projects[core(gn)].add(str(n))
        for award in doc.get("awards") or []:
            award["projects"] = sorted(projects.get(core(award.get("award", "")), ()))

        spoken = {}
        for text in {d.get("presenter", "") for d in doc.get("devices") or []} | \
                    {e.get("speaker", "") for e in (doc.get("evidence") or []) + (doc.get("discussion") or [])}:
            cleaned = re.sub(r"\(.*?\)", " ", text or "")
            found = []
            for m in re.finditer(r"\b[A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){1,2}\b", cleaned):
                hits, how = self.match_person(m.group(0), first_name_alone=False)
                if hits and all(h not in {x for f in found for x in f["investigators"]} for h in hits):
                    found.append({"as_written": m.group(0), "investigators": hits, "match": how})
            if found:
                spoken[text] = found
        doc["speakers"] = spoken

        def names(cls, preds):
            index = defaultdict(set)
            for n, c in self.types.items():
                if c == cls:
                    for p in preds:
                        for v in g.objects(n, BBQS[p]):
                            if fold_name(v):
                                index[fold_name(v)].add(str(n))
            return index

        makers, models = names("DeviceManufacturer", ("name", "aliases")), names("Device", ("name", "model_name", "aliases"))

        def catalog(name, index):
            f = fold_name(name)
            if not f:
                return []
            exact = index.get(f) or {n for key, nodes in index.items() if key.startswith(f + " ") for n in nodes}
            return sorted(exact)

        for d in doc.get("devices") or []:
            ai = d.get("ai_predicted") or {}
            d["catalog"] = {
                "brand": catalog(d.get("brand_stated", ""), makers),
                "ai_manufacturer": catalog(re.split(r"[,(]", ai.get("manufacturer") or "")[0], makers),
                "ai_model": catalog(re.split(r"[,;(]", ai.get("model") or "")[0], models),
            }
        return doc

    # ---- report ------------------------------------------------------------------------------------

    def report(self) -> dict:
        structure = self.structure()
        degree = structure.pop("_degree")
        violations = self.violations()
        cqs = self.competency()
        proposed = self.competency_proposed()
        return {
            "data_file": shown(self.data_file),
            "access": self.access,
            "source": self.source,
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "commit": commit_stamp(),
            "structure": structure,
            "competency": cqs,
            "competency_summary": dict(Counter(q["status"] for q in cqs)),
            "competency_proposed": proposed,
            "competency_proposed_summary": dict(Counter(q["status"] for q in proposed)),
            "shapes": self.shape_exercise(),
            "violation_count": sum(v["severity"] == "violation" for vs in violations.values() for v in vs),
            "warning_count": sum(v["severity"] == "warning" for vs in violations.values() for v in vs),
            "entities": self.entities(degree, violations),
            "publications": self.publications(),
            "duplicates": self.duplicates(),
            "revision_links": self.revision_links(),
        }

    @staticmethod
    def render_html(report: dict, out_path: Path, standalone: bool = True, internal: dict | None = None) -> Path:
        """Inline the report into browser/template.html. The template is a body fragment (the form
        an Artifact publish wants); standalone=True adds the doctype + metas a local file needs.
        `internal` (meeting records, kg/meetings.py) fills the second placeholder; without it the
        page carries none. Both are filled in one pass over the template, so text inside one payload
        is never read as a placeholder."""
        template = KGQuality.TEMPLATE.read_text(encoding="utf-8")

        def script_json(value) -> str:      # JSON as a script literal: no "<" left to open or close a tag
            return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")

        fill = {"REPORT": script_json(report), "INTERNAL": script_json(internal) if internal else "null"}
        parts = re.split(r"/\*__(REPORT|INTERNAL)__\*/null", template)
        if parts[1::2] != ["REPORT", "INTERNAL"]:
            raise ValueError("browser/template.html must hold /*__REPORT__*/null and then /*__INTERNAL__*/null, once each")
        html = "".join(fill[part] if i % 2 else part for i, part in enumerate(parts))
        if standalone:
            html = ('<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
                    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' + html)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html, encoding="utf-8")
        return out_path

    @staticmethod
    def summary(report: dict) -> str:
        s = report["structure"]
        lines = [
            f"built {report['built_at']}  commit={report['commit']}  source={report['source']}  access={report['access']}",
            f"structure: {s['triples']} triples, {s['nodes']} nodes, {s['edges']} edges, "
            f"{s['components']} components (largest {s['largest_component']}), {s['isolated']} isolated",
            "",
            f"competency: {report['competency_summary']}",
        ]
        for q in report["competency"]:
            extra = f"unmodeled: {', '.join(q['unmodeled'])}" if q["unmodeled"] else f"{q['row_count']} rows"
            lines.append(f"  {q['id']} {q['status']:<9} {q['question']}  [{extra}]")
        if report.get("competency_proposed"):
            lines += ["", f"proposed, not scored: {report['competency_proposed_summary']}"]
            for q in report["competency_proposed"]:
                extra = f"unmodeled: {', '.join(q['unmodeled'])}" if q["unmodeled"] else f"{q['row_count']} rows"
                lines.append(f"  {q['id']} {q['status']:<9} {q['question']}  [{extra}]")
        pubs = report.get("publications")
        if pubs:
            tied = sum(1 for r in pubs["rows"] if r["projects"])
            lines += ["", f"publications: {pubs['count']}, {tied} tied to a project; checks: "
                      + ", ".join(f"{k} {v}" for k, v in sorted(pubs["checks"].items()))]
        d = report.get("duplicates") or {}
        rl = report.get("revision_links") or {}
        lines += ["", f"possible duplicates: {d.get('count', 0)} groups ({d.get('nodes', 0)} nodes); "
                      f"preprint + published pairs: {d.get('versions', 0)} to link, "
                      f"{d.get('linked_versions', 0)} linked (revision_of), "
                      f"{d.get('versions_to_check', 0)} to check (a link from the preprint, or a preprint later than its paper); "
                      f"shared URL only (advisory, not counted): {d.get('advisory', 0)}; "
                      f"revision_of links to check (reversed, or two titles): {rl.get('count', 0)}"]
        lines += ["", f"SHACL validation shapes (violations: {report['violation_count']}, warnings: {report.get('warning_count', 0)}):"]
        for sh in report["shapes"]:
            absent = f" (absent: {', '.join(sh['missing_inputs'])})" if sh["missing_inputs"] else ""
            state = ("exercised" + absent if sh["exercised"] else
                     "vacuous" + absent if sh["missing_inputs"] else "vacuous (no targets)")
            lines.append(f"  {sh['shape']:<40} targets={sh['targets']:<4} {state}")
        return "\n".join(lines)


@click.command()
@click.argument("data_file", type=click.Path(exists=True, dir_okay=False, path_type=Path), required=False)
@click.option("--access", type=click.Choice(["anon", "full"]), default="anon", show_default=True,
              help="The key the export was made with; `access: full` questions are n/a on anon.")
@click.option("--json", "json_path", type=click.Path(dir_okay=False, path_type=Path),
              default=KGQuality.DEFAULT_JSON, show_default=True)
@click.option("--html", "html_path", type=click.Path(dir_okay=False, path_type=Path),
              default=KGQuality.DEFAULT_HTML, show_default=True)
@click.option("--fragment", "fragment_path", type=click.Path(dir_okay=False, path_type=Path), default=None,
              help="Also write the page without doctype/head, for publishing as an Artifact.")
@click.option("--source", default=None,
              help="How the data was produced, shown in the page's build stamp (default: the file path).")
@click.option("--internal", "internal_paths", type=click.Path(exists=True, dir_okay=False, path_type=Path),
              multiple=True,
              help="Internal records for the artifact copy: the meeting notes (kg/meetings.py, the Meetings "
                   "tab) and the device list (kg/devices.py, the Devices tab). May be given once for each. "
                   "Embedded in the --fragment only, which must be written outside the repository.")
def main(data_file, access, json_path, html_path, fragment_path, source, internal_paths):
    """Measure DATA_FILE (default kg/export/bbqs.ttl) and build the entity browser from it."""
    internal = None
    if internal_paths:
        if os.environ.get("GITHUB_ACTIONS") == "true" or os.environ.get("CI"):
            raise click.UsageError("--internal runs on CI here (GITHUB_ACTIONS or CI is set); the artifact copy is built by hand only.")
        if not fragment_path:
            raise click.UsageError("--internal goes into the artifact fragment only: give --fragment as well.")
        for path, what in [*((p, "--internal") for p in internal_paths), (fragment_path, "--fragment")]:
            if inside_repo(path):
                raise click.UsageError(f"{what} {path} is inside the repository. These records are internal: "
                                       "keep them, and any page built with them, outside it.")
    kg = KGQuality(data_file, access=access, source=source)
    report = kg.report()
    if internal_paths:
        linkers = {"bbqs-meetings": kg.link_people, "bbqs-devices": kg.link_devices}
        internal = {}
        for path in internal_paths:
            doc = json.loads(path.read_text(encoding="utf-8"))
            kind = doc.get("kind") if isinstance(doc, dict) else None
            if kind not in linkers:
                raise click.UsageError(f"--internal {path} is not meeting records or a device list "
                                       f"(its kind is {kind!r}; kg/internal_package.py writes them).")
            if kind in internal:
                raise click.UsageError(f"--internal was given two files of kind {kind}.")
            if doc.get("anonymous") is not True:
                # The owner's decision, 2026-11-23: a statement is attributed to the consortium, never
                # to a named person. Records that name people are not put on a page any more.
                raise click.UsageError(f"--internal {path} names people (it is not marked anonymous). Statements are "
                                       "attributed to the consortium, not to named people: build the records with "
                                       "kg/internal_package.py, which names nobody.")
            internal[kind] = kg.anonymize(linkers[kind](doc))
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    KGQuality.render_html(report, html_path)                  # never the internal records
    if fragment_path:
        KGQuality.render_html(report, fragment_path, standalone=False, internal=internal)
    click.echo(KGQuality.summary(report))
    click.echo(f"\nwrote {shown(json_path)} and {shown(html_path)}")


if __name__ == "__main__":
    main()
