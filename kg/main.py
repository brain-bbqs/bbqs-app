#!/usr/bin/env python3
"""Run the whole BBQS KG pipeline, as one object, with one command:

    1. export()              -- pull from Supabase into instance Turtle
    2. validate()             -- check the export against the SHACL consistency shapes
    3. reason()               -- check the export + OWL TBox for logical contradictions (HermiT)
    4. export_explorer_json() -- build the BBQS Explorer JSON from the same graph

    python kg/main.py [OUT_PATH] [--shapes SHAPE_FILE]... [--owl PATH] [--explorer-out PATH]
        # default out: kg/export/bbqs.ttl
        # default shapes: kg/shapes/*.ttl
        # default owl: kg/bbqs.owl.ttl
        # default explorer out: kg/explorer/bbqs_explorer.json

Exit code is 0 when the exported graph conforms to the SHACL shapes, 1 when any shape fires
(matching validate.py). The OWL reasoner's result is printed but doesn't gate the exit code yet --
see kg/README.md for why. Requires rdflib, pyshacl, owlready2 (needs Java) and click.
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
    "--owl", "owl_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help="The OWL TBox to reason over. Default: kg/bbqs.owl.ttl.",
)
@click.option(
    "--explorer-out", "explorer_path",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Where to write the BBQS Explorer JSON. Default: kg/explorer/bbqs_explorer.json.",
)
@click.pass_context
def main(
    ctx: click.Context,
    out_path: Path | None,
    shape_files: tuple[Path, ...],
    owl_file: Path | None,
    explorer_path: Path | None,
):
    """Export the BBQS knowledge graph from Supabase to OUT_PATH, validate it, reason over it,
    and build the Explorer JSON -- the whole pipeline, one BBQSKnowledgeGraph, one command."""
    kg = BBQSKnowledgeGraph()
    conforms = kg.run(out_path, list(shape_files) or None, explorer_path, owl_file)
    ctx.exit(0 if conforms else 1)


if __name__ == "__main__":
    main()
