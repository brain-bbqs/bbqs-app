#!/usr/bin/env python3
"""Evaluate the quality of an exported BBQS graph, and build the entity browser from the result.

Four measurements, one report:

  structure   -- nodes/edges per class, connected components, isolated nodes, dangling IRIs, and the
                 class->predicate->class edge matrix (which links actually exist)
  competency  -- runs kg/competency_questions.yaml; each question is answered / empty / n/a / unmodeled
  shapes      -- per consistency shape: how many nodes it targets, and whether the data even contains
                 the terms it checks (a shape whose inputs are absent passes vacuously)
  violations  -- the SHACL results, keyed by focus node, so each entity card can show its own

    python kg/quality.py                        # kg/export/bbqs.ttl, anon
    python kg/quality.py data.ttl --access full
    # writes kg/export/quality.json and kg/browser/index.html (self-contained, open it directly)

Requires rdflib, pyshacl, PyYAML, click (all in kg/.venv).
"""
import json
import os
import re
import subprocess
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
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "."], cwd=HERE, capture_output=True,
                               text=True).stdout.strip()
        return f"{sha} + uncommitted kg/ changes" if dirty else sha
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def local(term) -> str:
    s = str(term)
    return s.rsplit("#", 1)[-1] if "#" in s else s.rsplit("/", 1)[-1]


class KGQuality:
    DEFAULT_DATA = HERE / "export" / "bbqs.ttl"
    DEFAULT_TBOX = HERE / "bbqs.owl.ttl"
    DEFAULT_CQS = HERE / "competency_questions.yaml"
    DEFAULT_SHAPES_DIR = HERE / "shapes"
    DEFAULT_JSON = HERE / "export" / "quality.json"
    DEFAULT_HTML = HERE / "browser" / "index.html"
    TEMPLATE = HERE / "browser" / "template.html"

    def __init__(self, data_file=None, access="anon", tbox_file=None, cq_file=None, shape_files=None,
                 source=None):
        self.data_file = Path(data_file) if data_file else self.DEFAULT_DATA
        self.access = access
        self.source = source or shown(self.data_file)
        self.graph = Graph().parse(str(self.data_file), format="turtle")
        self.tbox = Graph().parse(str(tbox_file or self.DEFAULT_TBOX), format="turtle")
        self.cq_file = Path(cq_file) if cq_file else self.DEFAULT_CQS
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

    def competency(self) -> list[dict]:
        spec = yaml.safe_load(self.cq_file.read_text(encoding="utf-8"))
        prologue = "".join(f"PREFIX {k}: <{v}>\n" for k, v in spec["prefixes"].items())
        results = []
        for q in spec["questions"]:
            terms = sorted(set(re.findall(r"\bbbqs:(\w+)", q["sparql"])))
            unmodeled = [t for t in terms if t not in self.tbox_terms]
            row = {k: q[k] for k in ("id", "area", "question", "access")}
            row.update({"sparql": q["sparql"].strip(), "terms": terms, "unmodeled": unmodeled,
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
            else:
                row["status"] = "empty"
            results.append(row)
        return results

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
            terms = set()
            for ps in sg.objects(shape, SH.property):
                path = sg.value(ps, SH.path)
                if path is not None and str(path).startswith(str(BBQS)):
                    terms.add(local(path))
            for sp in sg.objects(shape, SH.sparql):
                select = str(sg.value(sp, SH.select) or "")
                terms |= set(re.findall(r"\bbbqs:(\w+)", select))
            missing = sorted(t for t in terms if not self._present(t))
            out.append({
                "shape": local(shape),
                "target_class": local(target) if target is not None else (
                    "subjects of " + ", ".join(local(p) for p in subjects_of) if subjects_of else None),
                "targets": targets,
                "checks": sorted(terms),
                "missing_inputs": missing,
                "exercised": bool(targets) and not missing,
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
            if violations.get(str(node)):
                flags.append("violation")
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

    # ---- report ------------------------------------------------------------------------------------

    def report(self) -> dict:
        structure = self.structure()
        degree = structure.pop("_degree")
        violations = self.violations()
        cqs = self.competency()
        return {
            "data_file": shown(self.data_file),
            "access": self.access,
            "source": self.source,
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "commit": commit_stamp(),
            "structure": structure,
            "competency": cqs,
            "competency_summary": dict(Counter(q["status"] for q in cqs)),
            "shapes": self.shape_exercise(),
            "violation_count": sum(len(v) for v in violations.values()),
            "entities": self.entities(degree, violations),
        }

    @staticmethod
    def render_html(report: dict, out_path: Path, standalone: bool = True) -> Path:
        """Inline the report into browser/template.html. The template is a body fragment (the form
        an Artifact publish wants); standalone=True adds the doctype + metas a local file needs."""
        template = KGQuality.TEMPLATE.read_text(encoding="utf-8")
        payload = json.dumps(report, ensure_ascii=False).replace("</", "<\\/")
        html = template.replace("/*__REPORT__*/null", payload)
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
        lines += ["", f"shapes (violations: {report['violation_count']}):"]
        for sh in report["shapes"]:
            state = "exercised" if sh["exercised"] else (
                f"vacuous (absent: {', '.join(sh['missing_inputs'])})" if sh["missing_inputs"] else "vacuous (no targets)")
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
def main(data_file, access, json_path, html_path, fragment_path, source):
    """Measure DATA_FILE (default kg/export/bbqs.ttl) and build the entity browser from it."""
    report = KGQuality(data_file, access=access, source=source).report()
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    KGQuality.render_html(report, html_path)
    if fragment_path:
        KGQuality.render_html(report, fragment_path, standalone=False)
    click.echo(KGQuality.summary(report))
    click.echo(f"\nwrote {shown(json_path)} and {shown(html_path)}")


if __name__ == "__main__":
    main()
