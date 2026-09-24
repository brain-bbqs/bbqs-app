#!/usr/bin/env python3
"""BBQS knowledge graph pipeline as one object.

`BBQSKnowledgeGraph` wraps the exporter (Supabase `resources` spine -> instance Turtle) and the
SHACL validator (pyshacl) as methods of a single class. `export.py` and `validate.py` are now thin
click CLIs over this class, so their documented commands keep working; `main.py` runs the two
steps in sequence with one call.

Spine-first: since the Phase-5 backfill EVERY entity is in `resources`, so every node is minted from
resources.id and each detail table is joined on by resource_id. An unknown/deprecated resource_type
(e.g. legacy `project`, superseded by `grant` since Project=Grant) is skipped, never noded.

    python kg/main.py [out.ttl]        # export, then validate the result
Requires rdflib (already in kg/.venv from pyshacl).
"""
import collections
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from rdflib import Graph, Literal, Namespace
from rdflib.namespace import RDF

HERE = Path(__file__).resolve().parent
BBQS = Namespace("https://brain-bbqs.org/schema#")
BID = Namespace("https://brain-bbqs.org/id/")

# resources.resource_type -> bbqs class local name. A type absent here (e.g. deprecated `project`)
# is NOT minted as a node.
TYPE_CLASS = {
    "investigator": "Investigator", "organization": "ResearchOrganization", "grant": "Project",
    "publication": "Publication", "software": "SoftwareTool", "tool": "Tool", "dataset": "Dataset",
    "protocol": "Protocol", "benchmark": "Benchmark", "ml_model": "MLModel", "job": "Job",
    "announcement": "Announcement", "funding": "FundingOpportunity", "species": "Species",
    "device": "Device", "device_category": "DeviceCategory", "device_manufacturer": "DeviceManufacturer",
    "working_group": "WorkingGroup", "event": "Event",
}


class BBQSKnowledgeGraph:
    """Exports the BBQS KG from Supabase and validates it against the SHACL consistency shapes."""

    DEFAULT_EXPORT_PATH = HERE / "export" / "bbqs.ttl"
    DEFAULT_SHAPES_DIR = HERE / "shapes"

    def __init__(self, url=None, key=None):
        self.url = (url or os.environ.get("SUPABASE_URL") or self._client_default("VITE_SUPABASE_URL") or "").rstrip("/")
        self.key = key or os.environ.get("SUPABASE_KEY") or self._client_default("VITE_SUPABASE_PUBLISHABLE_KEY") or ""
        if not self.url or not self.key:
            raise SystemExit(
                "Set SUPABASE_URL and SUPABASE_KEY, or run from the repo so BBQSKnowledgeGraph can "
                "read the public values from src/integrations/supabase/client.ts."
            )
        self.graph = Graph()
        self.graph.bind("bbqs", BBQS)
        self.graph.bind("bid", BID)

    @staticmethod
    def _client_default(js_const):
        """Read a public fallback value from the app's supabase client (single source of truth)."""
        try:
            txt = (HERE / ".." / "src" / "integrations" / "supabase" / "client.ts").read_text(encoding="utf8")
        except OSError:
            return None
        m = re.search(js_const + r'\s*\|\|\s*"([^"]+)"', txt)
        return m.group(1) if m else None

    def fetch(self, table, select="*"):
        """All rows of a table via PostgREST (tables here are < 1000 rows, so one request)."""
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{table}?select={select}",
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}", "Range": "0-9999"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or "[]")
        except urllib.error.HTTPError as e:
            print(f"  ! {table}: HTTP {e.code} (RLS hidden or missing)", file=sys.stderr)
            return []

    @staticmethod
    def mechanism(grant_number):
        """NIH activity code (R61/U01/RF1/R34/…) parsed from the grant number."""
        m = re.search(r"([A-Z]{1,3}\d{2})", grant_number or "")
        return m.group(1) if m else None

    def add(self, subj, pred, value, cast=str):
        if value is not None and value != "":
            self.graph.add((subj, BBQS[pred], Literal(cast(value)) if cast else Literal(value)))

    def export(self, out_path: Path | str | None = None) -> Path:
        """Build the instance graph from Supabase and serialize it to out_path. Returns out_path.

        Spine-first: one node per `resources` row, keyed by resources.id; each detail table is joined
        onto its spine node by resource_id. Unknown/deprecated resource_types are skipped.
        """
        out_path = Path(out_path) if out_path else self.DEFAULT_EXPORT_PATH
        g = self.graph

        # ---- id -> spine IRI maps (every entity is now in the resources spine) ----
        def id_map(table):
            return {r["id"]: BID[r["resource_id"]]
                    for r in self.fetch(table, "id,resource_id") if r.get("resource_id")}

        org_node = id_map("organizations")
        man_node = id_map("device_manufacturers")
        inv_node = id_map("investigators")          # RLS-hidden under anon -> {} -> held_by omitted
        grant_node, gn_node, cat_node = {}, {}, {}

        # ---- 1. Node spine: one node per resources row, typed by resource_type ----
        skipped = collections.Counter()
        for r in self.fetch("resources"):
            cls = TYPE_CLASS.get(r["resource_type"])
            if cls is None:                          # deprecated/unknown type (e.g. legacy 'project')
                skipped[r["resource_type"]] += 1
                continue
            n = BID[r["id"]]
            g.add((n, RDF.type, BBQS[cls]))
            self.add(n, "name", r.get("name"))
            self.add(n, "description", r.get("description"))
            self.add(n, "external_url", r.get("external_url"))
            if r.get("organization_id") and r["organization_id"] in org_node:
                g.add((n, BBQS["part_of_org"], org_node[r["organization_id"]]))

        # ---- 2. Detail: attach each table's columns to its spine node (by resource_id) ----
        # Project = grants (award facet) enriched by projects (science facet), both on the grant node.
        for gr in self.fetch("grants"):
            rid = gr.get("resource_id")
            if not rid:
                continue
            n = BID[rid]
            grant_node[gr["id"]] = n
            gn_node[gr["grant_number"]] = n
            self.add(n, "grant_number", gr.get("grant_number"))
            self.add(n, "mechanism", self.mechanism(gr.get("grant_number")))
            self.add(n, "title", gr.get("title"))
            self.add(n, "abstract", gr.get("abstract"))
            self.add(n, "nih_link", gr.get("nih_link"))
            self.add(n, "reporter_project_num", gr.get("reporter_project_num"))
            self.add(n, "award_amount", gr.get("award_amount"), cast=None)
            self.add(n, "fiscal_year", gr.get("fiscal_year"), cast=None)

        # Species detail + a resolver that folds species_aliases (synonyms / scientific names).
        species_by_name, species_rows = {}, []
        for sp in self.fetch("species"):
            rid = sp.get("resource_id")
            if not rid:
                continue
            n = BID[rid]
            species_rows.append((n, sp))
            self.add(n, "common_name", sp.get("common_name"))
            self.add(n, "taxonomy_class", sp.get("taxonomy_class"))
            for key in (sp.get("name"), sp.get("common_name")):
                if key:
                    species_by_name.setdefault(key.strip().lower(), n)

        aliases = self.fetch("species_aliases")
        canon_of = {}
        for a in aliases:
            canon = (a.get("canonical") or a.get("common_name") or a.get("alias") or "").strip().lower()
            if not canon:
                continue
            for form in (a.get("alias"), a.get("canonical"), a.get("common_name")):
                if form:
                    canon_of[form.strip().lower()] = canon
        iri_of_canon = {}
        for n, sp in species_rows:
            for key in (sp.get("name"), sp.get("common_name")):
                if key:
                    c = canon_of.get(key.strip().lower())
                    if c:
                        iri_of_canon.setdefault(c, n)
        for a in aliases:  # emit aliases onto species nodes so shape #7 verifies from the graph itself
            canon = (a.get("canonical") or a.get("common_name") or a.get("alias") or "").strip().lower()
            target = iri_of_canon.get(canon) or species_by_name.get(canon)
            if target is None:
                continue
            for form in (a.get("alias"), a.get("canonical"), a.get("common_name")):
                if form:
                    self.add(target, "aliases", form)

        def resolve_species(value):
            v = str(value).strip().lower()
            if v in species_by_name:
                return species_by_name[v]
            c = canon_of.get(v)
            if c:
                return iri_of_canon.get(c) or species_by_name.get(c)
            return None

        # "No species by design" markers (infrastructure awards): recorded as study_scope, NOT a
        # species claim, so #7 doesn't flag them. Driven by a species_aliases 'not_applicable' subkind
        # when it exists; until then "all species" is the fallback. TBD placeholders (genetic species,
        # requires verification, new model system) are deliberately NOT here -- #7 must keep flagging.
        not_applicable = {"all species"}
        not_applicable |= {a["alias"].strip().lower() for a in aliases
                           if a.get("kind") in ("not_applicable", "no_species") and a.get("alias")}

        dangling_species = []
        for p in self.fetch("projects"):
            n = gn_node.get(p["grant_number"])
            if n is None:
                continue
            self.add(n, "website", p.get("website"))
            self.add(n, "onboarding_status", p.get("onboarding_status"))
            if p.get("study_human") is not None:
                g.add((n, BBQS["studies_human"], Literal(bool(p["study_human"]))))
            for kw in p.get("keywords") or []:
                self.add(n, "keywords", kw)
            for name in p.get("study_species") or []:
                if str(name).strip().lower() in not_applicable:
                    self.add(n, "study_scope", name)   # names no species by design (e.g. infra awards)
                    continue
                self.add(n, "studies_species_name", name)  # the raw claim, verbatim
                target = resolve_species(name)
                if target is not None:
                    g.add((n, BBQS["studies_species"], target))
                else:
                    dangling_species.append((p["grant_number"], name))

        # Device categories (build key -> node for device_models), then models and manufacturers.
        for cat in self.fetch("device_categories"):
            rid = cat.get("resource_id")
            if not rid:
                continue
            n = BID[rid]
            cat_node[cat["key"]] = n
            self.add(n, "category_key", cat.get("key"))
            self.add(n, "label", cat.get("label"))
            for meas in cat.get("measures") or []:
                self.add(n, "measures", meas)
        for dm in self.fetch("device_models"):
            rid = dm.get("resource_id")
            if not rid:
                continue
            n = BID[rid]
            self.add(n, "model_name", dm.get("model_name"))
            if dm.get("device_class") and dm["device_class"] in cat_node:
                g.add((n, BBQS["device_category"], cat_node[dm["device_class"]]))
            if dm.get("manufacturer_id") and dm["manufacturer_id"] in man_node:
                g.add((n, BBQS["manufacturer"], man_node[dm["manufacturer_id"]]))
            self.add(n, "sampling_rate_hz", dm.get("sampling_rate_hz"), cast=None)
        for man in self.fetch("device_manufacturers"):
            rid = man.get("resource_id")
            if not rid:
                continue
            n = BID[rid]
            self.add(n, "homepage_url", man.get("homepage_url"))
            for al in man.get("aliases") or []:
                self.add(n, "aliases", al)

        for pub in self.fetch("publications"):
            rid = pub.get("resource_id")
            if not rid:
                continue
            n = BID[rid]
            self.add(n, "title", pub.get("title"))
            self.add(n, "doi", pub.get("doi"))
            self.add(n, "pmid", pub.get("pmid"))
            self.add(n, "journal", pub.get("journal"))
            self.add(n, "year", pub.get("year"), cast=None)

        for o in self.fetch("organizations"):        # name/description already come from the spine row
            rid = o.get("resource_id")
            if rid:
                self.add(BID[rid], "external_url", o.get("url"))

        # ---- 3. Reified per-project role (grant_investigators) ----
        roles = 0
        for gi in self.fetch("grant_investigators"):
            n = BID["role/" + gi["id"]]
            g.add((n, RDF.type, BBQS["ProjectRole"]))
            self.add(n, "project_role", gi.get("role"))
            self.add(n, "role_source", gi.get("role_source"))
            if gi.get("grant_id") and gi["grant_id"] in grant_node:
                g.add((n, BBQS["on_project"], grant_node[gi["grant_id"]]))
            held = inv_node.get(gi.get("investigator_id"))
            if held is not None:                          # omit rather than write a dangling edge
                g.add((n, BBQS["held_by"], held))
            roles += 1

        out_path.parent.mkdir(parents=True, exist_ok=True)
        g.serialize(destination=str(out_path), format="turtle")

        counts = {}
        for _, _, o in g.triples((None, RDF.type, None)):
            counts[o.split("#")[-1]] = counts.get(o.split("#")[-1], 0) + 1
        print(f"Wrote {out_path}: {len(g)} triples")
        print("Nodes by type: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        print(f"ProjectRole edges: {roles}")
        if skipped:
            print("Skipped (deprecated/unknown resource_type, not noded): " +
                  ", ".join(f"{k}={v}" for k, v in sorted(skipped.items())))
        if dangling_species:
            print(f"\nUnresolved study_species (dangling -- a real #7 inconsistency): {len(dangling_species)}")
            for gn, name in dangling_species:
                print(f"  {gn}: {name!r} has no matching Species node")

        return out_path

    # ---- explorer (globe -> US map -> graph panel) ----------------------------------------------

    def export_explorer_json(self, out_path: Path | str | None = None) -> Path:
        """Turn the instance graph built by export() into bbqs_explorer.json for kg/explorer/index.html.

        Walks self.graph (run export() first) into {nodes, edges, orgs, unplaced_orgs,
        unplaced_projects}. Edges are tagged "asserted" (already a triple, e.g. on_project) or
        "derived" (computed here, e.g. project<->organization via NIH RePORTER, or project<->project
        affinity from shared species/keywords) -- rendered differently so nobody mistakes a computed
        tie for a triple that's actually in the exported graph. Returns out_path.
        """
        from explorer_geocode import geocode

        out_path = Path(out_path) if out_path else HERE / "explorer" / "bbqs_explorer.json"
        g = self.graph

        nodes = {}
        for s, p, o in g:
            nodes.setdefault(str(s), {"id": str(s), "type": None, "name": None, "props": {}, "triples": []})
        for s, p, o in g.triples((None, RDF.type, None)):
            nodes[str(s)]["type"] = str(o).rsplit("#", 1)[-1]

        orgs_by_name = {}
        for s, p, o in g:
            if p == RDF.type:
                continue
            node = nodes[str(s)]
            local = str(p).rsplit("#", 1)[-1]
            if isinstance(o, Literal):
                node["props"].setdefault(local, []).append(o.toPython())
                node["triples"].append([local, o.toPython()])
                if local == "name":
                    node["name"] = o.toPython()
                    if node["type"] == "ResearchOrganization":
                        orgs_by_name[str(o)] = str(s)
            else:
                node["triples"].append([local, str(o)])

        edges = []
        asserted_predicates = {"on_project", "studies_species", "part_of_org", "held_by",
                                "device_category", "manufacturer"}
        for s, p, o in g:
            local = str(p).rsplit("#", 1)[-1]
            if local in asserted_predicates and not isinstance(o, Literal):
                edges.append({"source": str(s), "target": str(o), "type": local, "class": "asserted"})

        # ---- derived: project -> organization, via NIH RePORTER (reporter_project_num) ----
        unplaced_projects = []
        projects = [(nid, n) for nid, n in nodes.items() if n["type"] == "Project"]
        for pid, pnode in projects:
            rpn = (pnode["props"].get("reporter_project_num") or [None])[0]
            gnum = (pnode["props"].get("grant_number") or [None])[0]
            org_name = self._lookup_reporter_org(rpn) if rpn else None
            if org_name and org_name in orgs_by_name:
                edges.append({"source": pid, "target": orgs_by_name[org_name], "type": "awarded_to", "class": "derived"})
            else:
                unplaced_projects.append({"grant_number": gnum, "reporter_project_num": rpn,
                                           "reason": "no reporter_project_num" if not rpn else
                                                     "RePORTER org not in graph"})

        # ---- derived: project <-> project affinity, via shared species / shared keywords ----
        species_of = {nid: set(n["props"].get("studies_species_name") or []) for nid, n in projects}
        keywords_of = {nid: set(n["props"].get("keywords") or []) for nid, n in projects}
        seen = set()
        for i, (pid_a, _) in enumerate(projects):
            for pid_b, _ in projects[i + 1:]:
                pair = (pid_a, pid_b)
                if pair in seen:
                    continue
                seen.add(pair)
                shared_species = species_of[pid_a] & species_of[pid_b]
                if shared_species:
                    edges.append({"source": pid_a, "target": pid_b, "type": "species_affinity",
                                  "class": "derived", "weight": len(shared_species)})
                shared_kw = keywords_of[pid_a] & keywords_of[pid_b]
                if len(shared_kw) >= 2:            # floor so this doesn't turn into a hairball
                    edges.append({"source": pid_a, "target": pid_b, "type": "keyword_affinity",
                                  "class": "derived", "weight": len(shared_kw)})

        # ---- orgs + geocoding ----
        org_rows, unplaced_orgs = [], []
        for name, nid in orgs_by_name.items():
            coords = geocode(name)
            if coords:
                org_rows.append({"id": nid, "name": name, "lat": coords[0], "lng": coords[1]})
            else:
                unplaced_orgs.append(name)

        # `props` was only ever an internal index (species/keyword affinity, RePORTER lookup inputs
        # above) -- every value in it is already in `triples`, so shipping both would double the
        # literal payload for nothing. Drop it right before serializing.
        shipped_nodes = [{k: v for k, v in n.items() if k != "props"} for n in nodes.values()]

        payload = {
            "nodes": shipped_nodes,
            "edges": edges,
            "orgs": org_rows,
            "unplaced_orgs": sorted(unplaced_orgs),
            "unplaced_projects": unplaced_projects,
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf8")

        print(f"Wrote {out_path}: {len(nodes)} nodes, {len(edges)} edges "
              f"({sum(1 for e in edges if e['class'] == 'derived')} derived)")
        print(f"Orgs geocoded: {len(org_rows)}, unplaced: {len(unplaced_orgs)}")
        if unplaced_projects:
            print(f"Projects without a resolved organization: {len(unplaced_projects)}")
        return out_path

    _reporter_org_cache: dict = {}

    @classmethod
    def _lookup_reporter_org(cls, reporter_project_num: str):
        """Awardee org name for a project, from NIH RePORTER's public API (no key required).

        One-time, offline lookup at explorer-build time -- the awardee organization is not in
        bbqs.ttl or any Supabase table this exporter reads, so this is the only place it exists.
        Cached per process; returns None on any network/parse failure (caller reports it as
        unplaced rather than guessing).
        """
        if reporter_project_num in cls._reporter_org_cache:
            return cls._reporter_org_cache[reporter_project_num]
        org_name = None
        try:
            body = json.dumps({
                "criteria": {"project_nums": [reporter_project_num]},
                "include_fields": ["OrganizationName"],
                "limit": 1,
            }).encode()
            req = urllib.request.Request(
                "https://api.reporter.nih.gov/v2/projects/search",
                data=body, headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                results = json.loads(r.read() or "{}").get("results") or []
            if results:
                org_name = (results[0].get("organization") or {}).get("org_name")
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError) as e:
            print(f"  ! RePORTER lookup failed for {reporter_project_num}: {e}", file=sys.stderr)
        cls._reporter_org_cache[reporter_project_num] = org_name
        return org_name

    @staticmethod
    def validate(data_file: Path | str, shape_files: list[Path] | None = None):
        """Run SHACL consistency validation over an instance graph. Returns (conforms, report_text).

        If no shapes are given, every kg/shapes/*.ttl is used. Requires:  pip install pyshacl
        """
        try:
            from pyshacl import validate as shacl_validate
        except ImportError:
            sys.exit("pyshacl is not installed. Run:  pip install pyshacl")
        import rdflib

        data_file = Path(data_file)
        shape_files = [Path(s) for s in shape_files] if shape_files else sorted(
            BBQSKnowledgeGraph.DEFAULT_SHAPES_DIR.glob("*.ttl")
        )

        data = rdflib.Graph().parse(str(data_file), format="turtle")
        shapes = rdflib.Graph()
        for s in shape_files:
            shapes.parse(str(s), format="turtle")

        conforms, _report_graph, report_text = shacl_validate(
            data, shacl_graph=shapes, advanced=True, inference="none",
        )
        print(report_text)
        print(f"conforms={conforms}  data={os.path.relpath(data_file, HERE)}  "
              f"shapes={len(shape_files)} file(s)")
        return conforms, report_text

    def run(
        self,
        out_path: Path | str | None = None,
        shape_files: list[Path] | None = None,
        explorer_path: Path | str | None = None,
    ) -> bool:
        """Run the whole pipeline in sequence, one call: export from Supabase, validate the result,
        then build the BBQS Explorer JSON from the same graph. Returns the validator's conforms bool.
        """
        out_path = self.export(out_path)
        conforms, _report_text = self.validate(out_path, shape_files)
        self.export_explorer_json(explorer_path)
        return conforms
