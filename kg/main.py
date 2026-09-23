#!/usr/bin/env python3
"""Run the BBQS KG pipeline end-to-end, as one object: export from Supabase, then validate the
result against the SHACL consistency shapes.

    python kg/main.py [out.ttl] [-- shape.ttl ...]   # default out: kg/export/bbqs.ttl
                                                       # default shapes: every kg/shapes/*.ttl

Exit code is 0 when the exported graph conforms, 1 when any shape fires (matching validate.py).
Requires rdflib and pyshacl (kg/.venv from pyshacl already has both).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbqs_kg import BBQSKnowledgeGraph


def main(argv):
    args = argv[1:]
    shape_files = None
    if "--" in args:
        i = args.index("--")
        shape_files = args[i + 1:] or None
        args = args[:i]
    out_path = args[0] if args else None

    kg = BBQSKnowledgeGraph()
    conforms = kg.run(out_path, shape_files)
    sys.exit(0 if conforms else 1)


if __name__ == "__main__":
    main(sys.argv)
