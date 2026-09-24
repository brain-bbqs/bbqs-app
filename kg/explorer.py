#!/usr/bin/env python3
"""Build bbqs_explorer.json for kg/explorer/index.html (the globe -> US map -> graph panel).

click CLI over `BBQSKnowledgeGraph.export_explorer_json` (see bbqs_kg.py). Runs `export()` first
(fresh Supabase pull) unless given an existing Turtle file to reuse with --from-ttl.

    python kg/explorer.py [OUT_JSON]                      # export, then build the explorer JSON
    python kg/explorer.py --from-ttl kg/export/bbqs.ttl    # reuse an already-exported graph
Requires rdflib and click (already in kg/.venv from pyshacl); the organization<->project derivation
also calls NIH RePORTER's public API (no key needed) once per project.
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
@click.option(
    "--from-ttl", "from_ttl",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Reuse an already-exported Turtle file instead of pulling from Supabase again.",
)
def main(out_path: Path | None, from_ttl: Path | None):
    """Build the BBQS Explorer JSON at OUT_PATH (default: kg/export/bbqs_explorer.json)."""
    kg = BBQSKnowledgeGraph()
    if from_ttl:
        kg.graph.parse(str(from_ttl), format="turtle")
    else:
        kg.export()
    kg.export_explorer_json(out_path)


if __name__ == "__main__":
    main()
