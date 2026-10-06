#!/usr/bin/env python3
"""Workshop sensor registry -> W3C SOSA/SSN triples (SOSA phase S0, see kg/sosa/README.md).

Reads the staged registry (workshop_sensor_registry.csv) and the two vocabularies, resolves each
row's grant and device against the committed export (kg/export/bbqs.ttl), and writes
workshop_sensors.sosa.ttl. The registry is a staging copy: phase S2 moves it into Supabase and
the exporter takes over, so nothing on the site may render from these CSVs (Principle XI).

    python kg/sosa/build_sosa.py                 # write workshop_sensors.sosa.ttl
    python kg/sosa/build_sosa.py --check         # also: RED/GREEN fixtures + the built layer
"""
import csv
import re
import sys
from pathlib import Path

import click
from pyshacl import validate
from rdflib import RDF, RDFS, XSD, Graph, Literal, Namespace, URIRef
from rdflib.namespace import DCTERMS, PROV, SKOS

HERE = Path(__file__).resolve().parent
KG = HERE.parent
BBQS = Namespace("https://brain-bbqs.org/schema#")
BID = Namespace("https://brain-bbqs.org/id/")
SOSA = Namespace("http://www.w3.org/ns/sosa/")
SSN = Namespace("http://www.w3.org/ns/ssn/")
S = Namespace(str(BID) + "sosa/")  # instance IRIs minted by this layer

SOURCE = S["source/workshop-2026-appendix-a"]
SHAPES = HERE / "sosa.shapes.ttl"
OUT = HERE / "workshop_sensors.sosa.ttl"
RED = HERE / "fixtures" / "contradictions.ttl"
GREEN = HERE / "fixtures" / "clean.ttl"

GRANT_MATCH = {"stated", "pi_roster", "institution", "title", "ambiguous", "unresolved"}
MODEL_STATUS = {"compiled", "inferred", "candidates", "custom", "unspecified"}
SYSTEM_KIND = {"sensor", "platform", "sensor_actuator"}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def split(cell: str) -> list[str]:
    return [v.strip() for v in (cell or "").split(";") if v.strip()]


def read_csv(name: str) -> list[dict]:
    with open(HERE / name, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def index_export(export: Graph):
    """Name -> node maps for the entities the registry points at."""
    projects = {str(gn).lstrip("0123456789"): p for p, gn in export.subject_objects(BBQS.grant_number)}
    devices = {str(n): d for d in export.subjects(RDF.type, BBQS.Device) for n in export.objects(d, BBQS.name)}
    categories = {str(k): c for c, k in export.subject_objects(BBQS.category_key)}
    return projects, devices, categories


def build(export_path: Path) -> tuple[Graph, list[str]]:
    export = Graph().parse(export_path)
    projects, devices, categories = index_export(export)
    g = Graph()
    for p, ns in [("bbqs", BBQS), ("bid", BID), ("sosa", SOSA), ("ssn", SSN), ("prov", PROV),
                  ("skos", SKOS), ("dcterms", DCTERMS)]:
        g.bind(p, ns)
    warnings: list[str] = []

    g.add((SOURCE, RDF.type, PROV.Entity))
    g.add((SOURCE, DCTERMS.title, Literal("BBQS workshop 2026 - Appendix A, sensor and device registry")))
    g.add((SOURCE, RDFS.comment, Literal(
        "Device, award and presenter are as spoken at the workshop. Manufacturer, HQ and model were "
        "compiled afterwards from vendor and peer-reviewed sources; the decks carry no manufacturer fields.")))

    props = {}
    for row in read_csv("observable_properties.csv"):
        n = props[row["key"]] = S["property/" + row["key"]]
        g.add((n, RDF.type, SOSA.ObservableProperty))
        g.add((n, SKOS.notation, Literal(row["key"])))
        g.add((n, SKOS.prefLabel, Literal(row["label"])))
        g.add((n, SKOS.definition, Literal(row["definition"])))
        if row["category_key"]:
            if row["category_key"] in categories:
                g.add((n, BBQS.aligns_category, categories[row["category_key"]]))
            else:
                warnings.append(f"property {row['key']}: category {row['category_key']} not in export")
        if row["category_measure"]:
            g.add((n, BBQS.category_measure, Literal(row["category_measure"])))
    actuatable = {}
    for row in read_csv("actuatable_properties.csv"):
        n = actuatable[row["key"]] = S["actuatable/" + row["key"]]
        g.add((n, RDF.type, SOSA.ActuatableProperty))
        g.add((n, SKOS.notation, Literal(row["key"])))
        g.add((n, SKOS.prefLabel, Literal(row["label"])))
        g.add((n, SKOS.definition, Literal(row["definition"])))
    foi_kind = {r["key"]: r["foi"] for r in read_csv("observable_properties.csv")}

    deployments: dict[str, URIRef] = {}
    for row in read_csv("workshop_sensor_registry.csv"):
        rid = row["row_id"]
        for col, allowed in [("grant_match", GRANT_MATCH), ("model_status", MODEL_STATUS), ("system_kind", SYSTEM_KIND)]:
            if row[col] not in allowed:
                raise SystemExit(f"{rid}: {col}={row[col]!r} not in {sorted(allowed)}")
        observes = split(row["observes"])
        unknown = [p for p in observes + split(row["actuates"]) if p not in props and p not in actuatable]
        if unknown:
            raise SystemExit(f"{rid}: unknown property key(s) {unknown}")

        # One deployment per award: everything a project uses, deployed on that project's subjects.
        key = row["grant_number"] or slug(row["award_label"])
        dep = S[f"deployment/{key}"]
        if key not in deployments:
            deployments[key] = dep
            g.add((dep, RDF.type, SSN.Deployment))
            g.add((dep, RDFS.label, Literal(f"Sensors deployed on {row['grant_number'] or row['award_label']}")))
            g.add((dep, BBQS.award_label, Literal(row["award_label"])))
            g.add((dep, BBQS.grant_match, Literal(row["grant_match"])))
            if row["grant_note"]:
                g.add((dep, BBQS.grant_note, Literal(row["grant_note"])))
            g.add((dep, PROV.wasDerivedFrom, SOURCE))
            project = projects.get(row["grant_number"])
            if project is not None:
                g.add((dep, BBQS.on_project, project))
            elif row["grant_number"]:
                warnings.append(f"{rid}: grant {row['grant_number']} not in export")
        project = g.value(dep, BBQS.on_project)

        # Features of interest: the study subjects (and, where measured, their environment).
        for kind in {foi_kind.get(p, "subject") for p in observes}:
            foi = S[f"foi/{key}/{kind}"]
            if (dep, BBQS.deployment_foi, foi) not in g:
                g.add((foi, RDF.type, SOSA.FeatureOfInterest))
                g.add((foi, RDFS.label, Literal(
                    f"{'Study subjects' if kind == 'subject' else 'Environment of the study subjects'} of {key}")))
                g.add((dep, BBQS.deployment_foi, foi))
                if kind == "subject" and project is not None:
                    for sp in export.objects(project, BBQS.studies_species):
                        g.add((foi, BBQS.studies_species, sp))
            for p in observes:
                if foi_kind.get(p, "subject") == kind:
                    g.add((foi, SSN.hasProperty, props[p]))

        sysn = S[f"system/{key}/{slug(row['device_as_named'])}"]
        if (sysn, None, None) in g:
            raise SystemExit(f"{rid}: duplicate device for {key}: {row['device_as_named']}")
        g.add((dep, SSN.deployedSystem, sysn))
        g.add((sysn, SSN.hasDeployment, dep))
        g.add((sysn, RDFS.label, Literal(row["device_as_named"])))
        g.add((sysn, BBQS.workshop_row, Literal(rid)))
        g.add((sysn, PROV.wasDerivedFrom, SOURCE))
        g.add((sysn, BBQS.presenter_present, Literal(row["presenter_present"] == "yes", datatype=XSD.boolean)))
        for col in ["presenter_role", "verify_note", "manufacturer", "manufacturer_hq", "model", "measures_as_recorded"]:
            if row[col]:
                pred = {"manufacturer": "manufacturer_recorded", "manufacturer_hq": "manufacturer_hq_recorded",
                        "model": "model_recorded", "measures_as_recorded": "measures_recorded"}.get(col, col)
                g.add((sysn, BBQS[pred], Literal(row[col])))
        g.add((sysn, BBQS.model_status, Literal(row["model_status"])))
        for name in split(row["kg_devices"]):
            if name in devices:
                g.add((sysn, BBQS.device_model, devices[name]))
            else:
                warnings.append(f"{rid}: device {name!r} not in export")

        if row["system_kind"] == "platform":
            # A multi-modal rig: one hosted sensor per observed property, so each modality can carry
            # its own observations later (S4) without re-minting the platform.
            g.add((sysn, RDF.type, SOSA.Platform))
            for p in observes:
                hs = S[f"system/{key}/{slug(row['device_as_named'])}/{p}"]
                g.add((hs, RDF.type, SOSA.Sensor))
                g.add((hs, RDFS.label, Literal(f"{row['device_as_named']} - {g.value(props[p], SKOS.prefLabel)}")))
                g.add((hs, SOSA.observes, props[p]))
                g.add((sysn, SOSA.hosts, hs))
                g.add((hs, SOSA.isHostedBy, sysn))
        else:
            g.add((sysn, RDF.type, SOSA.Sensor))
            for p in observes:
                g.add((sysn, SOSA.observes, props[p]))
        if row["system_kind"] == "sensor_actuator":
            g.add((sysn, RDF.type, SOSA.Actuator))
            for a in split(row["actuates"]):
                g.add((sysn, SSN.forProperty, actuatable[a]))
    return g, warnings


SH = Namespace("http://www.w3.org/ns/shacl#")


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
    g, warnings = build(export_path)
    g.serialize(out, format="turtle")
    n = lambda c: len(set(g.subjects(RDF.type, c)))
    print(f"wrote {out.relative_to(KG.parent) if out.is_relative_to(KG.parent) else out}: {len(g)} triples -- "
          f"{n(SSN.Deployment)} deployments, {n(SOSA.Platform)} platforms, {n(SOSA.Sensor)} sensors, "
          f"{n(SOSA.Actuator)} actuators, {n(SOSA.ObservableProperty)} observable properties, "
          f"{n(SOSA.FeatureOfInterest)} features of interest")
    for w in warnings:
        print(f"  ! {w}")
    if not check:
        return
    errors = []
    _, fired, _ = run_shapes(Graph().parse(RED))
    for missing in sorted(shape_names() - fired):
        errors.append(f"RED: {missing} did not fire on {RED.name}")
    ok, _, text = run_shapes(Graph().parse(GREEN))
    if not ok:
        errors.append(f"GREEN: {GREEN.name} does not conform\n{text}")
    # Shapes that resolve IRIs (bbqs:Project, bbqs:Device) need the export alongside the layer.
    ok, _, text = run_shapes(g + Graph().parse(export_path))
    if not ok:
        errors.append(f"built layer does not conform\n{text}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        raise SystemExit(1)
    print(f"check: {len(shape_names())} shapes fire on RED, GREEN conforms, built layer conforms")


if __name__ == "__main__":
    main()
