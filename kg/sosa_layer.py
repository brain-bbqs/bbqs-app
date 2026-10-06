"""SOSA/SSN emitter shared by the exporter and the offline check (kg/sosa/README.md).

One function turns sensor-deployment rows into SOSA triples. `bbqs_kg.export()` calls it with
rows read from Supabase (`sensor_deployments` and its link tables, filled by the data ingestion
layer, ingest/README.md). `kg/sosa/build_sosa.py` calls it with the staged ingestion records,
resolved against the committed export, before the migration is applied. Both callers produce the
same triples for the same data, so the offline build is the exporter's acceptance test.

Row shape (keys are the `sensor_deployments` column names):
    award_label, grant_number, project (node or None), grant_match, grant_note, label_as_named,
    system_kind, presenter_role, presenter_present, verify_note, manufacturer_recorded,
    manufacturer_hq_recorded, model_recorded, model_status, measures_recorded, source_locator,
    devices [Device nodes], observes [property keys], actuates [property keys],
    source {slug, title, description}
"""
import re

from rdflib import RDF, RDFS, XSD, Graph, Literal, Namespace, URIRef
from rdflib.namespace import DCTERMS, PROV, SKOS

BBQS = Namespace("https://brain-bbqs.org/schema#")
BID = Namespace("https://brain-bbqs.org/id/")
SOSA = Namespace("http://www.w3.org/ns/sosa/")
SSN = Namespace("http://www.w3.org/ns/ssn/")
S = Namespace(str(BID) + "sosa/")

RECORDED = ["presenter_role", "verify_note", "manufacturer_recorded", "manufacturer_hq_recorded",
            "model_recorded", "measures_recorded"]


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def bind(g: Graph):
    for p, ns in [("sosa", SOSA), ("ssn", SSN), ("prov", PROV), ("skos", SKOS), ("dcterms", DCTERMS)]:
        g.bind(p, ns)


def emit_sosa(g: Graph, vocab: list[dict], deployments: list[dict], category_node: dict) -> list[str]:
    """Add the SOSA layer to g. Returns warnings (unknown keys, unresolvable categories)."""
    bind(g)
    warnings: list[str] = []
    prop, kind_of, foi_of = {}, {}, {}
    for v in vocab:
        actuatable = v.get("property_kind") == "actuatable"
        n = prop[v["key"]] = S[("actuatable/" if actuatable else "property/") + v["key"]]
        kind_of[v["key"]] = "actuatable" if actuatable else "observable"
        foi_of[v["key"]] = v.get("foi_kind") or "subject"
        g.add((n, RDF.type, SOSA.ActuatableProperty if actuatable else SOSA.ObservableProperty))
        g.add((n, SKOS.notation, Literal(v["key"])))
        g.add((n, SKOS.prefLabel, Literal(v["label"])))
        if v.get("definition"):
            g.add((n, SKOS.definition, Literal(v["definition"])))
        if v.get("category_key"):
            if v["category_key"] in category_node:
                g.add((n, BBQS.aligns_category, category_node[v["category_key"]]))
            else:
                warnings.append(f"property {v['key']}: device category {v['category_key']} not in graph")
        if v.get("category_measure"):
            g.add((n, BBQS.category_measure, Literal(v["category_measure"])))

    deps: dict[str, URIRef] = {}
    for row in deployments:
        where = f"{row.get('source_locator') or row['label_as_named']}"
        bad = [k for k in row.get("observes", []) if kind_of.get(k) != "observable"] + \
              [k for k in row.get("actuates", []) if kind_of.get(k) != "actuatable"]
        if bad:
            warnings.append(f"{where}: unknown or mis-kinded property key(s) {bad}; row skipped")
            continue
        src = row["source"]
        src_node = S["source/" + src["slug"]]
        g.add((src_node, RDF.type, PROV.Entity))
        g.add((src_node, DCTERMS.title, Literal(src["title"])))
        if src.get("description"):
            g.add((src_node, RDFS.comment, Literal(src["description"])))

        # One deployment per award: everything a project uses, on that project's subjects.
        key = row.get("grant_number") or slug(row["award_label"])
        dep = S[f"deployment/{key}"]
        project = row.get("project")
        if key not in deps:
            deps[key] = dep
            g.add((dep, RDF.type, SSN.Deployment))
            g.add((dep, RDFS.label, Literal(f"Sensors deployed on {row.get('grant_number') or row['award_label']}")))
            g.add((dep, BBQS.award_label, Literal(row["award_label"])))
            g.add((dep, BBQS.grant_match, Literal(row["grant_match"])))
            if row.get("grant_note"):
                g.add((dep, BBQS.grant_note, Literal(row["grant_note"])))
            g.add((dep, PROV.wasDerivedFrom, src_node))
            if project is not None:
                g.add((dep, BBQS.on_project, project))

        observes = row.get("observes", [])
        for kind in {foi_of[p] for p in observes}:
            foi = S[f"foi/{key}/{kind}"]
            if (dep, BBQS.deployment_foi, foi) not in g:
                g.add((foi, RDF.type, SOSA.FeatureOfInterest))
                g.add((foi, RDFS.label, Literal(
                    f"{'Study subjects' if kind == 'subject' else 'Environment of the study subjects'} of {key}")))
                g.add((dep, BBQS.deployment_foi, foi))
                if kind == "subject" and project is not None:
                    for sp in g.objects(project, BBQS.studies_species):
                        g.add((foi, BBQS.studies_species, sp))
            for p in observes:
                if foi_of[p] == kind:
                    g.add((foi, SSN.hasProperty, prop[p]))

        sysn = S[f"system/{key}/{slug(row['label_as_named'])}"]
        g.add((dep, SSN.deployedSystem, sysn))
        g.add((sysn, SSN.hasDeployment, dep))
        g.add((sysn, RDFS.label, Literal(row["label_as_named"])))
        g.add((sysn, PROV.wasDerivedFrom, src_node))
        if row.get("source_locator"):
            g.add((sysn, BBQS.source_locator, Literal(row["source_locator"])))
        g.add((sysn, BBQS.presenter_present, Literal(bool(row["presenter_present"]), datatype=XSD.boolean)))
        for col in RECORDED:
            if row.get(col):
                g.add((sysn, BBQS[col], Literal(row[col])))
        g.add((sysn, BBQS.model_status, Literal(row["model_status"])))
        for d in row.get("devices", []):
            g.add((sysn, BBQS.device_model, d))

        if row["system_kind"] == "platform":
            # A multi-modal rig: one hosted sensor per property, so observations can attach per modality.
            g.add((sysn, RDF.type, SOSA.Platform))
            for p in observes:
                hs = S[f"system/{key}/{slug(row['label_as_named'])}/{p}"]
                g.add((hs, RDF.type, SOSA.Sensor))
                g.add((hs, RDFS.label, Literal(f"{row['label_as_named']} - {g.value(prop[p], SKOS.prefLabel)}")))
                g.add((hs, SOSA.observes, prop[p]))
                g.add((sysn, SOSA.hosts, hs))
                g.add((hs, SOSA.isHostedBy, sysn))
        else:
            g.add((sysn, RDF.type, SOSA.Sensor))
            for p in observes:
                g.add((sysn, SOSA.observes, prop[p]))
        if row["system_kind"] == "sensor_actuator":
            g.add((sysn, RDF.type, SOSA.Actuator))
            for a in row.get("actuates", []):
                g.add((sysn, SSN.forProperty, prop[a]))
    return warnings
