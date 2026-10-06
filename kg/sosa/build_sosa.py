#!/usr/bin/env python3
"""What the exporter will emit for the SOSA layer, before the ingestion migration is applied.

The SOSA layer comes from the database: data ingestion (ingest/README.md) promotes records into
`sensor_deployments` and its link tables, and `BBQSKnowledgeGraph.export()` turns those rows into
SOSA/SSN. This script runs that same exporter over SIMULATED tables:
  * the staged ingestion records (ingest/sources/*/records.csv), promoted the way
    promote_ingestion_record() does it, and
  * grants, device models and categories taken from the committed export (kg/export/bbqs.ttl).
It writes the SOSA part of the result. There is no second implementation to drift: once the
migration is applied, a live export emits these triples.

    python kg/sosa/build_sosa.py              # write kg/sosa/workshop_sensors.sosa.ttl
    python kg/sosa/build_sosa.py --check      # also gate: RED/GREEN fixtures + the built layer
"""
import contextlib
import csv
import io
import json
import re
import sys
import tempfile
from pathlib import Path

import click
from pyshacl import validate
from rdflib import RDF, Graph, Namespace, URIRef

HERE = Path(__file__).resolve().parent
KG = HERE.parent
ROOT = KG.parent
sys.path.insert(0, str(KG))
from bbqs_kg import BBQS, BBQSKnowledgeGraph  # noqa: E402
from sosa_layer import S  # noqa: E402

INGEST = ROOT / "ingest"
SHAPES = HERE / "sosa.shapes.ttl"
OUT = HERE / "workshop_sensors.sosa.ttl"
RED = HERE / "fixtures" / "contradictions.ttl"
GREEN = HERE / "fixtures" / "clean.ttl"
SH = Namespace("http://www.w3.org/ns/shacl#")


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return [{k: (v if v != "" else None) for k, v in r.items()} for r in csv.DictReader(f)]


def simulated_tables(export: Graph) -> dict[str, list[dict]]:
    """The rows the database will hold once both ingestion migrations are applied."""
    uuid = lambda n: str(n).rsplit("/", 1)[-1]
    grants = [{"id": f"grant:{gn}", "resource_id": uuid(p), "grant_number": str(gn)}
              for p, gn in export.subject_objects(BBQS.grant_number)]
    models = [{"id": f"dm:{uuid(d)}", "resource_id": uuid(d), "model_name": str(n), "aliases": []}
              for d in export.subjects(RDF.type, BBQS.Device) for n in export.objects(d, BBQS.name)]
    cats = [{"key": str(k), "resource_id": uuid(c)} for c, k in export.subject_objects(BBQS.category_key)]
    by_number = {re.sub(r"^\d", "", g["grant_number"]): g["id"] for g in grants}
    by_model = {m["model_name"]: m["id"] for m in models} | {a: m["id"] for m in models for a in m["aliases"]}

    tables = {"grants": grants, "device_models": models, "device_categories": cats,
              "observable_properties": read_csv(INGEST / "vocab" / "sensor_properties.csv"),
              "ingestion_sources": [], "sensor_deployments": [],
              "sensor_deployment_devices": [], "sensor_deployment_properties": []}
    for src_dir in sorted((INGEST / "sources").iterdir()):
        source = json.loads((src_dir / "source.json").read_text(encoding="utf-8"))
        if source["record_kind"] != "sensor_deployment":
            continue
        sid = f"source:{source['slug']}"
        tables["ingestion_sources"].append({"id": sid, **{k: source[k] for k in ("slug", "title", "description")}})
        for r in read_csv(src_dir / source["records"]):
            # promote_ingestion_record(), step for step.
            gid = None
            if r["grant_number"]:
                gid = by_number.get(r["grant_number"])
                if gid is None:
                    raise SystemExit(f"{r['source_locator']}: grant {r['grant_number']} is not in the export")
            did = f"dep:{source['slug']}:{r['source_locator']}"
            tables["sensor_deployments"].append({
                "id": did, "grant_id": gid, "source_id": sid, "presenter_present": r["presenter_present"] == "yes",
                **{k: r[k] for k in ("award_label", "grant_match", "grant_note", "label_as_named", "system_kind",
                                     "presenter_role", "verify_note", "manufacturer_recorded",
                                     "manufacturer_hq_recorded", "model_recorded", "model_status",
                                     "measures_recorded", "source_locator")}})
            for name in (r["device_models"] or "").split(";"):
                if name.strip() and name.strip() in by_model:
                    tables["sensor_deployment_devices"].append({"deployment_id": did, "device_model_id": by_model[name.strip()]})
            for role in ("observes", "actuates"):
                for key in (r[role] or "").split(";"):
                    if key.strip():
                        tables["sensor_deployment_properties"].append(
                            {"deployment_id": did, "property_key": key.strip(), "role": role})
    return tables


def build(export_path: Path) -> tuple[Graph, str]:
    """Run the real exporter over the simulated tables, seeded with the committed export so project
    nodes carry their species. Returns the SOSA subgraph (every node minted under bid:sosa/)."""
    export = Graph().parse(export_path)
    tables = simulated_tables(export)
    kg = BBQSKnowledgeGraph(url="offline:", key="offline")
    kg.graph = Graph()
    for t in export:
        kg.graph.add(t)
    kg.fetch = lambda table, select="*": tables.get(table, [])
    log = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(log):
        kg.export(Path(tmp) / "full.ttl")
    sosa = Graph()
    for prefix, ns in kg.graph.namespaces():
        sosa.bind(prefix, ns)
    for t in kg.graph.triples((None, None, None)):
        if str(t[0]).startswith(str(S)):
            sosa.add(t)
    return sosa, "\n".join(l for l in log.getvalue().splitlines() if "sosa" in l.lower())


def run_shapes(data: Graph) -> tuple[bool, set[str], str]:
    """Validate, and name the node shapes that fired (a property shape reports as its blank node)."""
    sg = Graph().parse(SHAPES)
    conforms, results, text = validate(data, shacl_graph=sg, advanced=True)
    owner = lambda s: s if isinstance(s, URIRef) else sg.value(None, SH.property, s)
    fired = {str(owner(s)).rsplit("#", 1)[-1] for s in results.objects(None, SH.sourceShape)}
    return conforms, fired, text


def shape_names() -> set[str]:
    sg = Graph().parse(SHAPES)
    return {str(s).rsplit("#", 1)[-1] for s in sg.subjects(RDF.type, SH.NodeShape)}


@click.command()
@click.option("--export", "export_path", type=click.Path(exists=True, path_type=Path),
              default=KG / "export" / "bbqs.ttl", show_default=True)
@click.option("--out", type=click.Path(path_type=Path), default=OUT, show_default=True)
@click.option("--check", is_flag=True, help="Fail unless every shape fires on RED, GREEN conforms, and the built layer conforms.")
def main(export_path: Path, out: Path, check: bool):
    from sosa_layer import SOSA, SSN
    g, log = build(export_path)
    g.serialize(out, format="turtle")
    n = lambda c: len(set(g.subjects(RDF.type, c)))
    print(f"wrote {out}: {len(g)} triples -- {n(SSN.Deployment)} deployments, {n(SOSA.Platform)} platforms, "
          f"{n(SOSA.Sensor)} sensors, {n(SOSA.Actuator)} actuators, {n(SOSA.ObservableProperty)} observable "
          f"properties, {n(SOSA.FeatureOfInterest)} features of interest")
    if log:
        print(log)
    if not check:
        return
    errors = []
    _, fired, _ = run_shapes(Graph().parse(RED))
    errors += [f"RED: {s} did not fire on {RED.name}" for s in sorted(shape_names() - fired)]
    ok, _, text = run_shapes(Graph().parse(GREEN))
    if not ok:
        errors.append(f"GREEN: {GREEN.name} does not conform\n{text}")
    # Two shapes resolve IRIs into the core graph (bbqs:Project, bbqs:Device), so check with the export.
    ok, _, text = run_shapes(g + Graph().parse(export_path))
    if not ok:
        errors.append(f"built layer does not conform\n{text}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        raise SystemExit(1)
    print(f"check: {len(shape_names())} shapes fire on RED, GREEN conforms, built layer conforms")


if __name__ == "__main__":
    main()
