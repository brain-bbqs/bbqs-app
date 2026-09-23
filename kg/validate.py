#!/usr/bin/env python3
"""Run SHACL consistency validation over a BBQS KG instance graph.

CLI wrapper over `BBQSKnowledgeGraph.validate` (see bbqs_kg.py) — the validation logic itself now
lives on that class so it can run as one step of the `main.py` pipeline.

Usage:
    python kg/validate.py <data.ttl> [shapes.ttl ...]

If no shapes are given, every kg/shapes/*.ttl is used. Exit code is 0 when the graph is
consistent (conforms), 1 when any shape fires. Requires:  pip install pyshacl
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    from bbqs_kg import BBQSKnowledgeGraph

    conforms, _report_text = BBQSKnowledgeGraph.validate(argv[1], argv[2:] or None)
    sys.exit(0 if conforms else 1)


if __name__ == "__main__":
    main(sys.argv)
