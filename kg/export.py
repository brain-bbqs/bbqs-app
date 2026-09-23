#!/usr/bin/env python3
"""Export the BBQS knowledge graph from Supabase to Turtle (the 'generate' half of the KG effort).

CLI wrapper over `BBQSKnowledgeGraph.export` (see bbqs_kg.py) — the exporter logic itself now lives
on that class so it can run as one step of the `main.py` pipeline.

The `resources` table is the node spine: one row = one IRI (https://brain-bbqs.org/id/<uuid>),
`resource_type` = rdf:type. Typed tables are joined onto their spine node by `resource_id`; entities
that are not yet in the spine (organizations, publications, species, devices) are minted from their
own tables with a typed IRI. Project = grants (award facet) enriched by projects (science facet) on
grant_number. grant_investigators becomes reified ProjectRole nodes.

Reads via PostgREST. Default role is anon (RLS-limited: investigators-table detail, field_provenance,
working groups and source_classes are hidden — the exported graph is whatever the caller may read).
Set SUPABASE_KEY to a stronger key for the full graph.

    python kg/export.py [out.ttl]        # default: kg/export/bbqs.ttl
Requires rdflib (already in kg/.venv from pyshacl).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbqs_kg import BBQSKnowledgeGraph


def main(out_path):
    BBQSKnowledgeGraph().export(out_path)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "export", "bbqs.ttl")
    main(out)
