#!/usr/bin/env python3
"""The meetings data package as the Inspector's internal records: Meetings and Devices.

    python kg/internal_package.py /elsewhere/BBQS_KG_Data_Package --out-dir /elsewhere/internal
    python kg/quality.py --fragment /elsewhere/inspector.html \\
        --internal /elsewhere/internal/meetings.json --internal /elsewhere/internal/devices.json

It writes meetings.json and devices.json in the shapes kg/meetings.py and kg/devices.py write, so
the Inspector's two tabs read either, and adds what only the package has:

  meetings   every item of every meeting (agenda items too), each marked for what it is: an AI
             summary of that meeting's notes (tier X), shown with the notes block it paraphrases;
             and the evidence: every record the package keeps as someone's words or writing
             (transcript cues, chat lines, comments, slide rows, workshop statements), with its tier,
             how it may be cited, the speaker as written and as resolved, the meeting, the source
             and the locator. That list is what a search for "who said what" reads.
  devices    each row of the device list as one award's reported use of an instrument, in the terms
             of W3C SOSA/SSN: the sensor (the actual instrument, sosa:Sensor) apart from what it
             observes (sosa:ObservableProperty), the award's species as the feature of interest, a
             method as a procedure (sosa:Procedure) and not a sensor; a maker or model the list only
             guesses stays a guess (tier U); and the mentions: the lines of the notes and the
             transcripts that name the sensor or the property, found by plain text matching.
  questions  what the records answer, computed here and stated with how: the page shows each with
             its rows, and kg/test_internal.py holds every one to a synthetic package's known answer.

The package's rules are kg/package_reader.py's (its docstring): tiers decide how a record may be
cited, a name is kept as written with how it was resolved, a shared account is never a person, and
contact data is replaced by markers as the package is read.

Internal. The package names people and what they said in meetings. This script refuses to run on
CI, refuses a package or an output folder inside the repository, and what it writes goes only into
the artifact copy of the Inspector (kg/quality.py --internal), never a committed or published page.
Standard library only, so it runs with `python -I`.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import package_reader as pr  # noqa: E402

VERSION = 3
# The markers tests/guards/inspector-internal-data looks for in committed files: built here, as in
# kg/meetings.py and kg/devices.py, so that this file is not itself taken for a copy of the records.
MEETINGS_KIND, DEVICES_KIND = "bbqs-" + "meetings", "bbqs-" + "devices"
PACKAGE_NAME = "BBQS meetings data package"
NO_VALUE = re.compile(r"^(?:not specified\b.*|unknown|none|n/?a|tbd|[-–—?.\s]*)$", re.I)
NOT_A_NAME = re.compile(r"^\s*\(.*\)\s*$", re.S)          # "(summary author)": a remark where a name would be
SAYS_VERIFY = re.compile(r"\b(?:verify|likely)\b", re.I)   # the source itself marks the name for checking

MEETINGS_CAVEAT = (
    "Each point is an AI summary of that meeting's notes (tier X), not a quote: read it with the notes it "
    "summarizes, shown under the meeting. Under Evidence, only a record marked TR, T1 or T3 is someone's words "
    "or writing, and a TR line is an auto-caption nobody has checked.")
DEVICES_CAVEAT = (
    "A line is what one award reported using, not a catalogue entry. The sensor (the actual instrument) is kept "
    "apart from what it observes. A maker or model marked AI-predicted is a guess of the AI-assembled list (tier U): "
    "never a fact until the lab confirms it. A mention is a line of the notes or a transcript that names the "
    "sensor or the property, found by matching the words, so it can name something else of the same name.")
SOSA = {
    "sensor": "sosa:Sensor: the actual instrument an award reported using.",
    "property": "sosa:ObservableProperty: what the instrument observes (the list's \"measures\").",
    "feature": "sosa:FeatureOfInterest: the species the award studies.",
    "procedure": "sosa:Procedure: a method or protocol, which observes through instruments and is not one.",
    "deployment": "ssn:Deployment: one award's reported use; every line is one.",
}


def _text(value) -> str:
    return " ".join(str(value or "").split())


def _stated(value) -> str:
    """A value the list really gives; "" for an empty cell or a placeholder ("Not specified in record")."""
    value = _text(value)
    return "" if NO_VALUE.match(value) else value


def _who(resolution: dict) -> dict:
    """One name on an item or a record, in the shape the Inspector shows: the person when the package
    resolved the name to one, else the name as written with why not."""
    name, note = resolution.get("name") or "", resolution.get("note") or ""
    if note:                                     # a shared account: never a person
        return {"name": "", "as_written": resolution.get("as_written") or name, "how": "attributed", "verify": False,
                "basis": f"a shared account, not a person ({note})"}
    if not name:
        return {"name": "", "as_written": resolution.get("as_written") or "", "how": "attributed", "verify": False,
                "basis": "the package names no person for it"}
    verify = bool(resolution.get("verify"))
    return {"name": name, "as_written": resolution.get("as_written") or name, "how": "attributed", "verify": verify,
            "basis": (resolution.get("how") or "") + (" (a guess the package marks to verify)" if verify else "")}


def _notes_state(meeting: dict) -> str:
    """Whether a meeting has the notes block its items paraphrase, and whether its link was repaired."""
    if not meeting["notes"]:
        return "no notes block"
    return "notes block (link repaired)" if meeting["notes"]["repaired"] else "notes block"


class Records:
    """The package read once, and the two documents built from it."""

    def __init__(self, folder):
        self.pkg = pr.Package(folder)
        p = self.pkg
        self.source_title = {sid: s.get("title") or sid for sid, s in p.source.items()}
        self.spoke = defaultdict(list)                       # meeting -> [(person id, tier)]
        for edge in p.edges_by_type.get("SPOKE_IN", ()):
            if edge.get("source") in p.person and edge.get("target") in p.meeting:
                self.spoke[edge["target"]].append((edge["source"], edge.get("tier") or ""))
        self.meeting_of = {e["id"]: p.meeting_of(e)[0] for e in p.evidence}
        self.evidence_of_meeting = defaultdict(list)
        for e in p.evidence:
            if self.meeting_of[e["id"]]:
                self.evidence_of_meeting[self.meeting_of[e["id"]]].append(e)
        self.award_of_device = {e["target"]: e["source"] for e in p.edges_by_type.get("USES", ())
                                if e.get("source") in p.node and e.get("target") in p.node}
        self.evidence_of_device = defaultdict(list)
        for edge in p.edges_by_type.get("SUPPORTED_BY", ()):
            if edge.get("target") in p.evidence_by_id:
                self.evidence_of_device[edge["source"]].append(p.evidence_by_id[edge["target"]])
        self.institution = {}
        for edge in p.edges_by_type.get("AT_INSTITUTION", ()):
            self.institution.setdefault(edge["source"], _text((p.node.get(edge["target"]) or {}).get("name")))
        self.devices = sorted(p.by_label["Device"], key=lambda d: (self._award_name(d["id"]), d["id"]))

    def _award_name(self, device_id: str) -> str:
        return _text((self.pkg.node.get(self.award_of_device.get(device_id, "")) or {}).get("name"))

    def _is_person(self, person_id: str) -> bool:
        return person_id in self.pkg.person and not self.pkg.person[person_id].get("note")

    # ---- meetings ------------------------------------------------------------------------------------

    def notes_of(self, meeting_id: str) -> dict | None:
        """The notes a meeting's items paraphrase: the block's words, and how the block was found."""
        p = self.pkg
        links = p.segment_links()["by_meeting"].get(meeting_id) or []
        if not links:
            return None
        link = links[0]
        segment = p.segment[link["segment"]]
        lines = (segment.get("text") or "").splitlines()
        if link["lines"]:                                  # written inside another meeting's block
            starts = sorted(start for start, _m in p.segment_links()["parts"].get(link["segment"], ()))
            first = link["lines"][0]
            later = [s for s in starts if s > first]
            lines = lines[first:later[0] if later else len(lines)]
        return {"segment": link["segment"], "how": link["how"], "repaired": bool(link["repaired"]),
                "text": "\n".join(lines).strip(), "locator": _text(segment.get("locator") or
                                                                    f"lines {segment.get('line_start')}-{segment.get('line_end')}")}

    def evidence_row(self, e: dict) -> dict:
        p = self.pkg
        speaker = _who(p.speaker(e)) if (e.get("speaker") or e.get("speaker_as_written")) else None
        written, author_note = (speaker or {}).get("as_written", ""), ""
        if speaker and not speaker["name"] and NOT_A_NAME.match(written):
            # "(team slide; author not recorded)" says why there is no author: it is not a name
            written, author_note = "", written.strip()[1:-1].strip()
        row = {"id": e["id"], "meeting": self.meeting_of[e["id"]], "tier": e.get("tier") or "",
               "kind": pr.EVIDENCE_KINDS.get(e.get("kind"), _text(e.get("kind"))), "text": e.get("text") or "",
               "speaker": (speaker or {}).get("name", ""), "as_written": written, "author_note": author_note,
               "verify": bool((speaker or {}).get("verify")) or bool(written and SAYS_VERIFY.search(written)),
               "basis": (speaker or {}).get("basis", ""),
               "date": e.get("date") or "", "source": self.source_title.get(e.get("source_id"), e.get("source_id") or ""),
               "locator": _text(e.get("locator")), "url": e.get("url") or ""}
        if e.get("start"):
            row["start"], row["end"] = e.get("start"), e.get("end") or ""
        if e.get("award"):
            row["award"] = _text((p.node.get(e["award"]) or {}).get("name") or e["award"])
        return row

    def meetings(self) -> dict:
        p = self.pkg
        items, unresolved = [], Counter()
        for item in sorted(p.items, key=lambda i: (i["meeting"], pr.KIND_ORDER.index(i["kind"]), i["n"])):
            who = [_who(r) for r in p.raised_by(item["id"])]
            if not who and item["attributed_to_as_written"]:
                who = [_who({"as_written": item["attributed_to_as_written"]})]
            for w in who:
                if not w["name"]:
                    unresolved[w["as_written"]] += 1
            items.append({"id": item["id"], "meeting": item["meeting"], "kind": item["kind"], "n": item["n"],
                          "text": item["text"], "who": who, "quotes": [], "tier": item["tier"] or "X",
                          "locator": _text(item["locator"])})
        per_meeting = defaultdict(Counter)
        for item in items:
            per_meeting[item["meeting"]][item["kind"]] += 1

        meetings = []
        for m in p.meetings:
            evidence = self.evidence_of_meeting.get(m["id"], [])
            source = p.source.get(m.get("source_id") or "") or {}
            meetings.append({
                "id": m["id"], "date": m.get("date") or "", "group": _text(m.get("group")), "as_named": _text(m.get("name")),
                "title": _text(m.get("title")), "agenda": [],
                "speakers": sorted({p.person[pid].get("name") or "" for pid, _t in self.spoke.get(m["id"], ()) if self._is_person(pid)}),
                "attendees": [], "note": _text(m.get("source_note")), "counts": dict(per_meeting.get(m["id"], {})),
                "source": _text(source.get("title")), "source_kind": _text(source.get("kind")), "url": m.get("url") or "",
                "notes": self.notes_of(m["id"]), "evidence": len(evidence),
                "transcript": any(e.get("kind") == "utterance" for e in evidence)})

        people = {}
        for pid, person in p.person.items():
            spoke_in = {m for m, speakers in self.spoke.items() if any(s == pid for s, _t in speakers)}
            people[pid] = {"name": person.get("name") or "", "meetings": len(spoke_in),
                           "groups": sorted({_text(p.meeting[m].get("group")) for m in spoke_in} - {""}),
                           "attributed": 0, "owns": 0, "named": 0}
            if person.get("note"):
                people[pid].update(not_a_person=True, note=_text(person.get("note")))
        for edge in p.edges_by_type.get("RAISED", ()):
            if edge.get("source") in people and edge.get("target") in p.item:
                people[edge["source"]]["attributed"] += 1
        said = Counter(e.get("speaker") for e in p.evidence if e.get("speaker") in people)
        for pid, n in said.items():
            people[pid]["records"] = n

        cited = Counter(e.get("source_id") for e in p.evidence)
        sources = [{"id": s["source_id"], "title": _text(s.get("title")), "kind": _text(s.get("kind")),
                    "tier": _text(s.get("default_tier")), "note": pr.redact(_text(s.get("note"))), "url": s.get("url") or "",
                    "records": cited.get(s["source_id"], 0)} for s in p.sources]
        evidence = [self.evidence_row(e) for e in p.evidence]
        counts = p.counts()
        return {
            "kind": MEETINGS_KIND, "version": VERSION, "from_package": True,
            "source": {"file": PACKAGE_NAME, "sha256": p.digest().get("kg/nodes.jsonl", ""), "meetings": len(meetings),
                       "description": (f"{len(meetings)} meetings, {len(items)} items, {len(evidence)} evidence records and "
                                       f"{len(sources)} sources, from the {PACKAGE_NAME}. Contact data was replaced by markers "
                                       f"as it was read ({p.redactions.get('link', 0)} links, {p.redactions.get('email', 0)} "
                                       f"e-mail addresses, {p.redactions.get('name', 0)} assignees).")},
            "caveat": MEETINGS_CAVEAT, "tiers": dict(pr.CITE), "tier_counts": counts["evidence_by_tier"],
            "manifest": p.check_against_stats(),
            "meetings": meetings, "items": items,
            "people": sorted(people.values(), key=lambda x: x["name"]),
            "unresolved": [{"as_written": name, "count": n} for name, n in unresolved.most_common()],
            "evidence": evidence, "sources": sources, "unread_fields": {},
            "questions": self.meeting_questions(items, meetings, evidence, sources),
        }

    def meeting_questions(self, items, meetings, evidence, sources) -> list[dict]:
        p = self.pkg
        by_id = {m["id"]: m for m in meetings}
        where = lambda i: (by_id[i["meeting"]]["date"], by_id[i["meeting"]]["group"])     # noqa: E731
        names = lambda i: "; ".join(w["name"] or f'{w["as_written"]} (not resolved)' for w in i["who"]) or "not stated"  # noqa: E731
        notes = lambda i: _notes_state(by_id[i["meeting"]])                                # noqa: E731
        out = []

        decisions = sorted((i for i in items if i["kind"] == "decision"), key=lambda i: (*where(i), i["n"]))
        out.append({"id": "M1", "question": "What did each group decide, who is each decision attributed to, and do the notes back it?",
                    "how": "Every item of kind decision, by date and group, with the names the package attributes it to and "
                           "whether the meeting has a notes block. A decision is an AI summary of the notes (tier X).",
                    "columns": ["Date", "Group", "Decision", "Attributed to", "Notes"],
                    "rows": [[*where(i), i["text"], names(i), notes(i)] for i in decisions]})

        cues = defaultdict(list)
        for e in evidence:
            if e["kind"] == "utterance" and e["meeting"]:
                cues[e["meeting"]].append(e)
        out.append({"id": "M2", "question": "Which meetings have a transcript, and how much of it: cues, speakers, time span?",
                    "how": "Meetings with at least one transcript cue (tier TR), with the number of cues, of distinct speakers "
                           "as written, and the first and last time stamp. What was said about a term is the Evidence search.",
                    "columns": ["Date", "Group", "Meeting", "Cues", "Speakers", "From", "To"],
                    "rows": sorted([by_id[m]["date"], by_id[m]["group"], by_id[m]["title"], len(rows),
                                    len({r["as_written"] for r in rows}), min(r.get("start", "") for r in rows),
                                    max(r.get("end", "") for r in rows)] for m, rows in cues.items())})

        bare = [m for m in meetings if sum(m["counts"].values()) and not m["evidence"]]
        out.append({"id": "M4", "reads": "absence",
                    "question": "Which meetings' items have no verbatim evidence behind them, and which not even a notes block?",
                    "how": "Meetings that have items and no evidence record at all. Their items rest on the notes block alone, "
                           "or on nothing where the block is missing.",
                    "columns": ["Date", "Group", "Meeting", "Items", "Notes"],
                    "rows": [[m["date"], m["group"], m["title"], sum(m["counts"].values()), _notes_state(m)] for m in bare]})

        spoke = defaultdict(lambda: [0, 0])                 # (group, person) -> [meetings, of which transcribed]
        for meeting, speakers in self.spoke.items():
            by_person = defaultdict(set)
            for pid, tier in speakers:
                by_person[pid].add(tier)
            for pid, tiers in by_person.items():
                if self._is_person(pid):
                    key = (by_id[meeting]["group"], p.person[pid].get("name") or "")
                    spoke[key][0] += 1
                    spoke[key][1] += "TR" in tiers
        out.append({"id": "M5", "question": "Who spoke in which group's meetings, and is that from a transcript or from the notes?",
                    "how": "The package's speaker ties, per group and person: how many meetings, and in how many of them the tie "
                           "comes from a transcript (tier TR). The rest come from the notes' summary (tier X).",
                    "columns": ["Group", "Person", "Meetings", "From a transcript"],
                    "rows": [[g, name, n, tr] for (g, name), (n, tr) in sorted(spoke.items(), key=lambda kv: (kv[0][0], -kv[1][0], kv[0][1]))]})

        guesses = Counter()
        for e in evidence:
            if e["verify"] and e["speaker"]:              # resolved to a person, by a guess
                guesses[(e["as_written"], e["speaker"], "evidence records")] += 1
        for i in items:
            for w in i["who"]:
                if w["verify"]:
                    guesses[(w["as_written"], w["name"], "item attributions")] += 1
        out.append({"id": "M6", "reads": "absence", "question": "Which attributions rest on a name the package only guessed (VERIFY)?",
                    "how": "Evidence records and item attributions whose name as written was resolved to a person by an alias "
                           "the package marks VERIFY, counted per name.",
                    "columns": ["As written", "Resolved to", "What", "Count"],
                    "rows": [[a, n, what, c] for (a, n, what), c in sorted(guesses.items(), key=lambda kv: (-kv[1], kv[0]))]})

        decided = defaultdict(list)
        for i in decisions:
            decided[where(i)[1]].append(where(i)[0])
        rows = []
        for i in sorted((i for i in items if i["kind"] == "disagreement"), key=lambda i: (*where(i), i["n"])):
            date, group = where(i)
            later = [d for d in decided.get(group, ()) if d >= date]
            rows.append([date, group, i["text"], names(i), min(later) if later else "none recorded"])
        out.append({"id": "M7", "question": "Which disagreements did a group record, and did the group record a decision afterwards?",
                    "how": "Every item of kind disagreement, with the date of the group's next decision on or after that day. "
                           "A later decision is not necessarily about the same matter.",
                    "columns": ["Date", "Group", "Disagreement", "Attributed to", "Next decision in the group"], "rows": rows})

        out.append({"id": "M8", "question": "Who owns each action item?",
                    "how": "Every item of kind action with the names the package attributes it to. Where it names nobody the "
                           "owner is not stated.",
                    "columns": ["Date", "Group", "Action", "Owner"],
                    "rows": [[*where(i), i["text"], names(i)]
                             for i in sorted((i for i in items if i["kind"] == "action"), key=lambda i: (*where(i), i["n"]))]})

        out.append({"id": "M10", "reads": "absence", "question": "Which source documents does no evidence record cite?",
                    "how": "Sources of the package with no evidence record.",
                    "columns": ["Source", "Kind"],
                    "rows": [[s["title"], s["kind"]] for s in sources if not s["records"]]})
        for q in out:
            q["count"] = len(q["rows"])
        return out

    # ---- devices -------------------------------------------------------------------------------------

    def device_documents(self) -> dict:
        p = self.pkg
        mentions = p.mentions()
        hit_index, hits = {}, []

        def hit_refs(key: str) -> list[int]:
            refs = []
            for hit in mentions["terms"][key]["hits"]:
                if hit["where"] not in hit_index:
                    speaker = _who(hit["speaker"]) if (hit["speaker"].get("person") or hit["speaker"].get("as_written")) else {}
                    meeting = p.meeting.get(hit["meeting"]) or {}
                    hit_index[hit["where"]] = len(hits)
                    hits.append({"where": hit["where"], "tier": hit["tier"], "kind": hit["kind"], "text": hit["text"],
                                 "speaker": speaker.get("name", ""), "as_written": speaker.get("as_written", ""),
                                 "verify": bool(speaker.get("verify")), "meeting": hit["meeting"],
                                 "meeting_title": _text(meeting.get("title")), "group": _text(meeting.get("group")),
                                 "date": hit["date"], "source": self.source_title.get(hit["source"], hit["source"]),
                                 "locator": _text(hit["locator"]), "url": hit["url"]})
                refs.append(hit_index[hit["where"]])
            return refs

        awards = []
        for a in sorted(p.by_label["Award"], key=lambda a: _text(a.get("name"))):
            awards.append({"award": _text(a.get("name")), "institution": self.institution.get(a["id"], ""),
                           "pis": _text(a.get("pis_as_written")), "species": _text(a.get("species")), "title": _text(a.get("title")),
                           "team": _text(a.get("team_as_written")), "status": _text(a.get("status_at_blitz"))})
        species = {a["award"]: a["species"] for a in awards}

        devices, evidence, properties = [], [], {}
        for d in self.devices:
            award = self._award_name(d["id"])
            rows = self.evidence_of_device.get(d["id"], [])
            presenters = []
            for e in rows:
                written = _text(e.get("speaker_as_written"))
                if e.get("kind") == "speaker attribution (workshop)" and written and written not in presenters:
                    presenters.append(written)
            maker, model = _stated(d.get("manufacturer_candidate_unverified")), _stated(d.get("model_candidate_unverified"))
            procedure = _text(d.get("kind")) != "device/sensor"
            observes = pr.property_labels(d)
            terms = mentions["by_device"].get(d["id"], {"sensor": [], "property": []})
            named = {"sensor": [], "property": []}
            for what in ("sensor", "property"):
                for key in terms[what]:
                    refs = hit_refs(key)
                    if refs:
                        named[what].append({"term": mentions["terms"][key]["term"], "hits": refs})
            devices.append({
                "id": d["id"], "award": award, "name": _text(d.get("name")), "kind": _text(d.get("kind")),
                "category": _text(d.get("category")), "measures": observes, "tools": pr.split_top(d.get("tools") or ""),
                "sharing": pr.split_top(d.get("sharing") or ""), "presenter": "; ".join(presenters),
                "brand_stated": _stated(d.get("manufacturer_stated")),
                "ai_predicted": {"manufacturer": maker, "model": model} if (maker or model) else None,
                "on_team_slide": _text(d.get("on_team_slide")).lower().startswith("yes"),
                "tiers": [t for t in pr.TIERS if t in set(_text(d.get("evidence_tiers")).split("+"))],
                "evidence": [e["id"] for e in rows],
                # SOSA: the actual instrument, apart from what it observes
                "procedure": procedure, "sensor": [] if procedure else pr.sensor_terms(d),
                "observes": [{"label": label, "key": pr.term_key(label)} for label in observes],
                "feature": species.get(award, ""), "mentions": named})
            for e in rows:
                evidence.append({"id": e["id"], "device": d["id"], "award": award, "tier": e.get("tier") or "",
                                 "type": _text(e.get("kind")), "text": e.get("text") or "",
                                 "speaker": _text(e.get("speaker_as_written")), "session": "", "date": e.get("date") or "",
                                 "source": self.source_title.get(e.get("source_id"), e.get("source_id") or ""),
                                 "url": e.get("url") or "", "note": _text(e.get("locator"))})
            for label in observes:
                entry = properties.setdefault(pr.term_key(label), {"key": pr.term_key(label), "label": label, "devices": [], "awards": []})
                entry["devices"].append(d["id"])
                if award and award not in entry["awards"]:
                    entry["awards"].append(award)

        topic_of = {}
        for edge in p.edges_by_type.get("ABOUT", ()):
            topic_of.setdefault(edge["source"], _text((p.node.get(edge["target"]) or {}).get("name")))
        discussion = []
        for e in p.evidence:
            if e.get("kind") == "device discussion":
                meeting = p.meeting.get(self.meeting_of[e["id"]]) or {}
                discussion.append({"id": e["id"], "topic": topic_of.get(e["id"], ""), "tier": e.get("tier") or "",
                                   "speaker": _text(e.get("speaker_as_written")), "text": e.get("text") or "",
                                   "session": _text(meeting.get("title")), "date": e.get("date") or "",
                                   "source": self.source_title.get(e.get("source_id"), e.get("source_id") or ""),
                                   "url": e.get("url") or ""})

        properties = sorted(properties.values(), key=lambda x: (-len(x["awards"]), -len(x["devices"]), x["label"].lower()))
        doc = {
            "kind": DEVICES_KIND, "version": VERSION, "from_package": True, "caveat": DEVICES_CAVEAT,
            "tiers": {t: pr.CITE[t] for t in ("T1", "T2", "T3", "U", "TR")}, "sosa": dict(SOSA),
            "rule": "A maker or model the list only guesses is shown as AI-predicted and unverified, never as the device's.",
            "awards": awards, "devices": devices, "evidence": evidence, "discussion": discussion, "orphan_evidence": [],
            "properties": properties, "mention_lines": hits,
            "source": {"description": (f"{len(devices)} lines across {len(awards)} awards, from the {PACKAGE_NAME}: "
                                       f"{sum(not d['procedure'] for d in devices)} sensors and {sum(d['procedure'] for d in devices)} "
                                       f"procedures, {len(properties)} observable properties, {len(hits)} lines of notes and "
                                       "transcripts that name one of them."),
                       "files": p.digest()},
        }
        doc["questions"] = self.device_questions(doc)
        return doc

    def device_questions(self, doc: dict) -> list[dict]:
        devices, lines = doc["devices"], doc["mention_lines"]
        tiers = lambda d: "+".join(d["tiers"]) or "none"     # noqa: E731
        out = []
        sensors = [d for d in devices if not d["procedure"]]
        out.append({"id": "D1", "question": "Which sensors does each award deploy, what does each observe, and what backs it?",
                    "how": "Every line of kind device/sensor: the award, the instrument as the list names it, the observable "
                           "properties it lists as measured, the species studied, and the evidence records with their tiers. "
                           "The verbatim evidence and its locators are on the line itself, in Devices.",
                    "columns": ["Award", "Sensor (the instrument)", "Observes (the property)", "Feature of interest", "Evidence", "Tiers"],
                    "rows": [[d["award"], d["name"], "; ".join(d["measures"]) or "not stated", d["feature"] or "not stated",
                              len(d["evidence"]), tiers(d)] for d in sensors]})

        rows = []
        for d in devices:
            ai = d["ai_predicted"]
            if not ai:
                continue
            backed = [t for t in d["tiers"] if t != "U"]
            rows.append([d["award"], d["name"], ai["manufacturer"] or "none", ai["model"] or "none",
                         "nothing else: the line itself rests on the guess" if not backed else
                         f"the line is backed by {'+'.join(backed)}; the maker and model are not"])
        out.append({"id": "D2", "reads": "absence", "question": "Which device claims rest only on an unverified guess (tier U)?",
                    "how": "Lines with a maker or model that only the AI-assembled list gives. The guess is never a fact; the "
                           "last column says what else backs the line.",
                    "columns": ["Award", "Device", "Maker guessed", "Model guessed", "What else backs it"], "rows": rows})

        out.append({"id": "D3", "question": "Which observable properties are measured across the most awards?",
                    "how": "Each property a line lists as measured, by the name key, with the awards and lines that list it.",
                    "columns": ["Observable property", "Awards", "Lines", "Which awards"],
                    "rows": [[x["label"], len(x["awards"]), len(x["devices"]), ", ".join(x["awards"])] for x in doc["properties"]]})

        rows = []
        for d in devices:
            for what in ("sensor", "property"):
                for named in d["mentions"][what]:
                    first = lines[named["hits"][0]]
                    rows.append([d["award"], d["name"], "the sensor" if what == "sensor" else "what it observes", named["term"],
                                 len(named["hits"]), len({lines[h]["meeting"] for h in named["hits"]} - {""}),
                                 f'{first["tier"]} {first["date"]}: {first["text"]}'])
        out.append({"id": "D4", "question": "Which devices are named in the meeting notes or the transcripts, and in which words?",
                    "how": "Lines whose instrument, or a property it observes, is named in a transcript cue, a chat line or a "
                           "line of the notes: whole words, any case. The first such line is quoted with its tier and date; "
                           "all of them are on the line, in Devices. A match of words can be about something else.",
                    "columns": ["Award", "Device", "Names", "Term", "Lines", "Meetings", "First line (verbatim)"], "rows": rows})

        by_award = defaultdict(lambda: [[], 0])
        for d in devices:
            if d["procedure"]:
                by_award[d["award"]][0].append(d["name"])
            else:
                by_award[d["award"]][1] += 1
        out.append({"id": "D5", "question": "Which awards report a procedure rather than a sensor?",
                    "how": "Awards with at least one line of kind method/procedure, with those lines and the number of sensors "
                           "the award also reports.",
                    "columns": ["Award", "Procedures", "Sensors also reported"],
                    "rows": [[award, "; ".join(names), n] for award, (names, n) in sorted(by_award.items()) if names]})
        for q in out:
            q["count"] = len(q["rows"])
        return out


def refuse_on_ci(parser) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true" or os.environ.get("CI"):
        parser.error("this runs on CI (GITHUB_ACTIONS or CI is set); internal records are built by hand only")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", type=Path, help="the data package's folder (the one that holds kg/ and derived/)")
    parser.add_argument("--out-dir", type=Path, required=True, help="where meetings.json and devices.json go (outside the repo)")
    args = parser.parse_args(argv)
    refuse_on_ci(parser)
    repo = Path(__file__).resolve().parent.parent
    for path in (args.folder, args.out_dir):
        try:
            path.resolve().relative_to(repo)
        except ValueError:
            continue
        parser.error(f"{path} is inside the repository; the package names people and what they said, keep it elsewhere")
    try:
        records = Records(args.folder)
    except pr.PackageError as exc:
        parser.error(str(exc))
    meetings, devices = records.meetings(), records.device_documents()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for name, doc in (("meetings.json", meetings), ("devices.json", devices)):
        (args.out_dir / name).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(meetings['meetings'])} meetings, {len(meetings['items'])} items, {len(meetings['evidence'])} evidence records, "
          f"{len(meetings['sources'])} sources; {len(devices['devices'])} device lines across {len(devices['awards'])} awards, "
          f"{len(devices['properties'])} observable properties, {len(devices['mention_lines'])} mention lines; "
          f"{len(meetings['questions']) + len(devices['questions'])} questions answered; wrote {args.out_dir}")
    for problem in meetings["manifest"]:
        print(f"differs from the package's own counts: {problem}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
