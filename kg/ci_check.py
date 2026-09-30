#!/usr/bin/env python3
"""CI gate for the knowledge graph (build phase 7). Fails on a regression, never on a known gap.

  1. RED   -- every consistency shape fires on fixtures/contradictions.ttl
  2. GREEN -- fixtures/clean.ttl conforms
  3. export -- no shape fires on the export more often than quality_baseline.json allows,
               and no shape that is quiet in the baseline starts firing
  4. quality -- every competency question answered in the baseline still answers, and every shape
               that had data to check still does
  5. generated (--check-generated, needs linkml) -- bbqs.owl.ttl and bbqs.shapes.gen.ttl are what
               gen-owl / gen-shacl produce from bbqs.linkml.yaml today

    python kg/ci_check.py [--export PATH] [--check-generated]
    python kg/ci_check.py --update-baseline     # after a real improvement; commit the new baseline

An improvement (fewer violations, more answers) passes and prints a reminder to update the
baseline, so the gate tightens as the graph gets better.
"""
import json
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

import click
from rdflib import BNode, Graph

from quality import HERE, KGQuality

BASELINE = HERE / "quality_baseline.json"
RED = HERE / "fixtures" / "contradictions.ttl"
GREEN = HERE / "fixtures" / "clean.ttl"


def shape_counts(q: KGQuality) -> Counter:
    return Counter(v["shape"] for vs in q.violations().values() for v in vs)


def consistency_shape_names(q: KGQuality) -> set[str]:
    return {r["shape"] for r in q.shape_exercise()}


def ground(graph: Graph) -> tuple[int, set]:
    """Triple count plus every triple without a blank node: a cheap stand-in for isomorphism,
    which is too slow on the OWL restrictions' blank nodes."""
    return len(graph), {t for t in graph if not any(isinstance(x, BNode) for x in t)}


def check_generated_artifacts(errors: list[str]):
    schema = HERE / "bbqs.linkml.yaml"
    for tool, committed in [("gen-owl", HERE / "bbqs.owl.ttl"), ("gen-shacl", HERE / "bbqs.shapes.gen.ttl")]:
        out = subprocess.run([tool, str(schema)], capture_output=True, text=True, encoding="utf-8")
        if out.returncode:
            errors.append(f"{tool} failed: {out.stderr.strip()[:300]}")
            continue
        with tempfile.NamedTemporaryFile("w", suffix=".ttl", delete=False, encoding="utf-8") as f:
            f.write(out.stdout)
        fresh = ground(Graph().parse(f.name, format="turtle"))
        Path(f.name).unlink()
        have = ground(Graph().parse(str(committed), format="turtle"))
        if fresh != have:
            errors.append(f"{committed.name} is stale: regenerate it with {tool} (see kg/README.md) "
                          f"({have[0]} committed vs {fresh[0]} generated triples)")
        else:
            print(f"ok  {committed.name} matches {tool}")


@click.command()
@click.option("--export", "export_path", type=click.Path(exists=True, dir_okay=False, path_type=Path),
              default=KGQuality.DEFAULT_DATA, show_default=True)
@click.option("--check-generated", is_flag=True, help="Also regenerate OWL/SHACL and compare (needs linkml).")
@click.option("--update-baseline", is_flag=True, help="Write the export's current numbers as the new baseline.")
def main(export_path, check_generated, update_baseline):
    """Fail if the KG regressed against kg/quality_baseline.json."""
    q = KGQuality(export_path)
    report = q.report()
    now = {
        "violations": dict(sorted(Counter(v["shape"] for e in report["entities"] for v in e["violations"]).items())),
        "answered": sorted(c["id"] for c in report["competency"] if c["status"] == "answered"),
        "exercised": sorted(s["shape"] for s in report["shapes"] if s["exercised"]),
        "isolated": report["structure"]["isolated"],
        "nodes": report["structure"]["nodes"],
    }
    if update_baseline:
        BASELINE.write_text(json.dumps(now, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {BASELINE.name}: {now}")
        return

    errors, improved = [], []
    base = json.loads(BASELINE.read_text(encoding="utf-8"))

    red = shape_counts(KGQuality(RED))
    silent = sorted(consistency_shape_names(q) - set(red))
    if silent:
        errors.append(f"RED fixture: these shapes no longer fire on contradictions.ttl: {', '.join(silent)}")
    else:
        print(f"ok  RED fixture fires all {len(red)} shapes")

    green = shape_counts(KGQuality(GREEN))
    if green:
        errors.append(f"GREEN fixture no longer conforms: {dict(green)}")
    else:
        print("ok  GREEN fixture conforms")

    for shape, n in sorted(now["violations"].items()):
        allowed = base["violations"].get(shape, 0)
        if n > allowed:
            errors.append(f"export: {shape} fires {n}x (baseline {allowed})")
    for shape, allowed in base["violations"].items():
        if now["violations"].get(shape, 0) < allowed:
            improved.append(f"{shape} {allowed} -> {now['violations'].get(shape, 0)}")
    print(f"{'ok ' if not any(e.startswith('export') for e in errors) else 'BAD'} export violations: {now['violations']}")

    for key, label in [("answered", "competency questions answered"), ("exercised", "shapes with data to check")]:
        lost = sorted(set(base[key]) - set(now[key]))
        gained = sorted(set(now[key]) - set(base[key]))
        if lost:
            errors.append(f"quality: {label} lost: {', '.join(lost)}")
        if gained:
            improved.append(f"{label} gained: {', '.join(gained)}")
        print(f"{'ok ' if not lost else 'BAD'} {label}: {len(now[key])} (baseline {len(base[key])})")
    print(f"--  isolated nodes: {now['isolated']} of {now['nodes']} (baseline {base['isolated']} of {base['nodes']})")

    if check_generated:
        check_generated_artifacts(errors)

    if improved:
        print("\nImproved on the baseline -- run `python kg/ci_check.py --update-baseline` and commit it:")
        for i in improved:
            print(f"  {i}")
    if errors:
        print("\nKG gate FAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("\nKG gate passed.")


if __name__ == "__main__":
    main()
