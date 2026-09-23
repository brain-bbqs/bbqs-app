#!/usr/bin/env python3
"""Export the BBQS knowledge graph from Supabase to Turtle (the 'generate' half of the KG effort).

The `resources` table is the node spine: one row = one IRI (https://brain-bbqs.org/id/<uuid>),
`resource_type` = rdf:type. Since the Phase-5 backfill, EVERY entity is in the spine, so every node
is minted from `resources.id` and each detail table is joined onto its spine node by `resource_id`.
An unknown/deprecated `resource_type` (e.g. the legacy `project`, superseded by `grant` since
Project=Grant) is skipped, never noded. grant_investigators becomes reified ProjectRole nodes.

Reads via PostgREST. Default role is anon (RLS-limited: investigators-table detail, field_provenance,
working-group and source_class detail are hidden — the exported graph is whatever the caller may
read). Set SUPABASE_KEY to a stronger key for the full graph.

    python kg/export.py [out.ttl]        # default: kg/export/bbqs.ttl
Requires rdflib (already in kg/.venv from pyshacl).
"""
import collections
import json
import os
import re
import sys
import urllib.error
import urllib.request

from rdflib import Graph, Literal, Namespace
from rdflib.namespace import RDF


def _client_default(js_const):
    """Read a public fallback value from the app's supabase client (single source of truth).

    Avoids duplicating the publishable anon key into this file; env vars still win.
    """
    path = os.path.join(os.path.dirname(__file__), "..", "src", "integrations", "supabase", "client.ts")
    try:
        txt = open(path, encoding="utf8").read()
    except OSError:
        return None
    m = re.search(js_const + r'\s*\|\|\s*"([^"]+)"', txt)
    return m.group(1) if m else None


URL = (os.environ.get("SUPABASE_URL") or _client_default("VITE_SUPABASE_URL") or "").rstrip("/")
KEY = os.environ.get("SUPABASE_KEY") or _client_default("VITE_SUPABASE_PUBLISHABLE_KEY") or ""
if not URL or not KEY:
    raise SystemExit(
        "Set SUPABASE_URL and SUPABASE_KEY, or run from the repo so kg/export.py can read the "
        "public values from src/integrations/supabase/client.ts."
    )
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


def fetch(table, select="*"):
    """All rows of a table via PostgREST (tables here are < 1000 rows, so one request)."""
    req = urllib.request.Request(
        f"{URL}/rest/v1/{table}?select={select}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Range": "0-9999"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or "[]")
    except urllib.error.HTTPError as e:
        print(f"  ! {table}: HTTP {e.code} (RLS hidden or missing)", file=sys.stderr)
        return []


def mechanism(grant_number):
    """NIH activity code (R61/U01/RF1/R34/…) parsed from the grant number."""
    m = re.search(r"([A-Z]{1,3}\d{2})", grant_number or "")
    return m.group(1) if m else None


def add(g, subj, pred, value, cast=str):
    if value is not None and value != "":
        g.add((subj, BBQS[pred], Literal(cast(value)) if cast else Literal(value)))


def main(out_path):
    g = Graph()
    g.bind("bbqs", BBQS)
    g.bind("bid", BID)

    # ---- id -> spine IRI maps (every entity is now in the resources spine) ----
    def id_map(table):
        return {r["id"]: BID[r["resource_id"]]
                for r in fetch(table, "id,resource_id") if r.get("resource_id")}

    org_node = id_map("organizations")
    man_node = id_map("device_manufacturers")
    inv_node = id_map("investigators")          # RLS-hidden under anon -> {} -> held_by omitted
    grant_node, gn_node, cat_node = {}, {}, {}

    # ---- 1. Node spine: one node per resources row, typed by resource_type ----
    skipped = collections.Counter()
    for r in fetch("resources"):
        cls = TYPE_CLASS.get(r["resource_type"])
        if cls is None:                          # deprecated/unknown type (e.g. legacy 'project')
            skipped[r["resource_type"]] += 1
            continue
        n = BID[r["id"]]
        g.add((n, RDF.type, BBQS[cls]))
        add(g, n, "name", r.get("name"))
        add(g, n, "description", r.get("description"))
        add(g, n, "external_url", r.get("external_url"))
        if r.get("organization_id") and r["organization_id"] in org_node:
            g.add((n, BBQS["part_of_org"], org_node[r["organization_id"]]))

    # ---- 2. Detail: attach each table's columns to its spine node (by resource_id) ----
    # Project = grants (award facet) enriched by projects (science facet), both on the grant's node.
    for gr in fetch("grants"):
        rid = gr.get("resource_id")
        if not rid:
            continue
        n = BID[rid]
        grant_node[gr["id"]] = n
        gn_node[gr["grant_number"]] = n
        add(g, n, "grant_number", gr.get("grant_number"))
        add(g, n, "mechanism", mechanism(gr.get("grant_number")))
        add(g, n, "title", gr.get("title"))
        add(g, n, "abstract", gr.get("abstract"))
        add(g, n, "nih_link", gr.get("nih_link"))
        add(g, n, "reporter_project_num", gr.get("reporter_project_num"))
        add(g, n, "award_amount", gr.get("award_amount"), cast=None)
        add(g, n, "fiscal_year", gr.get("fiscal_year"), cast=None)

    # Species detail + a resolver that folds species_aliases (synonyms / scientific names).
    species_by_name, species_rows = {}, []
    for sp in fetch("species"):
        rid = sp.get("resource_id")
        if not rid:
            continue
        n = BID[rid]
        species_rows.append((n, sp))
        add(g, n, "common_name", sp.get("common_name"))
        add(g, n, "taxonomy_class", sp.get("taxonomy_class"))
        for key in (sp.get("name"), sp.get("common_name")):
            if key:
                species_by_name.setdefault(key.strip().lower(), n)

    aliases = fetch("species_aliases")
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
                add(g, target, "aliases", form)

    def resolve_species(value):
        v = str(value).strip().lower()
        if v in species_by_name:
            return species_by_name[v]
        c = canon_of.get(v)
        if c:
            return iri_of_canon.get(c) or species_by_name.get(c)
        return None

    dangling_species = []
    for p in fetch("projects"):
        n = gn_node.get(p["grant_number"])
        if n is None:
            continue
        add(g, n, "website", p.get("website"))
        add(g, n, "onboarding_status", p.get("onboarding_status"))
        if p.get("study_human") is not None:
            g.add((n, BBQS["studies_human"], Literal(bool(p["study_human"]))))
        for kw in p.get("keywords") or []:
            add(g, n, "keywords", kw)
        for name in p.get("study_species") or []:
            add(g, n, "studies_species_name", name)  # the raw claim, verbatim
            target = resolve_species(name)
            if target is not None:
                g.add((n, BBQS["studies_species"], target))
            else:
                dangling_species.append((p["grant_number"], name))

    # Device categories (build key -> node for device_models), then device models, manufacturers.
    for cat in fetch("device_categories"):
        rid = cat.get("resource_id")
        if not rid:
            continue
        n = BID[rid]
        cat_node[cat["key"]] = n
        add(g, n, "category_key", cat.get("key"))
        add(g, n, "label", cat.get("label"))
        for meas in cat.get("measures") or []:
            add(g, n, "measures", meas)
    for dm in fetch("device_models"):
        rid = dm.get("resource_id")
        if not rid:
            continue
        n = BID[rid]
        add(g, n, "model_name", dm.get("model_name"))
        if dm.get("device_class") and dm["device_class"] in cat_node:
            g.add((n, BBQS["device_category"], cat_node[dm["device_class"]]))
        if dm.get("manufacturer_id") and dm["manufacturer_id"] in man_node:
            g.add((n, BBQS["manufacturer"], man_node[dm["manufacturer_id"]]))
        add(g, n, "sampling_rate_hz", dm.get("sampling_rate_hz"), cast=None)
    for man in fetch("device_manufacturers"):
        rid = man.get("resource_id")
        if not rid:
            continue
        n = BID[rid]
        add(g, n, "homepage_url", man.get("homepage_url"))
        for al in man.get("aliases") or []:
            add(g, n, "aliases", al)

    for pub in fetch("publications"):
        rid = pub.get("resource_id")
        if not rid:
            continue
        n = BID[rid]
        add(g, n, "title", pub.get("title"))
        add(g, n, "doi", pub.get("doi"))
        add(g, n, "pmid", pub.get("pmid"))
        add(g, n, "journal", pub.get("journal"))
        add(g, n, "year", pub.get("year"), cast=None)

    for o in fetch("organizations"):            # name/description already come from the spine row
        rid = o.get("resource_id")
        if rid:
            add(g, BID[rid], "external_url", o.get("url"))

    # ---- 3. Reified per-project role (grant_investigators) ----
    roles = 0
    for gi in fetch("grant_investigators"):
        n = BID["role/" + gi["id"]]
        g.add((n, RDF.type, BBQS["ProjectRole"]))
        add(g, n, "project_role", gi.get("role"))
        add(g, n, "role_source", gi.get("role_source"))
        if gi.get("grant_id") and gi["grant_id"] in grant_node:
            g.add((n, BBQS["on_project"], grant_node[gi["grant_id"]]))
        held = inv_node.get(gi.get("investigator_id"))
        if held is not None:                         # omit rather than write a dangling edge
            g.add((n, BBQS["held_by"], held))
        roles += 1

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    g.serialize(destination=out_path, format="turtle")

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


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "export", "bbqs.ttl")
    main(out)
