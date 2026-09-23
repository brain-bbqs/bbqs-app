#!/usr/bin/env python3
"""Run the BBQS KG pipeline end-to-end, as one object: export from Supabase, then validate the
result against the SHACL consistency shapes.

    python kg/main.py [OUT_PATH] [--shapes SHAPE_FILE]...   # default out: kg/export/bbqs.ttl
                                                              # default shapes: kg/shapes/*.ttl

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
@click.pass_context
def main(ctx: click.Context, out_path: Path | None, shape_files: tuple[Path, ...]):
    """Export the BBQS knowledge graph from Supabase to OUT_PATH, then validate the result."""
    kg = BBQSKnowledgeGraph()
    conforms = kg.run(out_path, list(shape_files) or None)
    ctx.exit(0 if conforms else 1)


if __name__ == "__main__":
    main()
