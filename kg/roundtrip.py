#!/usr/bin/env python3
"""How close is the KG to the database? Cell by cell, for every table the graph should carry.

The goal is a one-to-one, lossless mapping: the database could be rebuilt from the graph. So for
each table this reads every row the key can see and asks, per non-null cell, whether that value is
on the row's node in the export. A cell is `carried` when some predicate on the node holds an equal
value; otherwise it is `dropped`. A row with no node at all is `unnoded`. This needs no mapping
spec, so it can't be fooled by a mapping that claims a column it never writes.

    python kg/roundtrip.py [DATA_FILE] [--json OUT]    # anon by default; SUPABASE_KEY for full access

Compare against a FRESH export: an older file makes every value edited since look dropped.

On an anon key this measures the public projection only: RLS-hidden rows and columns are out of
reach, and are reported as such rather than counted as carried.
"""
import json
from collections import defaultdict
from pathlib import Path

import click
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF

from bbqs_kg import BBQS, BID, TYPE_CLASS, BBQSKnowledgeGraph, HERE

# Columns that carry no fact about the entity: surrogate keys and join keys the node's IRI or its
# links already stand for, and bookkeeping the graph deliberately leaves out.
STRUCTURAL = {"id", "resource_id", "created_at", "updated_at", "created_by", "last_edited_by",
              "grant_id", "investigator_id", "organization_id", "project_id", "publication_id",
              "dandiset_id", "species_id", "manufacturer_id", "user_id"}

# table -> how a row finds its node. "resource_id": the spine node; "id": the row IS a spine row;
# a callable: a node minted from the row itself. Tables absent from the graph have no entry.
NODE_OF = {
    "resources": lambda r: BID[r["id"]],
    "grant_investigators": lambda r: BID["role/" + r["id"]],
}
TABLES = ["resources", "grants", "projects", "grant_investigators", "investigators_public", "organizations",
          "publications", "dandisets", "software_tools", "funding_opportunities", "announcements",
          "species", "device_models", "device_categories", "device_manufacturers",
          "investigator_organizations", "project_publications", "grant_dandisets"]


def cell_values(v):
    """The value(s) a cell contributes, normalised for comparison."""
    if v is None or v == "" or v == [] or v == {}:
        return []
    if isinstance(v, list):
        return [x for item in v for x in cell_values(item)]
    if isinstance(v, dict):
        return [json.dumps(v, sort_keys=True)]
    if isinstance(v, bool):
        return ["true" if v else "false"]
    if isinstance(v, float) and v.is_integer():
        return [str(int(v)), str(v)]
    return [str(v).strip()]


def node_values(g: Graph, node) -> set[str]:
    out = set()
    for p, o in g.predicate_objects(node):
        if p == RDF.type:
            continue
        if isinstance(o, Literal):
            py = o.toPython()
            out.update(cell_values(py if not isinstance(py, (Literal,)) else str(o)))
            out.add(str(o).strip())
        elif isinstance(o, URIRef):
            out.add(str(o))
    return out


class RoundTrip:
    def __init__(self, data_file=None):
        self.data_file = Path(data_file) if data_file else BBQSKnowledgeGraph.DEFAULT_EXPORT_PATH
        self.g = Graph().parse(str(self.data_file), format="turtle")
        self.kg = BBQSKnowledgeGraph()
        self.nodes = set(self.g.subjects(RDF.type, None))

    def node_for(self, table, row):
        if table in NODE_OF:
            return NODE_OF[table](row)
        if row.get("resource_id"):
            return BID[row["resource_id"]]
        return None

    def table(self, name) -> dict:
        try:
            rows = self.kg.fetch(name)
        except Exception as e:                                     # hidden or missing: not a verdict
            return {"table": name, "readable": False, "error": str(e)[:120]}
        if not rows:
            return {"table": name, "readable": True, "rows": 0, "note": "no rows visible to this key"}
        cols = defaultdict(lambda: {"cells": 0, "carried": 0, "examples": []})
        noded = 0
        for r in rows:
            n = self.node_for(name, r)
            has = n is not None and n in self.nodes
            noded += has
            have = node_values(self.g, n) if has else set()
            if has and name == "resources":                    # carried as rdf:type, not as a literal
                have.add(r["resource_type"]) if (n, RDF.type, BBQS[TYPE_CLASS.get(r["resource_type"], "")]) in self.g else None
            for c, v in r.items():
                if c in STRUCTURAL:
                    continue
                vals = cell_values(v)
                if not vals:
                    continue
                col = cols[c]
                col["cells"] += 1
                if has and all(x in have for x in vals):
                    col["carried"] += 1
                elif len(col["examples"]) < 2:
                    col["examples"].append(str(v)[:80])
        columns = {c: {"cells": d["cells"], "carried": d["carried"],
                       "pct": round(100 * d["carried"] / d["cells"], 1), "examples": d["examples"]}
                   for c, d in sorted(cols.items())}
        cells = sum(d["cells"] for d in columns.values())
        carried = sum(d["carried"] for d in columns.values())
        return {"table": name, "readable": True, "rows": len(rows), "noded": noded,
                "cells": cells, "carried": carried, "pct": round(100 * carried / cells, 1) if cells else None,
                "columns": columns}

    def report(self) -> dict:
        tables = [self.table(t) for t in TABLES]
        cells = sum(t.get("cells", 0) for t in tables)
        carried = sum(t.get("carried", 0) for t in tables)
        return {"data_file": self.data_file.name, "cells": cells, "carried": carried,
                "pct": round(100 * carried / cells, 1) if cells else None, "tables": tables}


@click.command()
@click.argument("data_file", type=click.Path(exists=True, dir_okay=False, path_type=Path), required=False)
@click.option("--json", "json_path", type=click.Path(dir_okay=False, path_type=Path),
              default=HERE / "export" / "roundtrip.json", show_default=True)
def main(data_file, json_path):
    """Measure how much of the database DATA_FILE carries, cell by cell."""
    rep = RoundTrip(data_file).report()
    json_path.write_text(json.dumps(rep, indent=1, ensure_ascii=False), encoding="utf-8")
    click.echo(f"overall: {rep['carried']:,} of {rep['cells']:,} fact cells carried ({rep['pct']}%)\n")
    for t in rep["tables"]:
        if not t.get("readable"):
            click.echo(f"{t['table']:28} not readable with this key")
            continue
        if not t.get("rows"):
            click.echo(f"{t['table']:28} 0 rows visible")
            continue
        dropped = [c for c, d in t["columns"].items() if d["pct"] < 100]
        click.echo(f"{t['table']:28} rows {t['rows']:>4}  noded {t['noded']:>4}  cells {t['carried']:>5}/{t['cells']:<5} "
                   f"{str(t['pct']) + '%':>6}  dropped/partial: {', '.join(dropped) if dropped else '-'}")


if __name__ == "__main__":
    main()
