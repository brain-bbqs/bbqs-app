#!/usr/bin/env python3
"""Export the BBQS knowledge graph from Supabase to Turtle (the 'generate' half of the KG effort).

click CLI over `BBQSKnowledgeGraph.export` (see bbqs_kg.py) — the exporter logic itself lives on
that class so it can run as one step of the `main.py` pipeline.

The `resources` table is the node spine: one row = one IRI (https://brain-bbqs.org/id/<uuid>),
`resource_type` = rdf:type. Since the Phase-5 backfill, EVERY entity is in the spine, so every node
is minted from `resources.id` and each detail table is joined onto its spine node by `resource_id`.
An unknown/deprecated `resource_type` (e.g. the legacy `project`, superseded by `grant` since
Project=Grant) is skipped, never noded. grant_investigators becomes reified ProjectRole nodes.

Reads via PostgREST. Default role is anon (RLS-limited: investigators-table detail, field_provenance,
working-group and source_class detail are hidden — the exported graph is whatever the caller may
read). Set SUPABASE_KEY to a stronger key for the full graph.

    python kg/export.py [OUT_PATH]        # default: kg/export/bbqs.ttl
Requires rdflib and click (already in kg/.venv from pyshacl).
"""
from pathlib import Path

import click

from bbqs_kg import BBQSKnowledgeGraph


@click.command()
@click.argument(
    "out_path",
    type=click.Path(dir_okay=False, path_type=Path),
    required=False,
    default=None,
)
def main(out_path: Path | None):
    """Export the BBQS knowledge graph from Supabase to OUT_PATH (default: kg/export/bbqs.ttl)."""
    BBQSKnowledgeGraph().export(out_path)


if __name__ == "__main__":
    main()
