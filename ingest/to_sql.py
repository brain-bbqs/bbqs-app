#!/usr/bin/env python3
"""Staged ingestion records -> a seed migration (ingest/README.md).

Validates every record in ingest/sources/<source>/records.csv against its kind's JSON Schema
(ingest/kinds/<kind>.schema.json), computes review flags, and writes SQL that:
  1. upserts the vocabulary (ingest/vocab/sensor_properties.csv) into observable_properties,
  2. upserts the source into ingestion_sources and each record into ingestion_records,
  3. promotes the source with promote_ingestion_source().
Migrations are applied by hand in the SQL editor (CLAUDE.md), so the output is a migration file.

    python ingest/to_sql.py                       # (re)write the seed migration
    python ingest/to_sql.py --check               # fail if records are invalid or the committed seed is stale
"""
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SOURCE_DIR = HERE / "sources" / "2026-workshop-appendix-a"
VOCAB = HERE / "vocab" / "sensor_properties.csv"
SEED = ROOT / "supabase" / "migrations" / "20261006120100_ingest_workshop_appendix_a.sql"

ARRAY_FIELDS = {"device_models", "observes", "actuates"}
BOOL_FIELDS = {"presenter_present"}


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def to_payload(row: dict) -> tuple[str, dict]:
    """A records.csv row -> (source_locator, payload). Semicolon lists become arrays, '' becomes null."""
    payload = {}
    for k, v in row.items():
        if k == "source_locator":
            continue
        if k in ARRAY_FIELDS:
            payload[k] = [x.strip() for x in (v or "").split(";") if x.strip()]
        elif k in BOOL_FIELDS:
            if v not in ("yes", "no"):
                raise ValueError(f"{k} must be yes/no, got {v!r}")
            payload[k] = v == "yes"
        else:
            payload[k] = v.strip() or None if v is not None else None
    return row["source_locator"], payload


def validate(payload: dict, schema: dict, vocab: dict) -> list[str]:
    """The subset of JSON Schema the kinds use (required, enum, type, pattern, minLength, minItems,
    additionalProperties), plus the cross-field rules the database enforces as CHECKs."""
    errs = []
    props = schema["properties"]
    for k in schema.get("required", []):
        if payload.get(k) in (None, [], ""):
            errs.append(f"missing required {k}")
    if schema.get("additionalProperties") is False:
        errs += [f"unknown field {k}" for k in payload if k not in props]
    types = {"string": str, "boolean": bool, "array": list, "null": type(None)}
    for k, v in payload.items():
        spec = props.get(k)
        if spec is None:
            continue
        if "enum" in spec and v not in spec["enum"]:
            errs.append(f"{k}={v!r} not in {spec['enum']}")
        if "type" in spec:
            allowed = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
            if not any(isinstance(v, types[t]) for t in allowed):
                errs.append(f"{k} must be {allowed}")
        if isinstance(v, str):
            if "pattern" in spec and not re.match(spec["pattern"], v):
                errs.append(f"{k}={v!r} does not match {spec['pattern']}")
            if len(v) < spec.get("minLength", 0):
                errs.append(f"{k} is empty")
        if isinstance(v, list) and len(v) < spec.get("minItems", 0):
            errs.append(f"{k} needs at least {spec['minItems']} item(s)")
    for k in payload.get("observes") or []:
        if vocab.get(k) != "observable":
            errs.append(f"observes {k!r} is not an observable property")
    for k in payload.get("actuates") or []:
        if vocab.get(k) != "actuatable":
            errs.append(f"actuates {k!r} is not an actuatable property")
    if (payload.get("grant_match") == "unresolved") != (payload.get("grant_number") is None):
        errs.append("grant_match 'unresolved' if and only if grant_number is null")
    if payload.get("presenter_present") is False and not payload.get("verify_note"):
        errs.append("no presenter, so verify_note is required")
    if (payload.get("system_kind") == "sensor_actuator") != bool(payload.get("actuates")):
        errs.append("actuates is given exactly when system_kind is sensor_actuator")
    return errs


def review_flags(p: dict) -> list[str]:
    flags = []
    if p["grant_match"] in ("ambiguous", "unresolved", "title"):
        flags.append(f"grant_{p['grant_match']}")
    if not p["presenter_present"]:
        flags.append("no_presenter")
    if p.get("verify_note"):
        flags.append("verify_note")
    if p["model_status"] in ("inferred", "candidates"):
        flags.append(f"model_{p['model_status']}")
    return flags


def q(v) -> str:
    """A SQL string literal (standard_conforming_strings: only the single quote needs escaping)."""
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def arr(values: list[str]) -> str:
    return "ARRAY[" + ", ".join(q(v) for v in values) + "]::text[]" if values else "'{}'::text[]"


def build() -> tuple[str, list[str]]:
    source = json.loads((SOURCE_DIR / "source.json").read_text(encoding="utf-8"))
    schema = json.loads((HERE / "kinds" / f"{source['record_kind']}.schema.json").read_text(encoding="utf-8"))
    vocab_rows = read_csv(VOCAB)
    vocab = {v["key"]: v["property_kind"] for v in vocab_rows}
    errors, records, seen = [], [], set()
    for row in read_csv(SOURCE_DIR / source["records"]):
        try:
            loc, payload = to_payload(row)
        except ValueError as e:
            errors.append(f"{row.get('source_locator')}: {e}")
            continue
        errors += [f"{loc}: {e}" for e in validate(payload, schema, vocab)]
        key = (payload["award_label"], payload["label_as_named"])
        if key in seen:
            errors.append(f"{loc}: duplicate (award_label, label_as_named) {key}")
        seen.add(key)
        records.append((loc, payload))

    out = [
        f"-- GENERATED by ingest/to_sql.py from ingest/sources/{SOURCE_DIR.name}/ -- do not edit by hand.",
        "-- Edit the records there and regenerate; `python ingest/to_sql.py --check` fails on a stale copy.",
        "--",
        f"-- {source['title']}: {len(records)} sensor_deployment records, plus the {len(vocab_rows)}-key",
        "-- property vocabulary. Requires 20261006120000_data_ingestion. Idempotent: re-running upserts",
        "-- and re-promotes. Presenter NAMES are not here (see sensor_deployment_presenters).",
        "--",
        "-- Apply MANUALLY in the KG SQL editor (vpexxhfpvghlejljwpvt).",
        "",
        f"SELECT public.set_actor('migration:{SEED.stem}');",
        f"SELECT public.set_source_class({q(source['source_class'])});",
        "",
        "-- ── Vocabulary ──",
        "INSERT INTO public.observable_properties",
        "  (key, property_kind, label, definition, foi_kind, category_key, category_measure) VALUES",
        ",\n".join(
            f"  ({q(v['key'])}, {q(v['property_kind'])}, {q(v['label'])}, {q(v['definition'])}, "
            f"{q(v['foi_kind'])}, {q(v['category_key'])}, {q(v['category_measure'])})" for v in vocab_rows),
        "ON CONFLICT (key) DO UPDATE SET property_kind = excluded.property_kind, label = excluded.label,",
        "  definition = excluded.definition, foi_kind = excluded.foi_kind,",
        "  category_key = excluded.category_key, category_measure = excluded.category_measure;",
        "",
        "-- ── Source ──",
        "INSERT INTO public.ingestion_sources (slug, kind, title, description) VALUES",
        f"  ({q(source['slug'])}, {q(source['kind'])}, {q(source['title'])}, {q(source['description'])})",
        "ON CONFLICT (slug) DO UPDATE SET kind = excluded.kind, title = excluded.title,",
        "  description = excluded.description;",
        "",
        "-- ── Records (status accepted when nothing is flagged; flagged records still promote) ──",
        "INSERT INTO public.ingestion_records",
        "  (source_id, record_kind, source_locator, payload, extracted_by, source_class, status, review_flags)",
        "SELECT s.id, r.kind, r.loc, r.payload::jsonb, r.by, r.class, r.status, r.flags",
        "  FROM public.ingestion_sources s, (VALUES",
    ]
    rows = []
    for loc, p in records:
        flags = review_flags(p)
        status = "pending_review" if flags or source["extracted_by"].startswith("llm:") else "accepted"
        rows.append(f"    ({q(source['record_kind'])}, {q(loc)}, {q(json.dumps(p, ensure_ascii=False))}, "
                    f"{q(source['extracted_by'])}, {q(source['source_class'])}, {q(status)}, {arr(flags)})")
    out.append(",\n".join(rows))
    out += [
        "  ) AS r(kind, loc, payload, by, class, status, flags)",
        f" WHERE s.slug = {q(source['slug'])}",
        "ON CONFLICT (source_id, record_kind, source_locator) DO UPDATE SET payload = excluded.payload,",
        "  extracted_by = excluded.extracted_by, source_class = excluded.source_class,",
        "  review_flags = excluded.review_flags,",
        "  status = CASE WHEN public.ingestion_records.status = 'rejected' THEN 'rejected' ELSE excluded.status END;",
        "",
        "-- ── Promote into sensor_deployments and its link tables ──",
        f"SELECT public.promote_ingestion_source({q(source['slug'])}) AS records_promoted;",
        "",
        "-- Check: one deployment per record, and what is still flagged.",
        "-- SELECT status, count(*), array_agg(DISTINCT f) FROM public.ingestion_records, unnest(review_flags) f GROUP BY 1;",
        "",
    ]
    return "\n".join(out), errors


def main():
    check = "--check" in sys.argv[1:]
    sql, errors = build()
    if errors:
        print("\n".join(errors), file=sys.stderr)
        raise SystemExit(1)
    if check:
        if not SEED.exists() or SEED.read_text(encoding="utf-8") != sql:
            print(f"{SEED.relative_to(ROOT)} is stale: run python ingest/to_sql.py", file=sys.stderr)
            raise SystemExit(1)
        print(f"ok  records valid; {SEED.relative_to(ROOT)} is current")
        return
    SEED.write_text(sql, encoding="utf-8")
    print(f"wrote {SEED.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
