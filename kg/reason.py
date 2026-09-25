#!/usr/bin/env python3
"""Run a DL reasoner (HermiT, via owlready2) over the OWL TBox + an instance graph.

click CLI over `BBQSKnowledgeGraph.reason` (see bbqs_kg.py) -- pure-logic contradictions
(disjoint classes, cardinality/range violations) that SHACL's shape checks can't catch.

    python kg/reason.py                                    # kg/export/bbqs.ttl + kg/bbqs.owl.ttl
    python kg/reason.py path/to/data.ttl --owl path/to.owl.ttl

Exit code is 0 when consistent, 1 when the reasoner finds a contradiction (matching validate.py).
Requires:  pip install owlready2  (needs a Java runtime; HermiT ships inside the package).
"""
from pathlib import Path

import click

from bbqs_kg import BBQSKnowledgeGraph


@click.command()
@click.argument(
    "data_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=False,
    default=None,
)
@click.option(
    "--owl", "owl_file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help="The OWL TBox to reason over. Default: kg/bbqs.owl.ttl.",
)
@click.pass_context
def main(ctx: click.Context, data_file: Path | None, owl_file: Path | None):
    """Check DATA_FILE (default: kg/export/bbqs.ttl) for logical contradictions against OWL_FILE."""
    consistent, _report = BBQSKnowledgeGraph.reason(data_file, owl_file)
    ctx.exit(0 if consistent else 1)


if __name__ == "__main__":
    main()
