#!/usr/bin/env python3
"""Evaluate the quality of an exported BBQS graph, and build the entity browser from the result.

Four measurements, one report:

  structure   -- nodes/edges per class, connected components, isolated nodes, dangling IRIs, and the
                 class->predicate->class edge matrix (which links actually exist)
  competency  -- runs kg/competency_questions.yaml; each question is answered / empty / n/a / unmodeled
                 (or "none" for a question that asks what is missing, when nothing is). It also runs
                 competency_questions_extended.yaml, the questions proposed in #441, for the Inspector
                 only: the gate (ci_check.py) scores just the adopted file until #441 adopts them
  shapes      -- per consistency shape: how many nodes it targets, and whether the data even contains
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

HERE = Path(__file__).resolve().parent
BBQS = Namespace("https://brain-bbqs.org/schema#")
BID = "https://brain-bbqs.org/id/"

LABEL_PREDICATES = ("name", "title", "label", "common_name", "model_name")
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
    """An ORCID as its 16-character id, however it was written (IRI, URL or bare)."""
    m = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", str(value))
    return m.group(0) if m else str(value).strip()


_TRANSLIT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "ae", "Ö": "oe", "Ü": "ue", "ß": "ss"})


def fold_name(name) -> str:
    """A person's name for matching only: case, accents, dots, spacing and any (note) ignored, so
    "Oliver Rübel" = "Oliver Ruebel" and "Bijan  Pesaran" = "Bijan Pesaran"."""
    text = re.sub(r"\(.*?\)", " ", str(name).translate(_TRANSLIT))
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return " ".join(text.replace(".", " ").casefold().split())


# First-name forms the meeting notes use that are not a prefix of the name the graph holds.
NAME_FORMS = {"joe": "joseph", "liz": "elizabeth", "lizzy": "elizabeth"}


class KGQuality:
    DEFAULT_DATA = HERE / "export" / "bbqs.ttl"
    DEFAULT_TBOX = HERE / "bbqs.owl.ttl"
    DEFAULT_CQS = HERE / "competency_questions.yaml"
    DEFAULT_CQS_PROPOSED = HERE / "competency_questions_extended.yaml"
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
        """The questions proposed in #441: shown in the Inspector, not counted by the gate."""
        return self.competency(self.cq_proposed_file, "proposed") if self.cq_proposed_file.exists() else []

    # ---- consistency shapes: exercise + violations ------------------------------------------------

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
            checking = (any(self._present(t) for t in paths)
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
            })
        return cards

    # ---- publications ------------------------------------------------------------------------------

    def publications(self) -> dict:
        """Each publication's tie to the grant it came from, and what this export holds of its text.

        The tie is a Project's `produced` link, which the exporter writes from project_publications:
        the NIH award credited on the paper's PubMed record. The export allows two checks of it:
        whether an author is on the project's roster, by ORCID (most records carry no author ORCIDs,
        so most cannot be checked), and whether another record has the same title (usually a preprint
        and its published version). The text is not in an anon export: publication_fulltext is
        admin-only, so `texts` lists only the text records this export holds (`text_of` links)."""
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

        def title_key(n):
            t = g.value(n, BBQS.title) or g.value(n, BBQS.name) or ""
            return " ".join(re.sub(r"[\W_]+", " ", str(t).casefold()).split())

        same = Counter(title_key(n) for n in pubs)
        by_label = lambda n: (self.label(n), str(n))
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
            elif not any(p in members for p in authors):
                checks.append("no_roster_author")
            if title_key(pub) and same[title_key(pub)] > 1:
                checks.append("same_title")
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
                "checks": checks,
            })
        return {"count": len(rows), "checks": dict(Counter(c for r in rows for c in r["checks"])), "rows": rows}

    def link_people(self, internal: dict) -> dict:
        """Tie each person the meeting records name to the Investigator nodes that are the same person,
        saying how: the same name; the same first and last name; the same last name with the first
        name shortened ("Kris" for Kristofer, "Joe" for Joseph); or, where the notes give a first name
        only, the one investigator who has it. More than one node means the graph holds the person twice."""
        investigators = [(n, fold_name(self.label(n)).split()) for n, c in self.types.items() if c == "Investigator"]

        def short_for(a, b):
            a = NAME_FORMS.get(a, a)
            return a == b or (len(a) >= 3 and b.startswith(a)) or (len(b) >= 3 and a.startswith(b))

        rules = [
            ("same name", lambda w, x: x == w),
            ("same first and last name", lambda w, x: len(w) > 1 and len(x) > 1 and (x[0], x[-1]) == (w[0], w[-1])),
            ("same last name, and the first name is a short form of it",
             lambda w, x: len(w) > 1 and len(x) > 1 and x[-1] == w[-1] and short_for(w[0], x[0])),
        ]
        for person in internal.get("people") or []:
            w = fold_name(person.get("name", "")).split()
            person.pop("investigators", None)
            person.pop("match", None)
            if not w:
                continue
            for how, rule in rules:
                hits = [n for n, x in investigators if rule(w, x)]
                if hits:
                    break
            else:
                hits = [n for n, x in investigators if len(w) == 1 and x[:1] == w]
                hits, how = (hits, "first name only: the notes give no last name, and one investigator has it") \
                    if len(hits) == 1 else ([], None)
            if hits:
                person["investigators"] = sorted(str(n) for n in hits)
                person["match"] = how
        return internal

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
            lines += ["", f"proposed in #441, not scored: {report['competency_proposed_summary']}"]
            for q in report["competency_proposed"]:
                extra = f"unmodeled: {', '.join(q['unmodeled'])}" if q["unmodeled"] else f"{q['row_count']} rows"
                lines.append(f"  {q['id']} {q['status']:<9} {q['question']}  [{extra}]")
        pubs = report.get("publications")
        if pubs:
            tied = sum(1 for r in pubs["rows"] if r["projects"])
            lines += ["", f"publications: {pubs['count']}, {tied} tied to a project; checks: "
                      + ", ".join(f"{k} {v}" for k, v in sorted(pubs["checks"].items()))]
        lines += ["", f"shapes (violations: {report['violation_count']}, warnings: {report.get('warning_count', 0)}):"]
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
@click.option("--internal", "internal_path", type=click.Path(exists=True, dir_okay=False, path_type=Path),
              default=None,
              help="Meeting records from kg/meetings.py, for the Meetings tab. Internal: embedded in the "
                   "--fragment only, which must be written outside the repository.")
def main(data_file, access, json_path, html_path, fragment_path, source, internal_path):
    """Measure DATA_FILE (default kg/export/bbqs.ttl) and build the entity browser from it."""
    internal = None
    if internal_path:
        if not fragment_path:
            raise click.UsageError("--internal goes into the artifact fragment only: give --fragment as well.")
        for path, what in ((internal_path, "--internal"), (fragment_path, "--fragment")):
            if inside_repo(path):
                raise click.UsageError(f"{what} {path} is inside the repository. Meeting notes are internal: "
                                       "keep them, and any page built with them, outside it.")
    kg = KGQuality(data_file, access=access, source=source)
    report = kg.report()
    if internal_path:
        internal = kg.link_people(json.loads(internal_path.read_text(encoding="utf-8")))
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    KGQuality.render_html(report, html_path)                  # never the internal records
    if fragment_path:
        KGQuality.render_html(report, fragment_path, standalone=False, internal=internal)
    click.echo(KGQuality.summary(report))
    click.echo(f"\nwrote {shown(json_path)} and {shown(html_path)}")


if __name__ == "__main__":
    main()
