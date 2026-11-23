#!/usr/bin/env python3
"""Tests for the internal records: the package reader (kg/package_reader.py), the Inspector's Meetings
and Devices records built from it with their questions (kg/internal_package.py), and the locks that
keep all of it out of the repository and the public outputs.

    python kg/test_internal.py        # needs kg/requirements.txt (rdflib, pyshacl, PyYAML, click)

Everything runs on the SYNTHETIC package of kg/fixtures/synthetic_package.py, written to a temporary
folder: invented people, awards and text in the real package's layout. The real package is internal
and is never read here. kg/test_exporter.py imports these classes, so the KG workflow's exporter
step runs them too.
"""
import contextlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures"))

import internal_package as ip  # noqa: E402
import package_reader as pr  # noqa: E402
import synthetic_package as synthetic  # noqa: E402

_FOLDER = None


def package_folder() -> Path:
    """The synthetic package, written once per run to a folder outside the repository."""
    global _FOLDER
    if _FOLDER is None:
        _FOLDER = tempfile.TemporaryDirectory(prefix="bbqs-synthetic-package-")
        synthetic.write(_FOLDER.name)
    return Path(_FOLDER.name)


M1, M2, M3, M4, M5, M6, M7 = synthetic.M1, synthetic.M2, synthetic.M3, synthetic.M4, synthetic.M5, synthetic.M6, synthetic.M7


class ThePackageIsRead(unittest.TestCase):
    """kg/package_reader.py: the files of the package's layout, and nothing computed taken for a record."""

    @classmethod
    def setUpClass(cls):
        cls.pkg = pr.Package(package_folder())

    def test_a_folder_with_the_layout_is_a_package_and_any_other_is_not(self):
        self.assertTrue(pr.Package.is_package(package_folder()))
        self.assertFalse(pr.Package.is_package(HERE))
        self.assertFalse(pr.Package.is_package(HERE / "meetings.py"))
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "kg").mkdir()
            (Path(folder) / "kg" / "nodes.jsonl").write_text("", encoding="utf-8")
            self.assertFalse(pr.Package.is_package(folder))          # one file of six
            with self.assertRaises(pr.PackageError) as raised:
                pr.Package(folder)
            self.assertIn("kg/evidence.jsonl", str(raised.exception))

    def test_what_is_read_is_what_the_package_counts(self):
        stats = json.loads((package_folder() / "kg" / "stats.json").read_text(encoding="utf-8"))
        counts = self.pkg.counts()
        self.assertEqual(counts["node_labels"], stats["node_labels"])
        self.assertEqual(counts["edge_types"], stats["edge_types"])
        self.assertEqual((counts["evidence"], counts["evidence_by_tier"]), (stats["evidence"], stats["evidence_by_tier"]))
        self.assertEqual(self.pkg.check_against_stats(), [])
        self.assertEqual((len(self.pkg.meetings), len(self.pkg.items), len(self.pkg.segments)), (7, 19, 6))

    def test_a_count_that_differs_from_stats_json_is_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            synthetic.write(folder)
            path = Path(folder) / "kg" / "evidence.jsonl"
            path.write_text("".join(path.read_text(encoding="utf-8").splitlines(keepends=True)[:-1]), encoding="utf-8")
            problems = pr.Package(folder).check_against_stats()
        self.assertEqual(len(problems), 2, problems)                 # the total and one tier
        self.assertTrue(any("evidence" in p and "20" in p and "19" in p for p in problems), problems)

    def test_an_item_is_its_meetings_nth_entry_of_a_kind(self):
        item = self.pkg.item[f"{M1}:actions-02"]
        self.assertEqual((item["meeting"], item["kind"], item["n"], item["tier"]), (M1, "action", 2, "X"))
        self.assertEqual([i["kind"] for i in self.pkg.items_of(M1)],
                         ["agenda", "agenda", "lesson", "agreement", "disagreement", "decision", "action", "action"])
        self.assertEqual(self.pkg.items_of(M7), [])

    def test_computed_edges_and_terms_are_named_as_such(self):
        self.assertEqual({e["type"] for e in self.pkg.computed_edges},
                         {"PART_OF", "CO_SPOKE_WITH", "SPOKE_IN_GROUP", "CO_COMMENTED_WITH", "USED_TERM"})
        self.assertTrue(all(e["tier"] == "A" for e in self.pkg.computed_edges))
        self.assertFalse(any(e["type"] in pr.COMPUTED_EDGES for e in self.pkg.stated_edges))


class ContactDataStaysOut(unittest.TestCase):
    """Every web link, e-mail address and assignee inside a carried text becomes a marker."""

    def test_links_addresses_and_assignees_are_replaced(self):
        for text, want in (
            ("join at https://meet.example.org/j/123?pwd=abc.", "join at [link redacted]."),
            ("(see www.example.org/a)", "(see [link redacted])"),
            ("poll: orms.example/abc123 today", "poll: [link redacted] today"),
            ("mail someone@example.org or ada.example@lab", "mail [email redacted] or [email redacted]"),
            ("_Assigned to ada.example_", "_Assigned to [name redacted]_"),
            ("already [email redacted] and [link redacted]", "already [email redacted] and [link redacted]"),
        ):
            self.assertEqual(pr.redact(text), want)

    def test_what_is_not_contact_data_is_left_as_written(self):
        for text in ("@Ada please review the notes.docx", "login.example is down", "U.S./Canada sites, i.e./e.g. two",
                     "version 2.1/draft at 3 p.m./noon", "Zoom worked; a Doodle poll went out"):
            self.assertEqual(pr.redact(text), text)

    def test_line_counts_never_change(self):
        text = "a\nhttps://x.example/1\n\nb https://x.example/2 c\nd@e.example\n"
        self.assertEqual(pr.redact(text).count("\n"), text.count("\n"))
        self.assertEqual(pr.redact(text).splitlines()[3], "b [link redacted] c")

    def test_the_package_is_redacted_as_it_is_read(self):
        pkg = pr.Package(package_folder())
        steering = pkg.segment["seg:steering-example-2026-03-03"]["text"]
        self.assertEqual(steering.splitlines()[-1], "Shared Desk sends the minutes: [link redacted] ([email redacted]).")
        self.assertEqual(pkg.segment["seg:standards-example-2026-02-10-2"]["text"].splitlines()[-1],
                         "_Assigned to [name redacted]_")
        self.assertEqual(dict(pkg.redactions), {"link": 1, "email": 1, "name": 1})
        carried = json.dumps([pkg.evidence, pkg.segments, pkg.nodes])
        for leaked in ("meet.example.org", "pwd=abc", "shared.desk@", "ada.example_"):
            self.assertNotIn(leaked, carried)
        # a record's own source link is not a text: it is kept
        self.assertEqual(pkg.evidence_by_id["utt:2026-01-15-0001"]["url"], "https://docs.example.org/tr-2026-01-15-example")


class NotesBlocks(unittest.TestCase):
    """Which notes block a meeting's items paraphrase: the block the package cites, and two repairs."""

    @classmethod
    def setUpClass(cls):
        cls.pkg = pr.Package(package_folder())
        cls.links = cls.pkg.segment_links()

    def link(self, meeting):
        return [(l["segment"], l["how"], l["repaired"]) for l in self.links["by_meeting"].get(meeting, [])]

    def test_the_block_the_package_cites_is_kept(self):
        self.assertEqual(self.link(M1), [("seg:standards-example-2026-01-15", "cited", False)])
        self.assertEqual(self.link(M4), [("seg:steering-example-2026-03-03", "cited", False)])

    def test_an_uncited_block_of_the_same_group_and_date_joins_its_meeting(self):
        self.assertEqual(self.link(M2), [("seg:standards-example-2026-02-10", "cited", False),
                                         ("seg:standards-example-2026-02-10-2", "same_group_and_date", True)])

    def test_a_meeting_written_inside_another_block_is_found_by_its_dated_heading(self):
        self.assertEqual(self.link(M3), [("seg:standards-example-2026-01-15", "names_this_date", True)])
        self.assertEqual(self.links["by_meeting"][M3][0]["lines"], [6])       # "Standards WG lunch: December 1, 2025"

    def test_a_meeting_with_no_block_anywhere_has_none(self):
        self.assertEqual(self.link(M6), [])
        self.assertEqual(self.link(M7), [])

    def test_a_block_no_meeting_has_is_listed_and_not_given_away(self):
        self.assertEqual(self.links["unattached"], ["seg:steering-example-2026-07-07"])

    def test_a_block_is_never_given_to_one_of_two_meetings_of_a_group_and_date(self):
        with tempfile.TemporaryDirectory() as folder:
            synthetic.write(folder)
            path = Path(folder) / "kg" / "nodes.jsonl"
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            twin = dict(next(r for r in rows if r["id"] == M2), id=M2 + "-2", notes_segment="")
            path.write_text("".join(json.dumps(r) + "\n" for r in rows + [twin]), encoding="utf-8")
            links = pr.Package(folder).segment_links()
        self.assertEqual([l["segment"] for l in links["by_meeting"][M2]], ["seg:standards-example-2026-02-10"])
        self.assertEqual(links["by_meeting"].get(M2 + "-2", []), [])
        self.assertIn("seg:standards-example-2026-02-10-2", links["unattached"])

    def test_the_ways_a_date_is_written(self):
        for line in ("Lunch: December 1, 2025", "Dec 1 2025", "December, 1 2025", "Dec. 1st, 2025", "* Agenda 2025/12/01",
                     "2025-12-1 notes", "12/1/2025: planning", "Agenda for 2025/12/1:"):
            self.assertEqual(pr.date_lines(line, "2025-12-01"), ([0], "day"), line)
        for line in ("December 11, 2025", "2025/12/011", "1/12/2025", "December 1, 2026", "12/1/20251", "version 2025.12"):
            self.assertEqual(pr.date_lines(line, "2025-12-01"), ([], None), line)
        self.assertEqual(pr.date_lines("Kick-off: December 2025\nnext line", "2025-12-01"), ([0], "month"))
        self.assertEqual(pr.date_lines("December 2025\nDecember 1, 2025", "2025-12-01"), ([1], "day"))   # the day wins


class WhoSaidIt(unittest.TestCase):
    """A record's speaker: the name as written, the person the package resolved it to, and how."""

    @classmethod
    def setUpClass(cls):
        cls.pkg = pr.Package(package_folder())

    def speaker(self, evidence_id):
        return self.pkg.speaker(self.pkg.evidence_by_id[evidence_id])

    def test_a_full_name_needs_no_alias(self):
        s = self.speaker("utt:2026-01-15-0001")
        self.assertEqual((s["as_written"], s["name"], s["verify"]), ("Ada Example", "Ada Example", False))
        self.assertEqual(s["how"], "the full name, as written")

    def test_a_verify_alias_is_flagged(self):
        s = self.speaker("utt:2026-01-15-0002")
        self.assertEqual((s["as_written"], s["name"], s["verify"]), ("Ben", "Ben Sample", True))
        self.assertIn("VERIFY", s["how"])

    def test_an_alias_that_is_not_a_guess_is_not_flagged(self):
        s = self.speaker("utt:2026-01-15-0003")
        self.assertEqual((s["as_written"], s["name"], s["verify"], s["how"]),
                         ("A. Example", "Ada Example", False, "Zoom display name"))

    def test_a_name_the_alias_table_does_not_explain_says_so(self):
        s = self.speaker("devev:0006")
        self.assertEqual((s["as_written"], s["name"], s["verify"]), ("Ben Sample (with a student)", "Ben Sample", False))
        self.assertEqual(s["how"], "the alias table does not record how this name was resolved")

    def test_a_record_with_no_person_keeps_the_name_as_written(self):
        s = self.speaker("devev:0001")
        self.assertEqual((s["as_written"], s["person"], s["name"]), ("(team slide; author not recorded)", "", ""))

    def test_a_shared_account_carries_its_note(self):
        s = self.speaker("cmt:ex-0002")
        self.assertEqual((s["name"], s["note"]), ("Shared Desk", "shared account, not an individual"))

    def test_an_item_is_attributed_to_whom_the_package_says_with_how_each_name_was_read(self):
        who = self.pkg.raised_by(f"{M1}:agreements-01")
        self.assertEqual([(w["name"], w["as_written"], w["verify"]) for w in who],
                         [("Ada Example", "Ada", False), ("Ben Sample", "Ben", True)])
        self.assertEqual(who[0]["how"], "first name in notes")
        dee = self.pkg.raised_by(f"{M3}:lessons-01")
        self.assertEqual([(w["name"], w["as_written"], w["how"]) for w in dee], [("Dee", "Dee", "the full name, as written")])
        self.assertEqual(self.pkg.raised_by(f"{M1}:actions-01"), [])            # the package attributes no action here

    def test_a_note_line_is_placed_in_the_meeting_whose_block_holds_it(self):
        e = self.pkg.evidence_by_id["devx:xev-002"]
        self.assertEqual(e["meeting"], "")
        self.assertEqual(self.pkg.meeting_of(e), (M1, "by the line its locator cites"))
        self.assertEqual(self.pkg.meeting_of(self.pkg.evidence_by_id["utt:2026-01-15-0001"]), (M1, "stated"))
        self.assertEqual(self.pkg.meeting_of(self.pkg.evidence_by_id["devx:xev-001"]), ("", ""))     # a summary line
        self.assertEqual(self.pkg.meeting_of(self.pkg.evidence_by_id["cmt:ex-0002"]), ("", ""))


class DeviceTerms(unittest.TestCase):
    """What a device row names, and the lines of notes and transcripts that name it: plain text matching."""

    @classmethod
    def setUpClass(cls):
        cls.pkg = pr.Package(package_folder())
        cls.dev = {d["id"]: d for d in cls.pkg.by_label["Device"]}

    def test_a_list_is_split_at_commas_outside_brackets(self):
        self.assertEqual(pr.split_top("Pose, action clusters (idle, grooming, etc), gait; EEG / LFP"),
                         ["Pose", "action clusters (idle, grooming, etc)", "gait", "EEG / LFP"])
        self.assertEqual(pr.split_top(" , ;"), [])

    def test_the_observable_properties_of_a_row(self):
        self.assertEqual(pr.property_labels(self.dev[synthetic.DEV1]), ["Body posture", "Heart rate"])
        self.assertEqual(pr.property_labels({"measures": "Heart rate, heart  rate, etc., Pose; etc"}), ["Heart rate", "Pose"])

    def test_the_names_a_sensor_goes_by(self):
        self.assertEqual(pr.sensor_terms(self.dev[synthetic.DEV1]), ["Depth camera", "Acme Optics"])
        self.assertEqual(pr.sensor_terms({"name": "Video (GoCam Hero / Lumen), thermal", "manufacturer_stated": "GoCam, Lumen"}),
                         ["Video", "GoCam Hero", "Lumen", "thermal", "GoCam"])
        self.assertEqual(pr.sensor_terms({"name": "EEG", "manufacturer_stated": ""}), ["EEG"])
        self.assertEqual(pr.sensor_terms({"name": "PC", "manufacturer_stated": "custom"}), [])      # too short; a filler

    def test_a_term_matches_whole_words_in_any_case_and_a_plural(self):
        hit = lambda term, text: bool(pr.term_pattern(term).search(text))
        self.assertTrue(hit("Depth camera", "the DEPTH  CAMERA rig"))
        self.assertTrue(hit("Depth camera", "two depth cameras"))
        self.assertTrue(hit("Microphones", "one microphone"))
        self.assertTrue(hit("EEG", "EEG/LFP"))
        self.assertFalse(hit("EEG", "iEEG"))
        self.assertFalse(hit("Pose", "purposes"))
        self.assertFalse(hit("gas", "a gasket"))

    def test_the_mentions_are_the_lines_that_name_the_term(self):
        mentions = self.pkg.mentions()
        where = lambda term: [(h["tier"], h["where"], h["meeting"]) for h in mentions["terms"][pr.term_key(term)]["hits"]]
        self.assertEqual(where("Depth camera"), [
            ("TR", "utt:2026-01-15-0002", M1),
            ("T3", "seg:standards-example-2026-01-15#4", M1),
            ("T3", "seg:devices-example-2026-04-01#1", M5)])
        self.assertEqual(where("Heart rate"), [
            ("TR", "utt:2026-01-15-0003", M1),
            ("T3", "seg:standards-example-2026-01-15#5", M1),
            ("T3", "seg:standards-example-2026-01-15#7", M3)])       # under the dated heading of the lunch meeting
        self.assertEqual(where("Acme Optics"), [])
        self.assertEqual(mentions["by_device"][synthetic.DEV1],
                         {"sensor": [pr.term_key("Depth camera"), pr.term_key("Acme Optics")],
                          "property": [pr.term_key("Body posture"), pr.term_key("Heart rate")]})
        hit = mentions["terms"][pr.term_key("Depth camera")]["hits"][0]
        self.assertEqual((hit["text"], hit["speaker"]["as_written"], hit["speaker"]["verify"], hit["date"]),
                         ("The depth camera needs a calibration file per session.", "Ben", True, "2026-01-15"))
        note = mentions["terms"][pr.term_key("Depth camera")]["hits"][1]
        self.assertEqual((note["text"], note["source"], note["locator"]),
                         ("The depth camera calibration files came up; Cy is against requiring them.",
                          "src:notes-standards-example", "notes block lines 2-9, line 5 of the block"))

    def test_an_ai_summary_is_never_a_mention(self):
        hits = [h for term in self.pkg.mentions()["terms"].values() for h in term["hits"]]
        self.assertEqual({h["tier"] for h in hits}, {"TR", "T3"})
        self.assertFalse(any("Depth camera demo" in h["text"] for h in hits))        # an agenda item of M5, tier X


class TheInspectorRecords(unittest.TestCase):
    """kg/internal_package.py: the package as the Meetings and Devices records the Inspector reads."""

    @classmethod
    def setUpClass(cls):
        cls.records = ip.Records(package_folder())
        cls.meetings, cls.devices = cls.records.meetings(), cls.records.device_documents()
        cls.meeting = {m["id"]: m for m in cls.meetings["meetings"]}
        cls.item = {i["id"]: i for i in cls.meetings["items"]}
        cls.evidence = {e["id"]: e for e in cls.meetings["evidence"]}
        cls.device = {d["name"]: d for d in cls.devices["devices"]}

    def question(self, doc, qid):
        found = [q for q in doc["questions"] if q["id"] == qid]
        self.assertEqual(len(found), 1, qid)
        self.assertEqual(found[0]["count"], len(found[0]["rows"]))
        self.assertTrue(all(len(row) == len(found[0]["columns"]) for row in found[0]["rows"]), qid)
        return found[0]["rows"]

    # ---- meetings

    def test_the_records_are_the_kinds_the_inspector_reads_and_count_what_the_package_holds(self):
        pkg = self.records.pkg
        self.assertEqual((self.meetings["kind"], self.devices["kind"]), ("bbqs-meetings", "bbqs-devices"))
        self.assertTrue(self.meetings["from_package"] and self.devices["from_package"])
        self.assertEqual(len(self.meetings["meetings"]), len(pkg.meetings))
        self.assertEqual(len(self.meetings["items"]), len(pkg.items))               # agenda items too
        self.assertEqual(len(self.meetings["evidence"]), len(pkg.evidence))
        self.assertEqual(len(self.meetings["sources"]), len(pkg.sources))
        self.assertEqual(self.meetings["manifest"], [])                              # as kg/stats.json counts them
        self.assertEqual(len(self.devices["devices"]), len(pkg.by_label["Device"]))
        self.assertEqual(sum(self.meeting[M1]["counts"].values()), 8)

    def test_every_point_is_marked_an_ai_summary_and_never_a_quote(self):
        self.assertEqual({i["tier"] for i in self.meetings["items"]}, {"X"})
        self.assertTrue(all(i["quotes"] == [] for i in self.meetings["items"]))
        self.assertIn("AI summary", self.meetings["caveat"])
        self.assertEqual(set(self.meetings["tiers"]), set(pr.TIERS))

    def test_the_records_carry_no_attribution_to_a_person(self):
        # Who said what is the reader's to know (WhoSaidIt above) and to count with; the records name nobody.
        self.assertTrue(all(i["who"] == [] for i in self.meetings["items"]))
        self.assertTrue(self.item[M1 + ":agreements-01"]["attributed"])
        for key in ("speaker", "as_written", "verify", "basis"):
            self.assertNotIn(key, self.evidence["utt:2026-01-15-0002"])
    def test_a_shared_account_is_not_a_person_so_its_label_stays_and_nobody_is_listed(self):
        self.assertEqual(self.item[M4 + ":actions-01"]["text"], "Shared Desk: send the minutes")
        self.assertEqual(self.meetings["people"], [])
        self.assertEqual(self.evidence["cmt:ex-0002"]["attributed_to"], "the consortium")
        self.assertFalse(any(m["speakers"] for m in self.meetings["meetings"]))

    def test_a_meeting_carries_the_notes_its_points_summarize_and_says_how_they_were_found(self):
        self.assertEqual((self.meeting[M1]["notes"]["how"], self.meeting[M1]["notes"]["repaired"]), ("cited", False))
        inside = self.meeting[M3]["notes"]                     # written inside another meeting's block
        self.assertEqual((inside["how"], inside["repaired"]), ("names_this_date", True))
        self.assertIn("[name]: heart rate sensors drift", inside["text"])
        self.assertNotEqual(inside["text"], self.meeting[M1]["notes"]["text"])
        self.assertIn("2025", inside["text"].splitlines()[0])  # it starts at its own dated line
        self.assertIsNone(self.meeting[M7]["notes"])           # a transcript, and no notes at all
        none = [m["id"] for m in self.meetings["meetings"] if m["notes"] is None]
        self.assertEqual(len(none), 2)
    def test_evidence_says_its_tier_kind_meeting_and_time(self):
        cue = self.evidence["utt:2026-01-15-0001"]
        self.assertEqual((cue["tier"], cue["kind"], cue["meeting"], cue["attributed_to"]), ("TR", "utterance", M1, "Standards WG"))
        self.assertEqual((cue["start"], cue["end"]), ("00:00:02.000", "00:00:05.000"))
        self.assertEqual(self.evidence["cmt:ex-0003"]["meeting"], "")       # a comment on a document: no meeting
        self.assertNotIn("start", self.evidence["cmt:ex-0003"])
        self.assertEqual(self.evidence["devx:xev-002"]["meeting"], M1)      # a note line, placed by its locator
        self.assertEqual(self.meeting[M1]["evidence"], 5)
        self.assertEqual([m["id"] for m in self.meetings["meetings"] if m["transcript"]], [M1, M7])
        self.assertEqual({e["kind"] for e in self.meetings["evidence"]} - set(pr.EVIDENCE_KINDS.values()), set())
    def test_no_contact_data_is_in_a_carried_text(self):
        # Every text that goes onto the page, whatever key holds it: no web link and no e-mail address.
        # A record's own source link stays, in its `url`, and nowhere else.
        link, mail, seen = re.compile(r"https?://|www\.", re.I), re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), 0

        def walk(value, key=""):
            nonlocal seen
            if isinstance(value, dict):
                for k, v in value.items():
                    walk(v, k)
            elif isinstance(value, list):
                for v in value:
                    walk(v, key)
            elif isinstance(value, str) and key not in ("url", "sha256", "files"):
                seen += 1
                self.assertIsNone(link.search(value), (key, value[:80]))
                self.assertIsNone(mail.search(value), (key, value[:80]))

        walk(self.meetings)
        walk({k: v for k, v in self.devices.items() if k != "source"})
        self.assertGreater(seen, 300)
        self.assertIn("[link redacted]", json.dumps(self.meetings))          # the fixture plants links: they were there
        self.assertGreater(self.records.pkg.redactions["link"], 0)

    def test_computed_edges_and_terms_never_become_records(self):
        text = json.dumps([self.meetings, self.devices])
        for computed in ("CO_SPOKE_WITH", "USED_TERM", "SPOKE_IN_GROUP", "CO_COMMENTED_WITH", "wg_betweenness", "wg_community"):
            self.assertNotIn(computed, text)

    # ---- the questions about meetings, on the synthetic package's known answers

    def test_m1_decisions_and_whether_the_notes_back_them(self):
        self.assertEqual(self.question(self.meetings, "M1"), [
            ["2026-01-15", "Standards WG", "Adopt the template for the next data blitz ([name])", "yes", "notes block"],
            ["2026-02-10", "Standards WG", "Calibration files are required", "no", "notes block"],
            ["2026-03-03", "Sample Devices WG", "Fund a second hackathon", "no", "notes block"]])
    def test_m2_the_meetings_with_a_transcript(self):
        # three cues by two people (one of them written two ways): a count of speakers, and nobody named
        self.assertEqual(self.question(self.meetings, "M2"), [
            ["2026-01-15", "Standards WG", "Template review", 3, 2, "00:00:02.000", "00:00:15.250"],
            ["2026-01-20", "Example Paper Group", "Paper planning", 1, 1, "00:00:01.000", "00:00:04.000"]])
    def test_m4_meetings_whose_points_have_no_evidence(self):
        rows = self.question(self.meetings, "M4")
        self.assertEqual([(r[0], r[3], r[4]) for r in rows], [
            ("2025-12-01", 2, "notes block (link repaired)"), ("2026-02-10", 3, "notes block"), ("2026-03-03", 3, "notes block"),
            ("2026-04-01", 2, "notes block"), ("2026-05-05", 1, "no notes block")])

    def test_m5_how_many_spoke_in_each_group_and_whether_a_transcript_says_so(self):
        self.assertEqual(self.question(self.meetings, "M5"), [
            ["Example Paper Group", 1, 1, 1], ["Example Steering Committee", 1, 1, 0],
            ["Sample Devices WG", 1, 2, 0], ["Standards WG", 2, 3, 2]])
    def test_m6_how_many_attributions_rest_on_a_guess(self):
        self.assertEqual(self.question(self.meetings, "M6"), [["evidence records", 1, 1], ["item attributions", 1, 1]])
    def test_m7_disagreements_and_the_next_decision(self):
        rows = self.question(self.meetings, "M7")
        self.assertEqual(rows, [["2026-01-15", "Standards WG",
                                 "Whether depth camera calibration files are required: [name] for, [name] against", "2026-01-15"]])
    def test_m8_actions_and_whether_the_notes_name_an_owner(self):
        rows = self.question(self.meetings, "M8")
        self.assertEqual([(r[0], r[2], r[3]) for r in rows], [
            ("2026-01-15", "[name]: draft the template guide", "no"), ("2026-01-15", "[name] to collect example files", "no"),
            ("2026-03-03", "Shared Desk: send the minutes", "no")])
    def test_m10_sources_nothing_cites(self):
        # "Example" is somebody's surname in this package, so it is replaced where it is not part of a
        # group's name: the price of replacing a name wherever it stands.
        self.assertEqual(self.question(self.meetings, "M10"), [
            ["Example Steering Committee notes", "meeting notes (Google Doc)"],
            ["[name] Devices WG notes", "meeting notes (Google Doc)"], ["[name] workshop agenda", "agenda"]])
        self.assertEqual([q["id"] for q in self.meetings["questions"]], ["M1", "M2", "M4", "M5", "M6", "M7", "M8", "M10"])
        self.assertEqual({q["id"] for q in self.meetings["questions"] if q.get("reads") == "absence"}, {"M4", "M6", "M10"})
    # ---- devices: the actual instrument, apart from what it observes

    def test_a_sensor_is_kept_apart_from_what_it_observes(self):
        camera = self.device["Depth camera (Acme Optics)"]
        self.assertFalse(camera["procedure"])
        self.assertEqual(camera["sensor"], ["Depth camera", "Acme Optics"])
        self.assertEqual(camera["observes"], [{"label": "Body posture", "key": pr.term_key("Body posture")},
                                              {"label": "Heart rate", "key": pr.term_key("Heart rate")}])
        self.assertEqual(camera["measures"], ["Body posture", "Heart rate"])
        self.assertEqual(camera["feature"], "Mouse")                        # the award's species: the feature of interest
        self.assertEqual(self.device["Wearable heart monitor"]["feature"], "")
        self.assertEqual(set(self.devices["sosa"]), {"sensor", "property", "feature", "procedure", "deployment"})

    def test_a_method_is_a_procedure_and_not_a_sensor(self):
        coding = self.device["Behavioral coding"]
        self.assertTrue(coding["procedure"])
        self.assertEqual(coding["sensor"], [])
        self.assertEqual([o["label"] for o in coding["observes"]], ["Social interaction"])
        self.assertEqual(coding["mentions"], {"sensor": [], "property": []})

    def test_one_property_however_it_is_spelled_and_the_awards_that_observe_it(self):
        props = {x["label"]: x for x in self.devices["properties"]}
        self.assertEqual(sorted(props), ["Body posture", "Gaze", "Heart rate", "Social interaction"])    # "body posture" is Body posture
        self.assertEqual(props["Body posture"]["awards"], ["R34DA000001", "R61MH000002"])
        self.assertEqual(len(props["Body posture"]["devices"]), 2)
        self.assertEqual(props["Heart rate"]["awards"], ["R34DA000001", "U01DA000003"])
        self.assertEqual([x["label"] for x in self.devices["properties"]][:2], ["Body posture", "Heart rate"])   # most awards first

    def test_a_guess_stays_a_guess_and_a_placeholder_is_not_one(self):
        camera, fish, monitor = (self.device[n] for n in ("Depth camera (Acme Optics)", "DepthCam 3000", "Wearable heart monitor"))
        self.assertEqual(camera["brand_stated"], "Acme Optics")                                  # on the slide: stated
        self.assertEqual(camera["ai_predicted"], {"manufacturer": "", "model": "Depth 3000"})    # only the list's guess
        self.assertIsNone(fish["ai_predicted"])                                                  # "Not specified in record"
        self.assertEqual(monitor["ai_predicted"], {"manufacturer": "Sample Devices Ltd., Springfield", "model": "HM-1 (VERIFY)"})
        self.assertEqual(monitor["brand_stated"], "")
        self.assertEqual((camera["tiers"], fish["tiers"], monitor["tiers"]), (["T1", "T2", "U"], ["T1", "T2"], ["T2", "U"]))
        self.assertEqual((camera["on_team_slide"], monitor["on_team_slide"]), (True, False))
        for device in self.devices["devices"]:
            for guess in (device["ai_predicted"] or {}).values():
                if guess:
                    self.assertNotIn(guess, (device["name"], device["brand_stated"]))

    def test_the_mentions_are_verbatim_lines_that_name_the_sensor_or_the_property(self):
        camera, lines = self.device["Depth camera (Acme Optics)"], self.devices["mention_lines"]
        named = {(what, g["term"]): [lines[h] for h in g["hits"]] for what in ("sensor", "property") for g in camera["mentions"][what]}
        self.assertEqual(sorted(named), [("property", "Heart rate"), ("sensor", "Depth camera")])
        sensor = named[("sensor", "Depth camera")]
        self.assertEqual([(h["tier"], h["kind"]) for h in sensor], [("TR", "utterance"), ("T3", "notes_line"), ("T3", "notes_line")])
        self.assertTrue(all("depth camera" in h["text"].lower() for h in sensor))
        self.assertEqual((sensor[0]["meeting"], sensor[0]["attributed_to"]), (M1, "Standards WG"))
        self.assertTrue(all("speaker" not in h and "as_written" not in h for h in lines))
        self.assertEqual(sensor[1]["text"], "The depth camera calibration files came up; [name] is against requiring them.")
        self.assertTrue(all("heart rate" in h["text"].lower() for h in named[("property", "Heart rate")]))
        self.assertEqual({h["tier"] for h in lines}, {"TR", "T3"})          # what was said, and the notes: never an AI summary
        self.assertEqual(len({h["where"] for h in lines}), len(lines))      # each line once, however many terms it names
        self.assertEqual(self.device["DepthCam 3000"]["mentions"], {"sensor": [], "property": []})   # "DepthCam" is not "depth camera"
    def test_whether_someone_spoke_to_a_device_is_kept_and_who_is_not(self):
        self.assertEqual([(d["name"], d["spoken_to"], d["presenter"]) for d in self.devices["devices"]], [
            ("Depth camera (Acme Optics)", True, ""), ("Behavioral coding", False, ""),
            ("DepthCam 3000", True, ""), ("Wearable heart monitor", True, "")])
        by_id = {e["id"]: e for e in self.devices["evidence"]}
        self.assertEqual({e["tier"] for e in by_id.values()}, {"T1", "T2", "U"})
        self.assertEqual(sorted(e["type"] for e in by_id.values() if e["device"] == self.device["Wearable heart monitor"]["id"]),
                         ["manufacturer/model candidate", "speaker attribution (workshop)"])
        self.assertEqual(len(self.devices["discussion"]), 2)
        self.assertEqual({d["attributed_to"] for d in self.devices["discussion"]}, {"the consortium", "Standards WG"})
    # ---- the questions about devices

    def test_d1_what_each_award_deploys_and_what_it_observes(self):
        self.assertEqual(self.question(self.devices, "D1"), [
            ["R34DA000001", "Depth camera (Acme Optics)", "Body posture; Heart rate", "Mouse", 3, "T1+T2+U"],
            ["R61MH000002", "DepthCam 3000", "body posture; Gaze", "Zebrafish, Mouse", 2, "T1+T2"],
            ["U01DA000003", "Wearable heart monitor", "Heart rate", "not stated", 2, "T2+U"]])

    def test_d2_claims_that_rest_on_a_guess(self):
        rows = self.question(self.devices, "D2")
        self.assertEqual([(r[1], r[2], r[3]) for r in rows], [
            ("Depth camera (Acme Optics)", "none", "Depth 3000"),
            ("Wearable heart monitor", "Sample Devices Ltd., Springfield", "HM-1 (VERIFY)")])
        self.assertEqual(rows[0][4], "the line is backed by T1+T2; the maker and model are not")
        self.assertEqual(rows[1][4], "the line is backed by T2; the maker and model are not")

    def test_d3_properties_observed_across_the_most_awards(self):
        self.assertEqual(self.question(self.devices, "D3"), [
            ["Body posture", 2, 2, "R34DA000001, R61MH000002"], ["Heart rate", 2, 2, "R34DA000001, U01DA000003"],
            ["Gaze", 1, 1, "R61MH000002"], ["Social interaction", 1, 1, "R34DA000001"]])

    def test_d4_devices_named_in_the_notes_and_transcripts(self):
        rows = self.question(self.devices, "D4")
        self.assertEqual([(r[1], r[2], r[3], r[4], r[5]) for r in rows], [
            ("Depth camera (Acme Optics)", "the sensor", "Depth camera", 3, 2),
            ("Depth camera (Acme Optics)", "what it observes", "Heart rate", 3, 2),
            ("Wearable heart monitor", "what it observes", "Heart rate", 3, 2)])
        self.assertEqual(rows[0][6], "TR 2026-01-15: The depth camera needs a calibration file per session.")

    def test_d5_awards_that_report_a_procedure(self):
        self.assertEqual(self.question(self.devices, "D5"), [["R34DA000001", "Behavioral coding", 1]])
        self.assertEqual([q["id"] for q in self.devices["questions"]], ["D1", "D2", "D3", "D4", "D5"])


class NamesAreReplaced(unittest.TestCase):
    """kg/package_reader.py's NameScrubber: which words of a text are somebody's name."""

    def setUp(self):
        self.names = pr.NameScrubber(["Mark Young", "Ada Example", "Li Na", "Ben Sample (with a student)", "(summary author)",
                                      "João Rübel", "Admin BBQS"],
                                     protected=["Example Steering Committee", "Young Lab Systems", "Ada Lovelace Institute"])

    def test_a_full_name_goes_wherever_it_stands_in_any_case(self):
        self.assertEqual(self.names.scrub("as Mark Young said, and mark young again; ADA  EXAMPLE too"),
                         "as [name] said, and [name] again; [name] too")
        self.assertEqual(self.names.scrub("João Rübel opened; Rübel closed"), "[name] opened; [name] closed")

    def test_a_single_word_of_a_name_goes_where_it_is_written_as_the_name(self):
        self.assertEqual(self.names.scrub("Ada for, Example against; an example and ada lowercase stay"),
                         "[name] for, [name] against; an example and ada lowercase stay")
        self.assertEqual(self.names.scrub("Sample (Ben) and Ben's rig"), "[name] ([name]) and [name]'s rig")
        self.assertEqual(self.names.scrub("Adamant, Benefit, Examples"), "Adamant, Benefit, Examples")     # whole words only

    def test_an_ordinary_word_that_is_also_a_name_goes_only_where_it_is_used_as_one(self):
        self.assertEqual(self.names.scrub("Mark the files as Young investigators do."), "Mark the files as Young investigators do.")
        self.assertEqual(self.names.scrub("Mark: do it\n- Young: agreed\n(Mark) and (Ada, Young) and Mark's turn, @Young"),
                         "[name]: do it\n- [name]: agreed\n([name]) and ([name], [name]) and [name]'s turn, @[name]")

    def test_a_two_letter_name_is_a_name_unless_it_is_a_common_word(self):
        self.assertEqual(self.names.scrub("Li presented and Na agreed"), "[name] presented and [name] agreed")
        both = pr.NameScrubber(["He Ma"])
        self.assertEqual(both.scrub("He said so. Ma: yes. He Ma spoke"), "He said so. [name]: yes. [name] spoke")

    def test_what_is_not_a_person_keeps_its_name(self):
        self.assertEqual(self.names.scrub("Example Steering Committee met at the Ada Lovelace Institute with Young Lab Systems"),
                         "Example Steering Committee met at the Ada Lovelace Institute with Young Lab Systems")
        self.assertEqual(self.names.scrub("BBQS Admin wrote; the student and the summary author too"),
                         "BBQS Admin wrote; the student and the summary author too")
        self.assertNotIn("Admin", self.names.words)
        self.assertNotIn("BBQS", self.names.words)

    def test_a_group_written_where_an_author_would_be_is_not_a_person(self):
        # The real package writes a working group as the author of a line of its notes. That made
        # "Devices WG" a full name, and "Devices" a name to replace wherever it stood (2026-11-23).
        names = pr.NameScrubber(["Devices WG", "Devices WG notes", "Ada Example", "Standards", "Dan Standards"], protected=["Depth camera"],
                                groups=["Devices WG", "Data Standards WG", "Example Steering Committee"])
        self.assertEqual(names.full, {"Ada Example", "Dan Standards"})
        self.assertEqual(names.words, {"Ada", "Example", "Dan", "Standards"})     # a person's own words stay names
        self.assertEqual(names.scrub("Devices WG met; Devices were listed; Ada Example agreed in the Example Steering Committee; Dan too"),
                         "Devices WG met; Devices were listed; [name] agreed in the Example Steering Committee; [name] too")
        self.assertEqual(names.leaks({"topic": "Devices WG and sensors"}), 0)
        alone = pr.NameScrubber(["Devices WG", "Standards", "Ada"], groups=["Devices WG", "Data Standards WG"])
        self.assertEqual(alone.words, {"Ada"})               # "Standards" alone is the group, not somebody
        self.assertEqual(alone.scrub("Standards apply; Ada agreed"), "Standards apply; [name] agreed")

    def test_it_counts_what_it_replaced_and_finds_a_full_name_left_in_a_record(self):
        self.names.scrub("Mark Young and Ada")
        self.assertEqual(self.names.count, 2)
        doc = {"text": "Ada spoke", "group": "Ada Example Memorial WG", "rows": [["Mark Young", 3]], "name": "Li Na"}
        cleaned = self.names.scrub_document(doc)
        self.assertEqual(cleaned, {"text": "[name] spoke", "group": "Ada Example Memorial WG", "rows": [["[name]", 3]], "name": "Li Na"})
        self.assertEqual(self.names.leaks(cleaned), 2)        # a group and a `name` are not carried text: left, and found
        self.assertEqual(self.names.leaks({"text": "[name] spoke"}), 0)


class NobodyIsNamed(unittest.TestCase):
    """The owner's decision (2026-11-23): a statement is attributed to the consortium, to the working
    group it was made in, and never to a named person. No speaker, author, attendee or owner is named,
    and a name inside a carried text is replaced by a marker."""

    NAMES = ("Ada Example", "Ben Sample", "Cy Placeholder", "Eve Roster", "Dee Placeholder", "A. Example",
             "Ada", "Ben", "Cy", "Dee", "Eve", "Roster", "Placeholder")

    @classmethod
    def setUpClass(cls):
        cls.records = ip.Records(package_folder())
        cls.meetings, cls.devices = cls.records.meetings(), cls.records.device_documents()

    def test_no_name_of_anyone_in_the_package_is_anywhere_in_the_records(self):
        for doc in (self.meetings, self.devices):
            text = json.dumps(doc, ensure_ascii=False)
            for name in self.NAMES:
                found = re.search(r"(?<![A-Za-z])" + re.escape(name) + r"(?![A-Za-z])", text)
                self.assertIsNone(found, f"{doc['kind']} names {name!r}: ...{text[max(0, (found.start() if found else 0) - 60):(found.end() if found else 0) + 40]}...")
        self.assertTrue(self.meetings["anonymous"] and self.devices["anonymous"])

    def test_a_statement_is_attributed_to_its_working_group_or_to_the_consortium(self):
        evidence = {e["id"]: e for e in self.meetings["evidence"]}
        self.assertEqual(evidence["utt:2026-01-15-0001"]["attributed_to"], "Standards WG")
        self.assertEqual(evidence["cmt:ex-0003"]["attributed_to"], "the consortium")           # a comment on a document
        for e in self.meetings["evidence"]:
            self.assertEqual({k for k in ("speaker", "as_written", "basis", "author_note", "verify") if k in e}, set(), e["id"])
        self.assertEqual(self.meetings["people"], [])
        self.assertEqual(self.meetings["unresolved"], [])
        for tier, rule in self.meetings["tiers"].items():      # how to cite: the group, never "the speaker" or "the author"
            self.assertNotRegex(rule, r"give the speaker|give the author|display name", tier)
        self.assertIn("attribute it to the working group", self.meetings["tiers"]["TR"])
        self.assertTrue(all(i["who"] == [] for i in self.meetings["items"]))
        self.assertTrue(all(m["speakers"] == [] and m["attendees"] == [] for m in self.meetings["meetings"]))
        self.assertTrue(all("pis" not in a and "team" not in a for a in self.devices["awards"]))
        self.assertTrue(all(d["presenter"] == "" for d in self.devices["devices"]))
        self.assertTrue(all(e["speaker"] == "" for e in self.devices["evidence"] + self.devices["discussion"]))

    def test_what_stays_is_a_count_and_never_who(self):
        meeting = {m["id"]: m for m in self.meetings["meetings"]}
        self.assertEqual(meeting[M1]["participants"], 3)                       # three people spoke; nobody is listed
        item = {i["id"]: i for i in self.meetings["items"]}
        self.assertTrue(item[M1 + ":agreements-01"]["attributed"])             # the notes attribute it to someone
        self.assertFalse(item[M1 + ":disagreements-01"]["attributed"])
        camera = next(d for d in self.devices["devices"] if d["name"] == "Depth camera (Acme Optics)")
        self.assertTrue(camera["spoken_to"])                                   # someone spoke to it at the workshop
        self.assertFalse(next(d for d in self.devices["devices"] if d["name"] == "Behavioral coding")["spoken_to"])

    def test_a_name_inside_a_text_is_replaced_and_the_rest_of_the_text_is_kept(self):
        item = {i["id"]: i for i in self.meetings["items"]}
        self.assertEqual(item[M1 + ":decisions-01"]["text"], "Adopt the template for the next data blitz ([name])")
        self.assertEqual(item[M1 + ":actions-01"]["text"], "[name]: draft the template guide")
        self.assertEqual(item[M1 + ":actions-02"]["text"], "[name] to collect example files")     # "example" the word stays
        self.assertEqual(item[M1 + ":disagreements-01"]["text"],
                         "Whether depth camera calibration files are required: [name] for, [name] against")
        notes = {m["id"]: m["notes"] for m in self.meetings["meetings"]}
        self.assertIn("[name]: heart rate sensors drift", notes[M3]["text"])
        self.assertGreater(self.meetings["names_removed"], 10)
        # what is not a person keeps its name: a group, a maker, a device, an institution
        self.assertEqual({m["group"] for m in self.meetings["meetings"]},
                         {"Standards WG", "Sample Devices WG", "Example Steering Committee", "Example Paper Group"})
        self.assertIn("Depth camera (Acme Optics)", [d["name"] for d in self.devices["devices"]])
        self.assertIn("Sample Devices Ltd., Springfield", json.dumps(self.devices["devices"]))

    def test_a_turn_is_marked_where_the_speaker_changes_and_not_who_speaks(self):
        cues = [e for e in self.meetings["evidence"] if e["kind"] == "utterance" and e["meeting"] == M1]
        self.assertEqual([c["new_turn"] for c in cues], [True, True, True])    # three cues, three different speakers in turn
        self.assertNotIn("new_turn", next(e for e in self.meetings["evidence"] if e["kind"] == "document_comment"))

    def test_the_questions_count_and_do_not_name(self):
        q = {x["id"]: x for x in self.meetings["questions"]}
        self.assertEqual(q["M1"]["columns"], ["Date", "Group", "Decision", "Attributed in the notes", "Notes"])
        self.assertEqual([r[3] for r in q["M1"]["rows"]], ["yes", "no", "no"])
        self.assertEqual(q["M5"]["columns"], ["Group", "Meetings with a speaker tie", "People who spoke", "Of them, known from a transcript"])
        self.assertIn(["Standards WG", 2, 3, 2], q["M5"]["rows"])
        self.assertEqual(q["M6"]["rows"], [["evidence records", 1, 1], ["item attributions", 1, 1]])
        self.assertEqual(q["M8"]["columns"], ["Date", "Group", "Action", "Owner named in the notes"])
        self.assertEqual([r[3] for r in q["M8"]["rows"]], ["no", "no", "no"])

    def test_a_record_with_a_full_name_left_in_it_is_refused(self):
        leaked = {"kind": "x", "evidence": [{"text": "as Ada Example said"}]}
        self.assertEqual(self.records.names.leaks(leaked), 1)
        self.assertEqual(self.records.names.leaks({"devices": [{"name": "Depth camera (Acme Optics)"}]}), 0)
        self.assertEqual(self.records.names.leaks(self.meetings) + self.records.names.leaks(self.devices), 0)


class TheRecordsStayOutOfTheRepository(unittest.TestCase):
    """The package names people and what they said. Nothing built from it is written here or on CI."""

    def run_main(self, *argv, env=None):
        said = io.StringIO()
        with mock.patch.dict(os.environ, env or {}, clear=False), contextlib.redirect_stderr(said), contextlib.redirect_stdout(said):
            for name in ("GITHUB_ACTIONS", "CI"):
                if not (env or {}).get(name):
                    os.environ.pop(name, None)
            try:
                code = ip.main([str(a) for a in argv])
            except SystemExit as stop:
                code = stop.code
        return code, said.getvalue()

    def test_it_writes_both_records_to_a_folder_outside_the_repository(self):
        with tempfile.TemporaryDirectory() as out:
            code, said = self.run_main(package_folder(), "--out-dir", out)
            self.assertEqual(code, 0, said)
            self.assertEqual(sorted(p.name for p in Path(out).iterdir()), ["devices.json", "meetings.json"])
            self.assertIn("7 meetings, 19 items, 20 evidence records, 13 sources; 4 device lines across 3 awards", said)
            self.assertEqual(json.loads((Path(out) / "meetings.json").read_text(encoding="utf-8"))["kind"], "bbqs-meetings")

    def test_an_output_folder_or_a_package_inside_the_repository_is_refused(self):
        inside = HERE / "export" / "should-never-exist"
        self.addCleanup(shutil.rmtree, inside, ignore_errors=True)     # if the refusal is ever broken, leave nothing behind
        code, said = self.run_main(package_folder(), "--out-dir", inside)
        self.assertEqual(code, 2)
        self.assertIn("is inside the repository", said)
        self.assertFalse(inside.exists())
        code, said = self.run_main(HERE / "fixtures", "--out-dir", tempfile.gettempdir())
        self.assertEqual(code, 2)
        self.assertIn("is inside the repository", said)

    def test_it_does_not_run_on_ci(self):
        with tempfile.TemporaryDirectory() as out:
            for env in ({"GITHUB_ACTIONS": "true"}, {"CI": "1"}):
                code, said = self.run_main(package_folder(), "--out-dir", out, env=env)
                self.assertEqual(code, 2, env)
                self.assertIn("this runs on CI", said)
            self.assertEqual(list(Path(out).iterdir()), [])

    def test_the_builder_writes_nothing_when_a_full_name_is_left(self):
        # A field the scrubber does not read (a `group`, say) that carries somebody's full name.
        real = ip.Records.meetings

        def leaky(self):
            doc = real(self)
            doc["meetings"][0]["group"] = "Ada Example's group"
            return doc

        with tempfile.TemporaryDirectory() as out, mock.patch.object(ip.Records, "meetings", leaky):
            code, said = self.run_main(package_folder(), "--out-dir", out)
            self.assertEqual(code, 1)
            self.assertIn("full name(s) of people are still in the records, so nothing was written", said)
            self.assertNotIn("Ada Example", said)                # it says how many, never who
            self.assertEqual(list(Path(out).iterdir()), [])

    def test_a_folder_that_is_not_the_package_is_refused(self):
        with tempfile.TemporaryDirectory() as empty, tempfile.TemporaryDirectory() as out:
            code, said = self.run_main(empty, "--out-dir", out)
            self.assertEqual(code, 2)
            self.assertIn("is not the meetings data package", said)

    def test_no_file_of_the_repository_holds_a_record_built_from_a_package(self):
        # What the builder writes is marked from_package; a committed file with that mark would be the
        # real package's records or a copy of them. (This file and the builder name the key, not a record.)
        marks = re.compile(r'"from_package"\s*:\s*true')
        holders = []
        for path in HERE.parent.rglob("*"):
            if not path.is_file() or path.suffix not in (".json", ".html", ".ttl", ".jsonl", ".js", ".md") \
                    or any(part in (".git", "node_modules", "dist", ".claude") for part in path.parts):
                continue
            try:
                if marks.search(path.read_text(encoding="utf-8", errors="ignore")):
                    holders.append(str(path.relative_to(HERE.parent)))
            except OSError:
                continue
        self.assertEqual(holders, [])


class TheGraphsNamesAreReplacedToo(unittest.TestCase):
    """kg/quality.py scrubs the records once more, with the names the public graph holds."""

    def test_the_names_of_the_graphs_investigators_are_replaced_too(self):
        # kg/quality.py's pass, with the public graph's Investigator names: a person the package never
        # lists as a speaker can still be named in a text.
        from quality import KGQuality
        with tempfile.TemporaryDirectory() as folder:
            graph = Path(folder) / "public.ttl"
            graph.write_text(synthetic.PUBLIC_TTL, encoding="utf-8")
            doc = ip.Records(package_folder()).meetings()
            doc["items"][0]["text"] = "Ask Ben Q. Sample and Quinn Graphonly about the rig; Quinn agreed"
            before = doc["names_removed"]
            doc = KGQuality(graph).anonymize(doc)
        self.assertEqual(doc["items"][0]["text"], "Ask [name] and [name] about the rig; [name] agreed")
        self.assertGreater(doc["names_removed"], before)
        self.assertEqual(doc["people"], [])

    def test_a_record_that_names_people_is_not_put_on_a_page(self):
        # The older builders (kg/meetings.py, kg/devices.py) name people, and so would a record whose
        # mark was edited away: kg/quality.py --internal refuses anything not marked anonymous.
        from click.testing import CliRunner
        import quality
        with tempfile.TemporaryDirectory() as folder:
            graph, named, page = Path(folder) / "public.ttl", Path(folder) / "meetings.json", Path(folder) / "page.html"
            graph.write_text(synthetic.PUBLIC_TTL, encoding="utf-8")
            doc = ip.Records(package_folder()).meetings()
            doc["items"][0]["text"] = "Quinn Graphonly asked about the rig"      # named in the graph only
            for marked, refused in ((False, True), (None, True), (True, False)):
                record = dict(doc)
                if marked is None:
                    record.pop("anonymous")
                else:
                    record["anonymous"] = marked
                named.write_text(json.dumps(record), encoding="utf-8")
                with mock.patch.dict(os.environ, {}, clear=False):
                    for name in ("GITHUB_ACTIONS", "CI"):
                        os.environ.pop(name, None)
                    result = CliRunner().invoke(quality.main, [str(graph), "--json", str(Path(folder) / "q.json"), "--html",
                                                               str(Path(folder) / "public.html"), "--fragment", str(page),
                                                               "--internal", str(named)])
                self.assertEqual(result.exit_code != 0, refused, (marked, result.output[-300:]))
                if refused:
                    self.assertIn("names people", result.output)
                    self.assertFalse(page.exists())
            self.assertTrue(page.exists())
            records = page.read_text(encoding="utf-8").split("const INTERNAL = ")[1].split(";\nconst BUNDLE")[0]
            self.assertNotIn("Ada Example", records)
            self.assertNotIn("Quinn", records)                   # the page's records went through the graph's names too
            self.assertIn("[name] asked about the rig", records)
if __name__ == "__main__":
    unittest.main(verbosity=1)
