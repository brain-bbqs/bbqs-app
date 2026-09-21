#!/usr/bin/env python3
"""Run SHACL consistency validation over a BBQS KG instance graph.

Usage:
    python kg/validate.py <data.ttl> [shapes.ttl ...]

If no shapes are given, every kg/shapes/*.ttl is used. Exit code is 0 when the graph is
consistent (conforms), 1 when any shape fires. Requires:  pip install pyshacl
"""
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    try:
        from pyshacl import validate
    except ImportError:
        sys.exit("pyshacl is not installed. Run:  pip install pyshacl")
    import rdflib

    data_file = argv[1]
    shape_files = argv[2:] or sorted(glob.glob(os.path.join(HERE, "shapes", "*.ttl")))

    data = rdflib.Graph().parse(data_file, format="turtle")
    shapes = rdflib.Graph()
    for s in shape_files:
        shapes.parse(s, format="turtle")

    conforms, _report_graph, report_text = validate(
        data, shacl_graph=shapes, advanced=True, inference="none",
    )
    print(report_text)
    print(f"conforms={conforms}  data={os.path.relpath(data_file, HERE)}  "
          f"shapes={len(shape_files)} file(s)")
    sys.exit(0 if conforms else 1)


if __name__ == "__main__":
    main(sys.argv)
