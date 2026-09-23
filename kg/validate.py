#!/usr/bin/env python3
"""Run SHACL consistency validation over a BBQS KG instance graph.

click CLI over `BBQSKnowledgeGraph.validate` (see bbqs_kg.py) — the validation logic itself lives
on that class so it can run as one step of the `main.py` pipeline.

Usage:
    python kg/validate.py DATA_FILE [SHAPE_FILES ...]

If no shapes are given, every kg/shapes/*.ttl is used. Exit code is 0 when the graph is
consistent (conforms), 1 when any shape fires. Requires:  pip install pyshacl click
"""
from pathlib import Path

import click

from bbqs_kg import BBQSKnowledgeGraph


@click.command()
@click.argument("data_file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.argument("shape_files", type=click.Path(exists=True, dir_okay=False, path_type=Path), nargs=-1)
@click.pass_context
def main(ctx: click.Context, data_file: Path, shape_files: tuple[Path, ...]):
    """Validate DATA_FILE against SHAPE_FILES (default: every kg/shapes/*.ttl)."""
    conforms, _report_text = BBQSKnowledgeGraph.validate(data_file, list(shape_files) or None)
    ctx.exit(0 if conforms else 1)


if __name__ == "__main__":
    main()
