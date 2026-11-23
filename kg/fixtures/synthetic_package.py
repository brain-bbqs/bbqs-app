#!/usr/bin/env python3
"""A SYNTHETIC meetings data package, written to a folder on request, and the public graph it links to.

Everything here is invented: the people (Ada Example, Ben Sample, Cy Placeholder, Dee, Eve Roster, a
shared account called Shared Desk), the awards (R34DA000001, R61MH000002, U01DA000003), the text and
the ids. Nothing is copied from the real package, which is internal and never committed. The folder
has the real package's layout (kg/nodes.jsonl, kg/evidence.jsonl, kg/edges.jsonl, kg/sources.csv,
kg/person_aliases.csv, kg/tiers.json, kg/stats.json, derived/meetings/meeting_notes_segments.jsonl),
so the readers are tested on the shapes they meet, and each record below is a planted case:

  people      Ada Example is an investigator of the same name; Ben Sample is "Ben Q. Sample" in the
              public graph (first and last name only: a match to verify); Cy Placeholder and Dee have
              no node; Shared Desk is a shared account (its Person node says so) and is never a person
  aliases     "Ada" is recorded as a first name in the notes; "Ben" is a VERIFY row; "A. Example" a
              display name
  groups      "Standards WG" is WG-Standards; "Sample Devices WG" names WG-Devices among other words
              (a match to verify); "Example Steering Committee" and "Example Paper Group" have no node
  meetings    one with notes, a transcript and a chat; one whose cited notes block is a stub, with the
              real block uncited (same group and date); one with no block, written inside another
              meeting's block under a dated heading; one with no block at all; one with a transcript
              and no items; and a notes block no meeting has
  items       every kind, a quoted fragment that is in the notes block and one that is not, an item
              attributed through the VERIFY alias, an action with an owner
  evidence    every kind and tier: transcript cues (TR), a chat line, a comment by the shared account
              and a thread excerpt (T1), slide rows (T1), workshop attributions, a statement and an
              award status (T2), a note line (T3), a model guess (U)
  devices     a sensor with a stated maker, a guessed model and a presenter on the roster; a method;
              a sensor the catalogue has by name, with a placeholder in the candidate column and a
              presenter who is on no roster; a sensor known only from the summary and a guess
  computed    tier-A edges (co-speaking, term counts) and Term nodes, which no reader may carry over

    python kg/fixtures/synthetic_package.py /tmp/somewhere     # writes the folder, to look at it
"""
from __future__ import annotations

import csv
import io
import json
import sys
from collections import Counter
from pathlib import Path

DOCS = "https://docs.example.org/"

# ---- the public graph the package's records link to (a public export in miniature) -----------------
PUBLIC_TTL = """
@prefix bbqs: <https://brain-bbqs.org/schema#> .
@prefix bid: <https://brain-bbqs.org/id/> .
@prefix prop: <https://brain-bbqs.org/id/property/> .

bid:proj-mouse a bbqs:Project ; bbqs:name "R34DA000001" ; bbqs:grant_number "R34DA000001" ;
    bbqs:title "Synthetic mouse project" ; bbqs:studies_species bid:sp-mouse ;
    bbqs:uses_device_category bid:cat-mocap , bid:cat-wearable .
bid:proj-fish a bbqs:Project ; bbqs:name "R61MH000002" ; bbqs:grant_number "1R61MH000002-01" ;
    bbqs:title "Synthetic zebrafish project" ; bbqs:studies_species bid:sp-fish ;
    bbqs:uses_device_category bid:cat-mocap .
bid:proj-wearable a bbqs:Project ; bbqs:name "U01DA000003" ; bbqs:grant_number "U01DA000003" ;
    bbqs:title "Synthetic wearables project" ; bbqs:uses_device_category bid:cat-wearable .

bid:inv-ada a bbqs:Investigator ; bbqs:name "Ada Example" ; bbqs:member_of_group bid:wg-standards .
bid:inv-ben a bbqs:Investigator ; bbqs:name "Ben Q. Sample" .
bid:inv-eve a bbqs:Investigator ; bbqs:name "Eve Roster" .
bid:inv-quinn a bbqs:Investigator ; bbqs:name "Quinn Graphonly" .
bid:role-ada a bbqs:ProjectRole ; bbqs:on_project bid:proj-mouse ; bbqs:held_by bid:inv-ada ;
    bbqs:project_role "contact_pi" ; bbqs:role_source "reporter" .
bid:role-eve a bbqs:ProjectRole ; bbqs:on_project bid:proj-fish ; bbqs:held_by bid:inv-eve ;
    bbqs:project_role "contact_pi" ; bbqs:role_source "reporter" .

bid:wg-standards a bbqs:WorkingGroup ; bbqs:name "WG-Standards" .
bid:wg-devices a bbqs:WorkingGroup ; bbqs:name "WG-Devices" .
bid:org-example a bbqs:ResearchOrganization ; bbqs:name "EXAMPLE UNIVERSITY" .

bid:sp-mouse a bbqs:Species ; bbqs:name "Mus musculus" ; bbqs:common_name "House Mouse" ; bbqs:aliases "Mouse" .
bid:sp-fish a bbqs:Species ; bbqs:name "Danio rerio" ; bbqs:common_name "Zebrafish" .

bid:man-acme a bbqs:DeviceManufacturer ; bbqs:name "Acme Optics" .
bid:man-pulse a bbqs:DeviceManufacturer ; bbqs:name "Pulse Works" .
bid:cat-mocap a bbqs:DeviceCategory ; bbqs:name "Motion capture" ; bbqs:label "Motion capture" ;
    bbqs:category_key "motion_capture" ; bbqs:observes prop:bodyposture , prop:gaitkinematics .
bid:cat-wearable a bbqs:DeviceCategory ; bbqs:name "Wearable biosensor" ; bbqs:label "Wearable biosensor" ;
    bbqs:category_key "wearable_biosensor" ; bbqs:observes prop:heartrate .
bid:cat-thermal a bbqs:DeviceCategory ; bbqs:name "Thermal camera" ; bbqs:label "Thermal camera" ;
    bbqs:category_key "thermal_camera" ; bbqs:observes prop:skintemperature .
bid:dev-depthcam a bbqs:Device ; bbqs:name "DepthCam 3000" ; bbqs:model_name "DepthCam 3000" ;
    bbqs:manufacturer bid:man-acme ; bbqs:device_category bid:cat-mocap ; bbqs:observes prop:bodyposture .
bid:dev-pulseband a bbqs:Device ; bbqs:name "PulseBand" ; bbqs:model_name "PulseBand 2" ;
    bbqs:manufacturer bid:man-pulse ; bbqs:device_category bid:cat-wearable ; bbqs:observes prop:heartrate .
prop:bodyposture a bbqs:ObservableProperty ; bbqs:label "Body posture" .
prop:gaitkinematics a bbqs:ObservableProperty ; bbqs:label "Gait kinematics" .
prop:heartrate a bbqs:ObservableProperty ; bbqs:label "Heart rate" ; bbqs:aliases "heart rate" .
prop:skintemperature a bbqs:ObservableProperty ; bbqs:label "Skin temperature" .

bid:sw-posetool a bbqs:SoftwareTool ; bbqs:name "PoseTool" .
"""

TIERS = {
    "TR": "Synthetic: a recording transcript, verbatim as captioned; the speaker is a display name.",
    "T1": "Synthetic: a primary written record by participants (slide, comment, chat line). Verbatim.",
    "T3": "Synthetic: meeting notes, verbatim. The note-taker's wording.",
    "T2": "Synthetic: a synthesis document written from transcripts that are not here.",
    "X": "Synthetic: an AI paraphrase of the notes. Check it against the notes block before citing.",
    "A": "Synthetic: a computed analysis. An interpretation, not a statement anyone made.",
    "U": "Synthetic: an unverified guess. Never promote it to fact without confirmation.",
}

SOURCES = [   # source_id, title, kind, default_tier
    ("src:notes-standards-example", "Example Standards WG notes", "meeting notes (Google Doc)", "T3"),
    ("src:notes-steering-example", "Example Steering Committee notes", "meeting notes (Google Doc)", "T3"),
    ("src:notes-devices-example", "Example Devices WG notes", "meeting notes (Google Doc)", "T3"),
    ("src:tr-2026-01-15-example", "Example recording transcript, 15 Jan 2026", "recording transcript (Zoom .vtt)", "TR"),
    ("src:tr-2026-01-20-example", "Example recording transcript, 20 Jan 2026", "recording transcript (Zoom .vtt)", "TR"),
    ("src:chat-2026-01-15-example", "Example meeting chat, 15 Jan 2026", "meeting chat log (Zoom)", "T1"),
    ("src:deck-example", "Example Data Blitz slides", "team slides (Google Slides)", "T1"),
    ("src:ws-summary-example", "Example Workshop Summary", "workshop synthesis", "T2"),
    ("src:inv-summary-example", "Example Inventory Summary", "workshop synthesis", "T2"),
    ("src:ws-device-list-example", "Example workshop device list", "AI-assembled table", "U"),
    ("src:comments-example", "Example policy comments", "document comments", "T1"),
    ("src:threads-example", "Example policy comment threads", "document comment threads", "T1"),
    ("src:agenda-example", "Example workshop agenda", "agenda", "T3"),          # cited by no record
]

GROUPS = [("wg:standards-wg", "Standards WG"), ("wg:sample-devices-wg", "Sample Devices WG"),
          ("wg:example-steering-committee", "Example Steering Committee"), ("wg:example-paper-group", "Example Paper Group")]

AWARDS = [
    {"id": "award:R34DA000001", "name": "R34DA000001", "title": "Synthetic mouse project", "mechanism": "R34",
     "pis_as_written": "Example, Roster", "species": "Mouse", "status_at_blitz": "Collecting pilot data.",
     "team_as_written": "Example, Roster (Example University)"},
    {"id": "award:R61MH000002", "name": "R61MH000002", "title": "Synthetic zebrafish project", "mechanism": "R61",
     "pis_as_written": "Roster", "species": "Zebrafish, Mouse", "status_at_blitz": "Rig being built.",
     "team_as_written": "Roster (Sample Inst.)"},
    {"id": "award:U01DA000003", "name": "U01DA000003", "title": "", "mechanism": "U01",
     "pis_as_written": "", "species": "", "status_at_blitz": "", "team_as_written": ""},
]

ORGANIZATIONS = [("org:example-university", "Example University", "research institution"),
                 ("org:sample-inst", "Sample Inst.", "research institution"),
                 ("org:example-funder", "Example Funder", "funder"),
                 ("org:example-consortium", "Example Consortium", "consortium")]

PEOPLE = [   # id, name, aliases, in_meeting_roster, note
    ("person:ada-example", "Ada Example", ["Ada", "A. Example"], True, ""),
    ("person:ben-sample", "Ben Sample", ["Ben"], True, ""),
    ("person:cy-placeholder", "Cy Placeholder", [], True, ""),
    ("person:eve-roster", "Eve Roster", [], True, ""),
    ("person:dee", "Dee", [], False, ""),
    ("person:shared-desk", "Shared Desk", [], False, "shared account, not an individual"),
]

ALIASES = [   # name_as_written, canonical_name, person_id, method, first_seen_source
    ("Ada", "Ada Example", "person:ada-example", "first name in notes", "src:notes-standards-example"),
    ("A. Example", "Ada Example", "person:ada-example", "Zoom display name", "src:tr-2026-01-15-example"),
    ("Ben", "Ben Sample", "person:ben-sample", "first name unique in meeting roster (auto). VERIFY",
     "src:notes-standards-example"),
]

STANDARDS, STEERING, DEVICES_WG, PAPER = (name for _id, name in GROUPS)
M1, M2, M3 = "mtg:standards-wg-2026-01-15", "mtg:standards-wg-2026-02-10", "mtg:standards-wg-2025-12-01"
M4, M5, M6 = "mtg:example-steering-committee-2026-03-03", "mtg:sample-devices-wg-2026-04-01", "mtg:sample-devices-wg-2026-05-05"
M7 = "mtg:example-paper-group-2026-01-20"

MEETINGS = [   # id, group, date, title, notes_segment (None: the key is absent), source, locator, extra
    (M1, STANDARDS, "2026-01-15", "Template review", "seg:standards-example-2026-01-15", "src:notes-standards-example",
     "lines 2-9", {"transcript_source_id": "src:tr-2026-01-15-example", "transcript_note": "synthetic transcript",
                   "chat_source_id": "src:chat-2026-01-15-example"}),
    (M2, STANDARDS, "2026-02-10", "Calibration follow-up", "seg:standards-example-2026-02-10", "src:notes-standards-example",
     "lines 11-12", {}),
    (M3, STANDARDS, "2025-12-01", "Lunch discussion", "", "src:notes-standards-example", "",
     {"source_note": "Written inside the next meeting's notes."}),
    (M4, STEERING, "2026-03-03", "Budget", "seg:steering-example-2026-03-03", "src:notes-steering-example", "lines 2-5", {}),
    (M5, DEVICES_WG, "2026-04-01", "Depth camera demo", "seg:devices-example-2026-04-01", "src:notes-devices-example",
     "lines 2-4", {}),
    (M6, DEVICES_WG, "2026-05-05", "Planning", "", "src:notes-devices-example", "", {}),
    (M7, PAPER, "2026-01-20", "Paper planning", None, "src:tr-2026-01-20-example", "",
     {"transcript_source_id": "src:tr-2026-01-20-example", "transcript_note": "synthetic transcript"}),
]

SEGMENTS = [   # segment_id, notes_file, group, date, header, attendees, source, line_start, line_end, text
    ("seg:standards-example-2026-01-15", "StandardsExample", STANDARDS, "2026-01-15",
     "Standards WG meeting: January 15 2026", "Ada, Ben, Cy", "src:notes-standards-example", 2, 9,
     "Standards WG meeting: January 15 2026\n"
     "Attendees: Ada, Ben, Cy\n"
     "Ada: sites keep asking for one template.\n"
     "Ben will draft the template guide.\n"
     "The depth camera calibration files came up; Cy is against requiring them.\n"
     "Heart rate data from the wearables needs a shared clock.\n"
     "Standards WG lunch: December 1, 2025\n"
     "Dee: heart rate sensors drift without a shared clock."),
    ("seg:standards-example-2026-02-10", "StandardsExample", STANDARDS, "2026-02-10",
     "Agenda for 2026/02/10", "", "src:notes-standards-example", 11, 12, "Agenda for 2026/02/10"),
    ("seg:standards-example-2026-02-10-2", "StandardsExample", STANDARDS, "2026-02-10",
     "Agenda for 2026/02/10", "Ada, Ben", "src:notes-standards-example", 11, 12,
     "Agenda for 2026/02/10\nCalibration files are required from now on.\nTooling is late for two sites.\n"
     "_Assigned to ada.example_"),
    # contact and access data, which no reader carries: a join link with a passcode, an address
    ("seg:steering-example-2026-03-03", "SteeringExample", STEERING, "2026-03-03",
     "Steering committee: 3 March 2026", "Ada, Eve", "src:notes-steering-example", 2, 5,
     "Steering committee: 3 March 2026\nBudget overview.\nDecision: fund a second hackathon.\n"
     "Shared Desk sends the minutes: https://meet.example.org/j/123?pwd=abc (shared.desk@example.org)."),
    ("seg:devices-example-2026-04-01", "DevicesExample", DEVICES_WG, "2026-04-01",
     "Devices WG: 2026-04-01", "Cy", "src:notes-devices-example", 2, 4,
     "Devices WG: 2026-04-01\nCy showed the depth camera rig.\nSkin temperature was not discussed."),
    ("seg:steering-example-2026-07-07", "SteeringExample", STEERING, "2026-07-07",
     "Steering committee: summer break", "", "src:notes-steering-example", 7, 8,
     "Steering committee: summer break\nNo meeting."),
]

# meeting -> field -> [(text, attributed_to_as_written)], in the notes' order
ITEMS = {
    M1: {"agenda": [("Review the metadata template", ""), ("Clock sync across devices", "")],
         "lessons": [("Teams want 'one template' for all sites (Ada)", "Ada")],
         "agreements": [("Use the shared template for pilot data (Ada, Ben)", "Ada, Ben")],
         "disagreements": [("Whether depth camera calibration files are required: Ada for, Cy against", "")],
         "decisions": [("Adopt the template for the next data blitz (Ada)", "Ada")],
         "actions": [("Ben: draft the template guide", ""), ("Cy to collect example files", "")]},
    M2: {"agenda": [("Follow-up on calibration", "")],
         "lessons": [("Two sites 'cannot wait' for tooling", "")],
         "decisions": [("Calibration files are required", "")]},
    M3: {"agenda": [("Lunch discussion on standards", "")],
         "lessons": [("Heart rate sensors drift without a shared clock (Dee)", "Dee")]},
    M4: {"agenda": [("Budget overview", "")],
         "decisions": [("Fund a second hackathon", "")],
         "actions": [("Shared Desk: send the minutes", "")]},
    M5: {"agenda": [("Depth camera demo", "")],
         "lessons": [("The rig needs two people to calibrate", "")]},
    M6: {"agenda": [("Planning", "")]},
}
LABEL = {"agenda": "AgendaItem", "lessons": "Lesson", "agreements": "Agreement", "disagreements": "Disagreement",
         "decisions": "Decision", "actions": "ActionItem"}
HAS = {"agenda": "HAS_AGENDA_ITEM", "lessons": "HAS_LESSON", "agreements": "HAS_AGREEMENT",
       "disagreements": "HAS_DISAGREEMENT", "decisions": "HAS_DECISION", "actions": "HAS_ACTION"}

SPOKE_IN_NOTES = [("person:ada-example", M1), ("person:ben-sample", M1), ("person:cy-placeholder", M1),
                  ("person:ada-example", M2), ("person:ben-sample", M2), ("person:ada-example", M4),
                  ("person:eve-roster", M4), ("person:cy-placeholder", M5)]
RAISED = [("person:ada-example", f"{M1}:lessons-01"), ("person:ada-example", f"{M1}:agreements-01"),
          ("person:ben-sample", f"{M1}:agreements-01"), ("person:ada-example", f"{M1}:decisions-01"),
          ("person:dee", f"{M3}:lessons-01")]

T15, T20 = "src:tr-2026-01-15-example", "src:tr-2026-01-20-example"
VTT15, VTT20 = "example_2026_01_15.vtt", "example_2026_01_20.vtt"
DEV1, DEV2, DEV3, DEV4 = ("device:DEV-R34DA000001-01", "device:DEV-R34DA000001-02", "device:DEV-R61MH000002-01",
                          "device:DEV-U01DA000003-01")
SLIDE = "(team slide; author not recorded)"
GUESS_NOTE = "Model/HQ not found on team slide or in transcript-derived text; confirm with the lab before use"


def _utt(n, file, source, meeting, date, speaker, written, text, start, end):
    return {"id": f"utt:{date}-{n:04d}", "kind": "utterance", "text": text, "tier": "TR", "speaker": speaker,
            "speaker_as_written": written, "date": date, "meeting": meeting, "source_id": source,
            "locator": f"{file} cue {n} {start}-{end}", "url": DOCS + source.split(":", 1)[1], "start": start, "end": end,
            "transcript_file": file, "checked": "auto-caption, not human-checked"}


def _ev(id_, kind, tier, text, source, locator, *, speaker="", written="", date="", meeting="", url=None, **more):
    return {"id": id_, "kind": kind, "text": text, "tier": tier, "speaker": speaker, "speaker_as_written": written,
            "date": date, "meeting": meeting, "source_id": source, "locator": locator,
            "url": DOCS + source.split(":", 1)[1] if url is None else url, **more}


EVIDENCE = [
    _utt(1, VTT15, T15, M1, "2026-01-15", "person:ada-example", "Ada Example", "Let us start with the template.",
         "00:00:02.000", "00:00:05.000"),
    _utt(2, VTT15, T15, M1, "2026-01-15", "person:ben-sample", "Ben",
         "The depth camera needs a calibration file per session.", "00:00:06.000", "00:00:11.500"),
    _utt(3, VTT15, T15, M1, "2026-01-15", "person:ada-example", "A. Example",
         "Heart rate is the easiest signal to share.", "00:00:12.000", "00:00:15.250"),
    _utt(1, VTT20, T20, M7, "2026-01-20", "person:cy-placeholder", "Cy Placeholder",
         "We could write this up as a short paper.", "00:00:01.000", "00:00:04.000"),
    _ev("chat:2026-01-15-001", "chat message", "T1", "Template draft is in the shared folder [link redacted]",
        "src:chat-2026-01-15-example", "line 1 (00:07:45)", speaker="person:ada-example", written="Ada Example",
        date="2026-01-15", meeting=M1),
    _ev("cmt:ex-0002", "document comment", "T1", "Please define 'derived data' here.", "src:comments-example", "row 2",
        speaker="person:shared-desk", written="Shared Desk", date="2026-02-01", url="", document="Example policy draft"),
    _ev("cmt:ex-0003", "document comment", "T1", "Agree with the 30-day window.", "src:comments-example", "row 3",
        speaker="person:eve-roster", written="Eve Roster", date="2026-02-02", url="", document="Example policy draft"),
    _ev("thr:0002", "comment thread (excerpt)", "T1", "Should release wait for the paper?", "src:threads-example", "row 2",
        speaker="person:eve-roster", written="Eve Roster", date="2026-02-03", url="", document="draft",
        participants_as_written="Eve Roster; Ada Example", features_analysis="release_timing"),
    _ev("devev:0001", "team slide row", "T1",
        "Motion | Depth camera (Acme Optics) | measures: Body posture, Heart rate | tools: PoseTool, custom | sharing: DANDI",
        "src:deck-example", "Example Data Blitz slides - R34, slide 1", written=SLIDE, date="2026-07 (deck)",
        award="R34DA000001", note=""),
    _ev("devev:0002", "team slide row", "T1",
        "Behavior | Behavioral coding | measures: Social interaction | tools: custom | sharing: —",
        "src:deck-example", "Example Data Blitz slides - R34, slide 1", written=SLIDE, date="2026-07 (deck)",
        award="R34DA000001", note=""),
    _ev("devev:0003", "team slide row", "T1",
        "Motion | DepthCam 3000 | measures: body posture, Gaze | tools:  | sharing: ",
        "src:deck-example", "Example Data Blitz slides - R61, slide 4", written=SLIDE, date="2026-07 (deck)",
        award="R61MH000002", note=""),
    _ev("devev:0004", "speaker attribution (workshop)", "T2",
        "\"Depth camera\" - spoke to it: Ada Example; measures: body posture", "src:ws-summary-example",
        "Example Workshop Summary.docx, Appendix A, line 12", speaker="person:ada-example", written="Ada Example",
        date="2026-07-15", award="R34DA000001", note=""),
    _ev("devev:0005", "manufacturer/model candidate", "U", "Manufacturer (HQ): Acme Optics, Springfield | Model: Depth 3000",
        "src:ws-device-list-example", "Example workshop device list, row \"Depth camera\"",
        written="(AI-assembled list; no speaker)", award="R34DA000001", note=GUESS_NOTE),
    _ev("devev:0006", "speaker attribution (workshop)", "T2",
        "\"DepthCam 3000\" - spoke to it: Ben Sample (with a student); measures: gaze", "src:ws-summary-example",
        "Example Workshop Summary.docx, Appendix A, line 20", speaker="person:ben-sample",
        written="Ben Sample (with a student)", date="2026-07-15", award="R61MH000002", note=""),
    _ev("devev:0007", "speaker attribution (workshop)", "T2",
        "\"Wearable heart monitor\" - spoke to it: Cy Placeholder; measures: heart rate", "src:ws-summary-example",
        "Example Workshop Summary.docx, Appendix A, line 31", speaker="person:cy-placeholder", written="Cy Placeholder",
        date="2026-07-15", award="U01DA000003", note=""),
    _ev("devev:0008", "manufacturer/model candidate", "U",
        "Manufacturer (HQ): Sample Devices Ltd., Springfield | Model: HM-1 (VERIFY)", "src:ws-device-list-example",
        "Example workshop device list, row \"Wearable heart monitor\"", written="(AI-assembled list; no speaker)",
        award="U01DA000003", note=GUESS_NOTE),
    _ev("devev:0009", "workshop statement", "T2", "Eve Roster described sharing the full recording suite.",
        "src:ws-summary-example", "Example Workshop Summary.docx, line 43", speaker="person:eve-roster",
        written="Eve Roster", date="2026-07", award="R61MH000002", note="Quoted from summary; verify against transcript"),
    _ev("devev:0010", "award status at Blitz", "T2", "Pilot data collected.", "src:inv-summary-example",
        "Example-Inventory-Summary.docx, award status table", written="(summary author)", date="2026-07-15",
        award="U01DA000003", note=""),
    _ev("devx:xev-001", "device discussion", "T2", "\"every sensor drifts when the clock is cheap\"",
        "src:ws-summary-example", "Example Workshop Summary.docx, line 164",
        written="Example lead (rendered \"Dee\"; likely Dee Placeholder - verify)", date="2026-07-17", topic="Clock sync"),
    _ev("devx:xev-002", "device discussion", "T3", "Heart rate data from the wearables needs a shared clock.",
        "src:notes-standards-example", "Example Standards WG notes, line 7", written="(Standards notes)",
        date="2026-01-15", topic="Clock sync"),
]

DEVICES = [
    {"id": DEV1, "name": "Depth camera (Acme Optics)", "kind": "device/sensor", "category": "Motion",
     "measures": "Body posture, Heart rate", "tools": "PoseTool, custom", "sharing": "DANDI",
     "manufacturer_stated": "Acme Optics", "manufacturer_candidate_unverified": "",
     "model_candidate_unverified": "Depth 3000", "on_team_slide": "yes", "evidence_tiers": "T1+T2+U"},
    {"id": DEV2, "name": "Behavioral coding", "kind": "method/procedure", "category": "Behavior",
     "measures": "Social interaction", "tools": "custom", "sharing": "—", "manufacturer_stated": "",
     "manufacturer_candidate_unverified": "", "model_candidate_unverified": "", "on_team_slide": "yes",
     "evidence_tiers": "T1"},
    {"id": DEV3, "name": "DepthCam 3000", "kind": "device/sensor", "category": "Motion",
     "measures": "body posture, Gaze", "tools": "", "sharing": "", "manufacturer_stated": "",
     "manufacturer_candidate_unverified": "Not specified in record", "model_candidate_unverified": "",
     "on_team_slide": "yes", "evidence_tiers": "T1+T2"},
    {"id": DEV4, "name": "Wearable heart monitor", "kind": "device/sensor", "category": "Wearable",
     "measures": "Heart rate", "tools": "custom", "sharing": "", "manufacturer_stated": "",
     "manufacturer_candidate_unverified": "Sample Devices Ltd., Springfield", "model_candidate_unverified": "HM-1 (VERIFY)",
     "on_team_slide": "no (no slide row found)", "evidence_tiers": "T2+U"},
]
USES = [("award:R34DA000001", DEV1, "T1"), ("award:R34DA000001", DEV2, "T1"), ("award:R61MH000002", DEV3, "T1"),
        ("award:U01DA000003", DEV4, "T2")]
SUPPORTED_BY = [(DEV1, "devev:0001"), (DEV1, "devev:0004"), (DEV1, "devev:0005"), (DEV2, "devev:0002"),
                (DEV3, "devev:0003"), (DEV3, "devev:0006"), (DEV4, "devev:0007"), (DEV4, "devev:0008")]
# who the summary names as presenting: the record's own speaker, and a co-presenter no field holds
PRESENTED = [("person:ada-example", "devev:0004"), ("person:eve-roster", "devev:0004"),
             ("person:ben-sample", "devev:0006"), ("person:cy-placeholder", "devev:0007")]
TOPICS = [("topic:clock-sync", "Clock sync")]
TERMS = [("term:template", "template"), ("term:clock", "clock")]


def _edge(source, target, type_, tier, source_id="", locator="", **more):
    return {"source": source, "target": target, "type": type_, "tier": tier, "source_id": source_id,
            "locator": locator, **more}


def records() -> dict:
    """The package's files as Python records: nodes, evidence, edges, sources, aliases, segments, tiers, stats."""
    nodes = [{"id": id_, "label": "WorkingGroup", "name": name} for id_, name in GROUPS]
    nodes += [{**award, "label": "Award"} for award in AWARDS]
    edges = [_edge(id_, "org:example-consortium", "PART_OF", "A", note="grouping used in this package") for id_, _n in GROUPS]
    for award in AWARDS:
        edges.append(_edge("org:example-funder", award["id"], "FUNDS", "T2", "src:inv-summary-example", "award status table"))
        edges.append(_edge(award["id"], "org:example-consortium", "MEMBER_OF", "T2", "src:inv-summary-example", "award status table"))
    edges.append(_edge("award:R34DA000001", "org:example-university", "AT_INSTITUTION", "T2", "src:inv-summary-example",
                       "award status table"))
    edges.append(_edge("award:R61MH000002", "org:sample-inst", "AT_INSTITUTION", "T2", "src:inv-summary-example",
                       "award status table"))
    edges.append(_edge("person:cy-placeholder", "org:sample-inst", "AFFILIATED_WITH", "TR", T20, "speaker display name"))
    group_id = {name: id_ for id_, name in GROUPS}
    for mid, group, date, title, segment, source, locator, extra in MEETINGS:
        node = {"id": mid, "label": "Meeting", "name": f"{group} - {date}", "group": group, "date": date, "title": title,
                "source_id": source, "locator": locator, "url": DOCS + source.split(":", 1)[1], "source_note": ""}
        if segment is not None:
            node["notes_segment"] = segment
        node.update(extra)
        nodes.append(node)
        edges.append(_edge(mid, group_id[group], "OF_GROUP", "TR" if segment is None else "T3", source))
        for field, entries in ITEMS.get(mid, {}).items():
            for n, (text, attributed) in enumerate(entries, 1):
                item = f"{mid}:{field}-{n:02d}"
                nodes.append({"id": item, "label": LABEL[field], "text": text, "meeting": mid, "date": date,
                              "group": group, "tier": "X", "source_id": source, "locator": locator,
                              "url": DOCS + source.split(":", 1)[1], "attributed_to_as_written": attributed})
                edges.append(_edge(mid, item, HAS[field], "X", source, locator))
    meeting_source = {m[0]: m[5] for m in MEETINGS}
    for person, mid in SPOKE_IN_NOTES:
        edges.append(_edge(person, mid, "SPOKE_IN", "X", meeting_source[mid],
                           node_note="speaker attributed in notes; extracted by AI"))
    for person, item in RAISED:
        edges.append(_edge(person, item, "RAISED", "X", meeting_source[item.rsplit(":", 1)[0]],
                           note="person raised/owned this item (per notes, AI-extracted)"))
    nodes += [{**device, "label": "Device"} for device in DEVICES]
    nodes += [{"id": id_, "label": "Topic", "name": name} for id_, name in TOPICS]
    nodes += [{"id": id_, "label": "Term", "name": name} for id_, name in TERMS]
    sources = [{"source_id": id_, "title": title, "kind": kind, "default_tier": tier,
                "local_path": "sources/" + id_.split(":", 1)[1] + ".txt", "drive_id": "synthetic-" + id_.split(":", 1)[1],
                "url": DOCS + id_.split(":", 1)[1], "note": "synthetic"} for id_, title, kind, tier in SOURCES]
    nodes += [{"id": s["source_id"], "label": "Source", "name": s["title"], "kind": s["kind"],
               "default_tier": s["default_tier"], "url": s["url"], "drive_id": s["drive_id"],
               "local_path": s["local_path"], "note": s["note"]} for s in sources]
    nodes.append({"id": "derived:example-network", "label": "Source", "name": "Example speaker network",
                  "kind": "computed analysis", "default_tier": "A", "url": "", "drive_id": "", "local_path": "", "note": ""})
    for id_, name, aliases, roster, note in PEOPLE:
        node = {"id": id_, "label": "Person", "name": name, "aliases": aliases, "in_meeting_roster": roster}
        if roster:
            node.update({"wg_role": "Core voice", "wg_meetings_spoken": 2, "wg_betweenness": 0.5, "wg_community": 1})
        if note:
            node["note"] = note
        nodes.append(node)
    nodes += [{"id": id_, "label": "Organization", "name": name, "kind": kind, "note": ""} for id_, name, kind in ORGANIZATIONS]

    by_id = {e["id"]: e for e in EVIDENCE}
    spoke = Counter()
    for e in EVIDENCE:
        if e["kind"] == "utterance":
            edges.append(_edge(e["speaker"], e["id"], "SAID", "TR", e["source_id"], "cue " + e["locator"].split(" cue ")[1].split()[0]))
            edges.append(_edge(e["id"], e["meeting"], "IN_MEETING", "TR", e["source_id"]))
            spoke[(e["speaker"], e["meeting"], e["source_id"])] += 1
        elif e["kind"] == "chat message":
            edges.append(_edge(e["speaker"], e["id"], "SAID", "T1", e["source_id"], e["locator"].split(" (")[0]))
        elif e["kind"] == "document comment":
            edges.append(_edge(e["speaker"], e["id"], "WROTE", "T1", e["source_id"], e["locator"]))
        elif e["kind"].startswith("comment thread"):
            edges.append(_edge(e["speaker"], e["id"], "STARTED_THREAD", "T1", e["source_id"], e["locator"]))
            edges.append(_edge("person:ada-example", e["id"], "PARTICIPATED_IN_THREAD", "T1", e["source_id"], e["locator"]))
        elif e["kind"] == "workshop statement" and e["speaker"]:
            edges.append(_edge(e["speaker"], e["id"], "SAID", "T2", e["source_id"], e["locator"]))
        if e.get("topic"):
            edges.append(_edge(e["id"], "topic:clock-sync", "ABOUT", e["tier"], e["source_id"]))
        edges.append(_edge(e["id"], e["source_id"], "CITED_IN", e["tier"], e["source_id"], e["locator"]))
    for (person, mid, source), count in spoke.items():
        edges.append(_edge(person, mid, "SPOKE_IN", "TR", source, count=count))
    for award, device, tier in USES:
        edges.append(_edge(award, device, "USES", tier, "src:deck-example"))
    for device, evidence in SUPPORTED_BY:
        e = by_id[evidence]
        edges.append(_edge(device, evidence, "SUPPORTED_BY", e["tier"], e["source_id"], e["locator"]))
    device_of = dict((ev, dev) for dev, ev in SUPPORTED_BY)
    for person, evidence in PRESENTED:
        e = by_id[evidence]
        edges.append(_edge(person, evidence, "PRESENTED", "T2", e["source_id"], e["locator"]))
        edges.append(_edge(person, device_of[evidence], "SPOKE_ABOUT", "T2", e["source_id"], e["locator"]))
        edges.append(_edge(person, "award:" + e["award"], "PRESENTED_FOR", "T2", e["source_id"], e["locator"],
                           note="presenter per workshop summary; not an affiliation claim"))
    # computed, tier A: an interpretation, which no reader carries into a graph or a page
    edges.append(_edge("person:ada-example", "person:ben-sample", "CO_SPOKE_WITH", "A", "derived:example-network",
                       "example_network.gexf", weight=1.5, note="co-speaking in the same meeting"))
    edges.append(_edge("person:ada-example", "wg:standards-wg", "SPOKE_IN_GROUP", "A", "derived:example-network",
                       "example_edges.csv", meetings=2))
    edges.append(_edge("person:eve-roster", "person:ada-example", "CO_COMMENTED_WITH", "A", "derived:example-network",
                       "example_summary.json", weight=1, note="shared comment threads"))
    edges.append(_edge("person:ada-example", "term:template", "USED_TERM", "A", "src:comments-example",
                       "example_terms.csv", count=3, scope="synthetic comments"))
    aliases = [dict(zip(("name_as_written", "canonical_name", "person_id", "method", "first_seen_source"), row))
               for row in ALIASES]
    segments = [{"segment_id": id_, "notes_file": file, "group": group, "date": date, "header": header,
                 "attendees_as_written": attendees, "words": len(text.split()), "source_id": source,
                 "line_start": start, "line_end": end, "url": DOCS + source.split(":", 1)[1], "text": text}
                for id_, file, group, date, header, attendees, source, start, end, text in SEGMENTS]
    labels = Counter(n["label"] for n in nodes)
    items = sum(labels[label] for label in LABEL.values())
    stats = {"built": "synthetic", "sources": len(sources), "meetings": labels["Meeting"], "notes_segments": len(segments),
             "meeting_items": items, "people": labels["Person"], "organizations": labels["Organization"],
             "awards": labels["Award"], "devices": labels["Device"], "working_groups": labels["WorkingGroup"],
             "terms": labels["Term"], "node_labels": dict(labels), "evidence": len(EVIDENCE),
             "evidence_by_tier": dict(Counter(e["tier"] for e in EVIDENCE)), "edges": len(edges),
             "edge_types": dict(Counter(e["type"] for e in edges))}
    return {"nodes": nodes, "evidence": [dict(e) for e in EVIDENCE], "edges": edges, "sources": sources,
            "aliases": aliases, "segments": segments, "tiers": dict(TIERS), "stats": stats}


def _jsonl(rows) -> str:
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


def _csv(rows) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator="\r\n")     # CRLF, as the package's CSVs
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def write(folder) -> Path:
    """Write the synthetic package into `folder`, in the real package's layout. Returns the folder."""
    folder, r = Path(folder), records()
    files = {
        "kg/nodes.jsonl": _jsonl(r["nodes"]), "kg/evidence.jsonl": _jsonl(r["evidence"]),
        "kg/edges.jsonl": _jsonl(r["edges"]), "kg/sources.csv": _csv(r["sources"]),
        "kg/person_aliases.csv": _csv(r["aliases"]), "kg/tiers.json": json.dumps(r["tiers"], indent=1),
        "kg/stats.json": json.dumps(r["stats"], indent=1),
        "derived/meetings/meeting_notes_segments.jsonl": _jsonl(r["segments"]),
    }
    for name, text in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
    return folder


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(f"wrote the synthetic package to {write(sys.argv[1])}")
