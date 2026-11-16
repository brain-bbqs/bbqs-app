#!/usr/bin/env python3
"""The consortium device list -> the records the Graph Inspector's Devices tab shows.

The input is the folder of the device list (BBQS Device List -- Who Said What, with References):
devices.csv (one row per device per award), device_evidence.csv (what backs each row),
device_discussion_crosscutting.csv (consortium-wide statements about devices), awards.csv and
bbqs_devices_kg.json (whose schema defines the verification tiers). The output is one JSON
document of awards, devices, evidence and statements, each with its tier.

The tiers say how far each line can be trusted, and the page keeps them apart:
  T1  written on the team's own Data Blitz slide (author not recorded)
  T2  from the workshop summary, written from the transcripts: the speaker is named there, but
      nobody has checked it against the transcript text
  T3  a line from working-group meeting notes (the note-taker's wording)
  U   unverified: a manufacturer, headquarters or model that only the AI-assembled device list
      gives. It is kept as `ai_predicted`, never as the device's model; confirm it with the lab.

The list names people and what they said, so it is internal like the meeting notes: keep the input
and the output out of this repository; kg/quality.py embeds the output only in a fragment built
for the artifact viewer (`--internal`).

    python kg/devices.py /path/to/device_list_folder --out /somewhere/outside/devices.json
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

FILES = ("devices.csv", "device_evidence.csv", "device_discussion_crosscutting.csv", "awards.csv",
         "bbqs_devices_kg.json")
TIER_ORDER = ("T1", "T2", "T3", "U")
CAVEAT = ("The devices and what they measure are as each team wrote them on its Data Blitz slide. Who spoke "
          "to a device is named in the workshop summary, which was written from the transcripts and has not "
          "been checked against them. A model or manufacturer marked AI-predicted comes only from the "
          "AI-assembled device list, with nothing on a slide or in the summary behind it: confirm it with the "
          "lab before using it.")


def _rows(folder: Path, name: str) -> list[dict]:
    with open(folder / name, encoding="utf-8", newline="") as handle:
        return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(handle)]


def _split(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"\s*[,;]\s*", text or "") if part.strip()]


def _tiers(text: str) -> list[str]:
    found = set(re.findall(r"T\d|U", text or ""))
    return [t for t in TIER_ORDER if t in found]


def build(folder: Path) -> dict:
    spec = json.loads((folder / "bbqs_devices_kg.json").read_text(encoding="utf-8")).get("schema", {})
    tiers = spec.get("verification_tiers") or {}
    evidence = [{"id": r["evidence_id"], "device": r.get("device_id", ""), "award": r.get("award", ""),
                 "tier": r.get("tier", ""), "type": r.get("evidence_type", ""), "text": r.get("text", ""),
                 "speaker": r.get("speaker", ""), "session": r.get("session", ""), "date": r.get("date", ""),
                 "source": r.get("source", ""), "url": r.get("url", ""), "note": r.get("note", "")}
                for r in _rows(folder, "device_evidence.csv") if r.get("evidence_id")]
    by_device: dict[str, list[str]] = {}
    for e in evidence:
        by_device.setdefault(e["device"], []).append(e["id"])
    devices = []
    for r in _rows(folder, "devices.csv"):
        if not r.get("device_id"):
            continue
        manufacturer, model = r.get("manufacturer_candidate_unverified", ""), r.get("model_candidate_unverified", "")
        row_tiers = _tiers(r.get("evidence_tiers", ""))
        # A guess counts only where the list itself records it as one (a U record). Without one the
        # column holds a placeholder ("Not specified in record"), which the list shows as no guess.
        guessed = "U" in row_tiers and (manufacturer or model)
        devices.append({
            "id": r["device_id"], "award": r.get("award", ""), "name": r.get("device_as_named", ""),
            "kind": r.get("kind", ""), "category": r.get("category", ""), "measures": _split(r.get("measures", "")),
            "tools": _split(r.get("tools", "")), "sharing": _split(r.get("sharing", "")),
            "presenter": r.get("presenter_per_summary", ""), "brand_stated": r.get("manufacturer_stated", ""),
            "ai_predicted": {"manufacturer": manufacturer, "model": model} if guessed else None,
            "on_team_slide": r.get("on_team_slide", "").lower().startswith("yes"),
            "tiers": row_tiers, "evidence": by_device.get(r["device_id"], []),
        })
    awards = [{"award": r["award"], "institution": r.get("institution", ""), "pis": r.get("pis", ""),
               "species": r.get("species", ""), "title": r.get("title", ""), "team": r.get("team", ""),
               "status": r.get("status_at_blitz", "")} for r in _rows(folder, "awards.csv") if r.get("award")]
    discussion = [{"id": r["evidence_id"], "topic": r.get("topic", ""), "tier": r.get("tier", ""),
                   "speaker": r.get("speaker", ""), "text": r.get("text", ""), "session": r.get("session", ""),
                   "date": r.get("date", ""), "source": r.get("source", ""), "url": r.get("url", "")}
                  for r in _rows(folder, "device_discussion_crosscutting.csv") if r.get("evidence_id")]
    known = {d["id"] for d in devices}
    orphans = sorted({e["device"] for e in evidence if e["device"] and e["device"] not in known})
    return {
        "kind": "bbqs-devices", "version": 1, "caveat": CAVEAT,
        "tiers": {t: tiers.get(t, "") for t in TIER_ORDER if t in tiers or any(t in d["tiers"] for d in devices)},
        "rule": spec.get("rule", ""),
        "awards": awards, "devices": devices, "evidence": evidence, "discussion": discussion,
        "orphan_evidence": orphans,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", type=Path, help="the device list's folder (devices.csv and the rest)")
    parser.add_argument("--out", type=Path, required=True, help="where to write the records (outside the repo)")
    parser.add_argument("--describe", default="", help="where the list came from, shown on the page")
    args = parser.parse_args(argv)
    missing = [name for name in FILES if not (args.folder / name).is_file()]
    if missing:
        parser.error(f"{args.folder} is missing {', '.join(missing)}")
    repo = Path(__file__).resolve().parent.parent
    for path in (args.folder, args.out):
        try:
            path.resolve().relative_to(repo)
        except ValueError:
            continue
        parser.error(f"{path} is inside the repository; the device list names people, keep it elsewhere")
    doc = build(args.folder)
    doc["source"] = {"description": args.describe,
                     "files": {name: hashlib.sha256((args.folder / name).read_bytes()).hexdigest() for name in FILES}}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    ai = sum(1 for d in doc["devices"] if d["ai_predicted"])
    print(f"{len(doc['awards'])} awards, {len(doc['devices'])} devices ({ai} with an AI-predicted model or maker), "
          f"{len(doc['evidence'])} evidence records, {len(doc['discussion'])} statements; wrote {args.out}")
    if doc["orphan_evidence"]:
        print(f"evidence for devices not in devices.csv: {', '.join(doc['orphan_evidence'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
