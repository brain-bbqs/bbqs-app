#!/usr/bin/env python3
"""Run the whole BBQS KG pipeline, as one object, with one command: export from Supabase, validate
the result against the SHACL consistency shapes, then build the BBQS Explorer JSON from that graph.

    python kg/main.py [OUT_PATH] [--shapes SHAPE_FILE]... [--explorer-out PATH]
        # default out: kg/export/bbqs.ttl
        # default shapes: kg/shapes/*.ttl
        # default explorer out: kg/explorer/bbqs_explorer.json

Exit code is 0 when the exported graph conforms, 1 when any shape fires (matching validate.py).
Requires rdflib, pyshacl and click (kg/.venv from pyshacl already has rdflib and pyshacl).
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
    "--shapes", "shape_files",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    multiple=True,
    help="A SHACL shapes file to validate against (repeatable). Default: every kg/shapes/*.ttl.",
)
@click.option(
    "--explorer-out", "explorer_path",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Where to write the BBQS Explorer JSON. Default: kg/explorer/bbqs_explorer.json.",
)
@click.pass_context
def main(ctx: click.Context, out_path: Path | None, shape_files: tuple[Path, ...], explorer_path: Path | None):
    """Export the BBQS knowledge graph from Supabase to OUT_PATH, validate it, and build the
    Explorer JSON -- the whole pipeline, one BBQSKnowledgeGraph, one command."""
    kg = BBQSKnowledgeGraph()
    conforms = kg.run(out_path, list(shape_files) or None, explorer_path)
    ctx.exit(0 if conforms else 1)


if __name__ == "__main__":
    main()
