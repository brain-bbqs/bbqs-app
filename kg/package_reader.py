#!/usr/bin/env python3
"""The BBQS meetings data package, read from its folder, with the rules the readers apply to it.

The package is internal: meeting notes, transcripts, comments and the device list, with the people
who said what. It is never committed and never read on CI; kg/meetings.py, kg/devices.py and
kg/internal_graph.py read it from a folder outside the repository, through this module, and the
tests read the synthetic one of kg/fixtures/synthetic_package.py. What is read:

    kg/nodes.jsonl, kg/evidence.jsonl, kg/edges.jsonl      one JSON record per line
    kg/sources.csv, kg/person_aliases.csv
    derived/meetings/meeting_notes_segments.jsonl          the notes, one block per meeting
    kg/tiers.json, kg/stats.json                           when they are there

Every record carries a confidence tier, and the tier decides how it may be cited (CITE). That rule
and the others here are the package's own (its README, "Rules for loading and answering"):

  tiers      TR, T1 and T3 may be quoted as written; T2 is "the summary says"; X is an AI summary of
             the notes, shown with the notes block it paraphrases; U is a guess and never a fact;
             A is computed, and no reader turns a computed edge or a term count into a record.
  names      a speaker is kept as written; the person the package resolved it to is given with how
             (the alias table's method), and flagged when that method says VERIFY. A Person record
             that carries a note (a shared account) is shown with it and never taken for a person.
  notes      an item paraphrases its meeting's notes block. Where the package's link is missing or
             points at a stub, two rules repair it, and the result says so (segment_links):
               same_group_and_date   a block no meeting cites belongs to the one meeting of its
                                     group and date;
               names_this_date       a meeting left with no block is given the block of its own
                                     notes document that has a line naming its date (failing a
                                     day, its month and year: names_this_month). From that line on
                                     the block's lines are that meeting's, up to the next such line.
  placement  a note line the package keeps as evidence (tier T3) names no meeting; it is placed in
             the meeting whose block holds the line its locator cites, when the dates agree.
  contact    every web link, e-mail address and assignee inside a carried text is replaced by a
             marker ([link redacted], [email redacted], [name redacted]); a record's own source
             link is kept. Line counts never change.
  devices    a row's observable properties are its `measures`, split at commas and semicolons
             outside brackets; the names a sensor goes by are its name, the makers in its brackets
             and the maker stated on the slide. Mentions are the transcript cues, chat lines and
             notes lines that name one of them: plain text matching (whole words, any case, an
             optional plural), never a model.

Standard library only, so the readers run with `python -I`.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from identity_keys import name_key  # noqa: E402

REQUIRED = ("kg/nodes.jsonl", "kg/evidence.jsonl", "kg/edges.jsonl", "kg/sources.csv", "kg/person_aliases.csv",
            "derived/meetings/meeting_notes_segments.jsonl")
OPTIONAL = ("kg/tiers.json", "kg/stats.json")

TIERS = ("TR", "T1", "T3", "T2", "X", "A", "U")
QUOTABLE = ("TR", "T1", "T3")
# How a record of each tier may be cited. The wording is this repository's; the rule is the package's.
CITE = {
    "TR": "A quote, as captioned: give the speaker, meeting, date and time. An auto-caption nobody has checked; "
          "the speaker is a display name.",
    "T1": "A quote from a written record by participants (a slide, a comment, a chat line): give the author, "
          "date and locator.",
    "T3": "The note-taker's words, quoted from the meeting notes: not necessarily what the speaker said.",
    "T2": "Not a quote. Say \"the summary says\": it was written from transcripts that are not in the package.",
    "X": "Not a quote. An AI summary of the notes: say \"the notes record that\", and check it against the "
         "notes block it paraphrases.",
    "A": "Computed: an interpretation, not something anyone said.",
    "U": "An unverified guess. Never state it as fact; confirm it with the lab first.",
}

# Meeting items: the field in an item's id, the kind the readers use, the package's node label.
ITEM_KINDS = (("agenda", "agenda", "AgendaItem"), ("lessons", "lesson", "Lesson"), ("agreements", "agreement", "Agreement"),
              ("disagreements", "disagreement", "Disagreement"), ("decisions", "decision", "Decision"),
              ("actions", "action", "ActionItem"))
KIND_OF_LABEL = {label: kind for _field, kind, label in ITEM_KINDS}
KIND_ORDER = [kind for _field, kind, _label in ITEM_KINDS]

# The package's evidence kinds, as the tokens the schema's evidence_kind_enum uses.
EVIDENCE_KINDS = {
    "utterance": "utterance",
    "chat message": "chat_message",
    "document comment": "document_comment",
    "comment thread (excerpt)": "comment_thread_excerpt",
    "team slide row": "team_slide_row",
    "speaker attribution (workshop)": "speaker_attribution",
    "manufacturer/model candidate": "unverified_candidate",
    "workshop statement": "workshop_statement",
    "award status at Blitz": "award_status",
    "device discussion": "device_discussion",
}
# Edges the package computed (tier A): networks, term counts, its own grouping. Never records.
COMPUTED_EDGES = frozenset({"PART_OF", "CO_SPOKE_WITH", "CO_COMMENTED_WITH", "SPOKE_IN_GROUP", "USED_TERM"})
# The evidence a mention may come from: what was said in a meeting (cues, chat lines), and the notes.
SPOKEN_KINDS = ("utterance", "chat message")
FILLERS = frozenset({"etc", "other", "others", "custom", "none", "tbd", "na", "misc", "various", "unknown"})

_VERIFY = re.compile(r"\bVERIFY\b")
_URL = re.compile(r"(?:https?://|www\.)[^\s<>\"]+", re.I)
_BARE_LINK = re.compile(r"(?<![\w@/.\[])(?:[a-z0-9-]+\.)+[a-z]{2,}/[^\s<>\"]+", re.I)
_EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]*\w@\w[\w-]*(?:\.[\w-]+)*")
_ASSIGNED = re.compile(r"(_Assigned to )([^_\n]+)(_)")
_TRAILING = ".,;:!?)]}'\""
_MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
           "november", "december")
_LINE_NO = re.compile(r"\bline (\d+)\s*$")


class PackageError(ValueError):
    """The folder is not the data package, or a file of it cannot be read as one."""


def redact(text: str, tally: Counter | None = None) -> str:
    """A carried text without contact or access data: each web link, e-mail address and assignee is
    replaced by a marker, on its own line, so line counts stay what they were."""
    def link(m):
        url = m.group(0)
        tail = ""
        while url and url[-1] in _TRAILING:                   # "see https://x.org/a)." keeps its ")."
            url, tail = url[:-1], url[-1] + tail
        if tally is not None:
            tally["link"] += 1
        return "[link redacted]" + tail

    def email(m):
        if tally is not None:
            tally["email"] += 1
        return "[email redacted]"

    def assigned(m):
        if tally is not None:
            tally["name"] += 1
        return m.group(1) + "[name redacted]" + m.group(3)

    text = _ASSIGNED.sub(assigned, text or "")
    text = _URL.sub(link, text)
    text = _BARE_LINK.sub(link, text)
    return _EMAIL.sub(email, text)


def split_top(text: str) -> list[str]:
    """A list as a slide writes it, split at commas and semicolons that are not inside brackets:
    "Pose, clusters (idle, grooming), gait" is three entries."""
    out, depth, current = [], 0, ""
    for ch in text or "":
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        if ch in ",;" and depth == 0:
            out.append(current)
            current = ""
        else:
            current += ch
    out.append(current)
    return [part.strip() for part in out if part.strip()]


def term_key(term: str) -> str:
    """One key per term however it is spelled: the name key (kg/identity_keys.py)."""
    return name_key(term) or ""


def _is_filler(term: str) -> bool:
    return (name_key(term) or "") in FILLERS


def property_labels(device: dict) -> list[str]:
    """What a device row says it measures: one label per observable property, as first written."""
    out, seen = [], set()
    for part in split_top(device.get("measures") or ""):
        label, key = " ".join(part.split()), term_key(part)
        if not key or key in seen or _is_filler(label):
            continue
        seen.add(key)
        out.append(label)
    return out


def sensor_terms(device: dict) -> list[str]:
    """The names a row's instrument goes by: its name (each entry of a list, with what stands in its
    brackets apart: "Cameras (Acme / Lumen)" is Cameras, Acme and Lumen), and the maker the slide states."""
    terms = []
    for part in split_top(device.get("name") or ""):
        m = re.fullmatch(r"(.*?)\s*\((.*)\)\s*", part)
        if m:
            terms.append(m.group(1))
            terms += re.split(r"\s*(?:/|,|;)\s*", m.group(2))
        else:
            terms.append(part)
    terms += split_top(device.get("manufacturer_stated") or "")
    out, seen = [], set()
    for term in (" ".join(t.split()) for t in terms):
        key = term_key(term)
        if len(term) < 3 or not key or key in seen or _is_filler(term):
            continue
        seen.add(key)
        out.append(term)
    return out


def term_pattern(term: str) -> re.Pattern:
    """A term as plain text matching finds it: whole words, any case, any spacing, with or without a
    plural s ("Microphones" finds "microphone"; "EEG" does not find "iEEG")."""
    words = term.split()
    last = words[-1]
    if len(last) > 3 and last[-1] in "sS" and last[-2] not in "sS":
        last = last[:-1]
    body = r"\s+".join(re.escape(w) for w in words[:-1] + [last])
    return re.compile(r"(?<![A-Za-z0-9])" + body + r"(?:e?s)?(?![A-Za-z0-9])", re.I)


def date_lines(text: str, iso_date: str) -> tuple[list[int], str | None]:
    """The lines of a notes block that name a date, and how exactly: "day" ("December 1, 2025",
    "Dec 1 2025", "2025/12/01", "12/1/2025") or, when no line names the day, "month" ("December 2025")."""
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", iso_date or "")
    if not m:
        return [], None
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not 1 <= month <= 12:
        return [], None
    name = _MONTHS[month - 1]
    mon = rf"(?:{name}|{name[:3]}{'|sept' if month == 9 else ''})\.?"
    days = [
        rf"(?<![a-z]){mon},?\s+0?{day}(?:st|nd|rd|th)?(?!\d),?\s+{year}(?!\d)",
        rf"(?<!\d)0?{day}(?:st|nd|rd|th)?\s+{mon},?\s+{year}(?!\d)",
        rf"(?<![\d/.-]){year}[/-]0?{month}[/-]0?{day}(?![\d/.-])",
        rf"(?<![\d/.-])0?{month}/0?{day}/{year}(?![\d/.-])",
    ]
    by_day = re.compile("|".join(days), re.I)
    by_month = re.compile(rf"(?<![a-z]){mon},?\s+{year}(?!\d)", re.I)
    lines = (text or "").splitlines()
    hits = [i for i, line in enumerate(lines) if by_day.search(line)]
    if hits:
        return hits, "day"
    hits = [i for i, line in enumerate(lines) if by_month.search(line)]
    return (hits, "month") if hits else ([], None)


def _jsonl(path: Path) -> list[dict]:
    out = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as e:
            raise PackageError(f"{path.name} line {n} is not JSON: {e}") from None
        if not isinstance(row, dict):
            raise PackageError(f"{path.name} line {n} is not a JSON object")
        out.append(row)
    return out


def _csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as handle:
        return [{(k or "").strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(handle)]


class Package:
    """The package's records, read once, and the rules above as methods."""

    # the free texts that are carried into a page or a graph, and so are redacted when read
    TEXT_FIELDS = {"evidence": ("text",), "segments": ("text", "header"),
                   "nodes": ("text", "title", "source_note", "transcript_note", "status_at_blitz")}

    def __init__(self, folder):
        self.folder = Path(folder)
        missing = [name for name in REQUIRED if not (self.folder / name).is_file()]
        if missing:
            raise PackageError(f"{self.folder} is not the meetings data package: it has no {', '.join(missing)}")
        self.redactions = Counter()
        self.nodes = self._clean(_jsonl(self.folder / "kg/nodes.jsonl"), "nodes")
        self.evidence = self._clean(_jsonl(self.folder / "kg/evidence.jsonl"), "evidence")
        self.edges = _jsonl(self.folder / "kg/edges.jsonl")
        self.sources = _csv(self.folder / "kg/sources.csv")
        self.aliases = _csv(self.folder / "kg/person_aliases.csv")
        self.segments = self._clean(_jsonl(self.folder / "derived/meetings/meeting_notes_segments.jsonl"), "segments")
        self.tiers = self._json("kg/tiers.json")
        self.stats = self._json("kg/stats.json")

        self.node = {n["id"]: n for n in self.nodes}
        self.by_label = defaultdict(list)
        for n in self.nodes:
            self.by_label[n.get("label", "")].append(n)
        self.evidence_by_id = {e["id"]: e for e in self.evidence}
        self.source = {s["source_id"]: s for s in self.sources}
        self.segment = {s["segment_id"]: s for s in self.segments}
        self.person = {n["id"]: n for n in self.by_label["Person"]}
        self.meetings = sorted(self.by_label["Meeting"], key=lambda m: (m.get("date") or "", m["id"]))
        self.meeting = {m["id"]: m for m in self.meetings}
        self.items = [self._item(n) for n in self.nodes if n.get("label") in KIND_OF_LABEL]
        self.item = {i["id"]: i for i in self.items}
        self._items_of = defaultdict(list)
        for i in sorted(self.items, key=lambda i: (KIND_ORDER.index(i["kind"]), i["n"])):
            self._items_of[i["meeting"]].append(i)
        self.edges_by_type = defaultdict(list)
        for e in self.edges:
            self.edges_by_type[e.get("type", "")].append(e)
        self.computed_edges = [e for e in self.edges if e.get("type") in COMPUTED_EDGES or e.get("tier") == "A"]
        self.stated_edges = [e for e in self.edges if not (e.get("type") in COMPUTED_EDGES or e.get("tier") == "A")]
        self._alias = {(a.get("person_id", ""), a.get("name_as_written", "")): a for a in self.aliases}
        self._links = None
        self._mentions = None

    # ---- reading -----------------------------------------------------------------------------------

    @staticmethod
    def is_package(path) -> bool:
        path = Path(path)
        return path.is_dir() and all((path / name).is_file() for name in REQUIRED)

    def _json(self, name: str) -> dict:
        path = self.folder / name
        if not path.is_file():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as e:
            raise PackageError(f"{name} is not JSON: {e}") from None
        return value if isinstance(value, dict) else {}

    def _clean(self, rows: list[dict], what: str) -> list[dict]:
        for row in rows:
            for field in self.TEXT_FIELDS[what]:
                if isinstance(row.get(field), str):
                    row[field] = redact(row[field], self.redactions)
        return rows

    @staticmethod
    def _item(node: dict) -> dict:
        tail = node["id"].rsplit(":", 1)[-1]                     # "lessons-01" of "<meeting>:lessons-01"
        number = re.search(r"-(\d+)$", tail)
        return {"id": node["id"], "meeting": node.get("meeting") or node["id"].rsplit(":", 1)[0],
                "kind": KIND_OF_LABEL[node["label"]], "n": int(number.group(1)) if number else 0,
                "text": node.get("text") or "", "tier": node.get("tier") or "",
                "attributed_to_as_written": node.get("attributed_to_as_written") or "",
                "date": node.get("date") or "", "group": node.get("group") or "",
                "source_id": node.get("source_id") or "", "locator": node.get("locator") or "", "url": node.get("url") or ""}

    def items_of(self, meeting_id: str) -> list[dict]:
        """A meeting's items, by kind (agenda first, actions last) and then by their place in the notes."""
        return list(self._items_of.get(meeting_id, ()))

    def digest(self) -> dict:
        """sha256 of each file read, so a page built from the package says from which copy."""
        return {name: hashlib.sha256((self.folder / name).read_bytes()).hexdigest()
                for name in REQUIRED + OPTIONAL if (self.folder / name).is_file()}

    def counts(self) -> dict:
        return {"node_labels": dict(Counter(n.get("label", "") for n in self.nodes)),
                "edge_types": dict(Counter(e.get("type", "") for e in self.edges)),
                "evidence": len(self.evidence),
                "evidence_by_tier": dict(Counter(e.get("tier", "") for e in self.evidence)),
                "edges": len(self.edges), "meetings": len(self.meetings), "notes_segments": len(self.segments),
                "meeting_items": len(self.items), "sources": len(self.sources)}

    def check_against_stats(self) -> list[str]:
        """Every count kg/stats.json states that the files do not bear out. Empty when they agree, or
        when the package has no stats file."""
        have, problems = self.counts(), []
        for key, mine in have.items():
            if key not in self.stats:
                continue
            theirs = self.stats[key]
            if isinstance(mine, dict):
                for sub in sorted(set(mine) | set(theirs)):
                    if mine.get(sub, 0) != theirs.get(sub, 0):
                        problems.append(f"{key} {sub}: the files hold {mine.get(sub, 0)}, kg/stats.json says {theirs.get(sub, 0)}")
            elif mine != theirs:
                problems.append(f"{key}: the files hold {mine}, kg/stats.json says {theirs}")
        return problems

    # ---- names -------------------------------------------------------------------------------------

    def resolution(self, person_id: str, as_written: str) -> dict:
        """How a name as written stands for a person: the alias table's method, and whether it is a
        guess (VERIFY). A full name needs no alias; a name the table does not list says so."""
        person = self.person.get(person_id or "")
        if not person:
            return {"as_written": as_written or "", "person": "", "name": "", "verify": False, "how": "", "note": ""}
        name, alias = person.get("name") or "", self._alias.get((person_id, as_written or ""))
        if alias:
            how = alias.get("method") or "listed in the alias table, with no method"
        elif term_key(as_written) == term_key(name):
            how = "the full name, as written"
        else:
            how = "the alias table does not record how this name was resolved"
        return {"as_written": as_written or "", "person": person_id, "name": name,
                "verify": bool(_VERIFY.search(how)) if alias else False, "how": how, "note": person.get("note") or ""}

    def speaker(self, evidence: dict) -> dict:
        """An evidence record's speaker: as written, and the person the package resolved it to."""
        return self.resolution(evidence.get("speaker") or "", evidence.get("speaker_as_written") or "")

    def raised_by(self, item_id: str) -> list[dict]:
        """Who the package attributes an item to (its RAISED edges), each with the part of the item's
        attributed_to_as_written that names them and how that name was resolved."""
        written = (self.item.get(item_id) or {}).get("attributed_to_as_written") or ""

        def named(name: str) -> bool:
            return bool(name) and re.search(r"(?<!\w)" + re.escape(name) + r"(?!\w)", written, re.I) is not None

        out = []
        for edge in self.edges_by_type.get("RAISED", ()):
            if edge.get("target") != item_id or edge.get("source") not in self.person:
                continue
            person = edge["source"]
            aliases = sorted((a.get("name_as_written", "") for a in self.aliases if a.get("person_id") == person),
                             key=len, reverse=True)
            token = next((a for a in aliases if named(a)), None)
            if token is None and named(self.person[person].get("name") or ""):
                token = self.person[person]["name"]
            out.append(self.resolution(person, token) if token else
                       {**self.resolution(person, written), "how": "the alias table does not record how this name was resolved"})
        return out

    # ---- notes blocks ------------------------------------------------------------------------------

    def segment_links(self) -> dict:
        """Which notes blocks each meeting's items paraphrase (the module docstring states the rules).

        {"by_meeting": {meeting: [{"segment", "how", "repaired", "lines"}]},
         "unattached": [block no meeting has],
         "parts": {block: [(first line, meeting)]}}      # the lines other meetings have inside a block"""
        if self._links is not None:
            return self._links
        by_meeting = {m["id"]: [] for m in self.meetings}
        taken = set()
        for m in self.meetings:
            sid = m.get("notes_segment") or ""
            if sid in self.segment:
                by_meeting[m["id"]].append({"segment": sid, "how": "cited", "repaired": False, "lines": []})
                taken.add(sid)
        same = defaultdict(list)
        for m in self.meetings:
            same[(m.get("group"), m.get("date"))].append(m["id"])
        for seg in self.segments:
            owners = same.get((seg.get("group"), seg.get("date")), [])
            if seg["segment_id"] not in taken and len(owners) == 1:
                by_meeting[owners[0]].append({"segment": seg["segment_id"], "how": "same_group_and_date",
                                              "repaired": True, "lines": []})
                taken.add(seg["segment_id"])
        parts = defaultdict(list)
        for m in self.meetings:
            if by_meeting[m["id"]]:
                continue
            found = []
            for seg in self.segments:
                if seg.get("source_id") and seg.get("source_id") == m.get("source_id"):
                    lines, level = date_lines(seg.get("text") or "", m.get("date") or "")
                    if lines:
                        found.append((seg["segment_id"], lines, level))
            pick = [f for f in found if f[2] == "day"] or found
            if len(pick) == 1:
                sid, lines, level = pick[0]
                by_meeting[m["id"]].append({"segment": sid, "how": "names_this_date" if level == "day" else "names_this_month",
                                            "repaired": True, "lines": lines})
                parts[sid].append((lines[0], m["id"]))
        self._links = {"by_meeting": by_meeting,
                       "unattached": [s["segment_id"] for s in self.segments if s["segment_id"] not in taken],
                       "parts": {sid: sorted(p) for sid, p in parts.items()}}
        return self._links

    def meetings_of_segment(self, segment_id: str) -> list[str]:
        """The meetings a block belongs to: the one that cites it (or was given it) first, then any
        written inside it."""
        links = self.segment_links()["by_meeting"]
        whole = [m for m, ls in links.items() if any(l["segment"] == segment_id and not l["lines"] for l in ls)]
        inside = [m for m, ls in links.items() if any(l["segment"] == segment_id and l["lines"] for l in ls)]
        return whole + inside

    def meeting_of_line(self, segment_id: str, line: int) -> str:
        """The meeting a line of a block belongs to: the one whose dated line most closely precedes
        it, else the meeting the block is cited by. "" for a block no meeting has."""
        owner = ""
        for start, meeting in self.segment_links()["parts"].get(segment_id, ()):
            if start <= line:
                owner = meeting
        if owner:
            return owner
        whole = [m for m in self.meetings_of_segment(segment_id)
                 if any(l["segment"] == segment_id and not l["lines"] for l in self.segment_links()["by_meeting"][m])]
        return whole[0] if whole else ""

    def meeting_of(self, evidence: dict) -> tuple[str, str]:
        """The meeting an evidence record belongs to, and how that is known: "stated" (the record
        names it), or, for a note line, "by the line its locator cites". ("", "") when it has none."""
        if evidence.get("meeting"):
            return evidence["meeting"], "stated"
        cited = _LINE_NO.search(evidence.get("locator") or "")
        if evidence.get("tier") != "T3" or not cited:
            return "", ""
        line, found = int(cited.group(1)), set()
        for seg in self.segments:
            try:
                inside = int(seg.get("line_start")) <= line <= int(seg.get("line_end"))
            except (TypeError, ValueError):
                continue
            if inside and seg.get("source_id") == evidence.get("source_id"):
                for meeting in self.meetings_of_segment(seg["segment_id"]):
                    if self.meeting[meeting].get("date") == evidence.get("date"):
                        found.add(meeting)
        return (found.pop(), "by the line its locator cites") if len(found) == 1 else ("", "")

    # ---- devices -----------------------------------------------------------------------------------

    def mentions(self) -> dict:
        """The lines that name a device row's instrument or one of its observable properties.

        {"terms": {key: {"term": as first written, "hits": [hit]}},
         "by_device": {device id: {"sensor": [key], "property": [key]}}}
        A hit is one transcript cue or chat line (an evidence record) or one line of a notes block:
        its text, tier, speaker, meeting, date, source and locator. AI summaries are never searched."""
        if self._mentions is not None:
            return self._mentions
        lines = []
        for e in self.evidence:
            if e.get("kind") in SPOKEN_KINDS:
                meeting, _how = self.meeting_of(e)
                lines.append({"where": e["id"], "tier": e.get("tier") or "", "kind": EVIDENCE_KINDS.get(e["kind"], e["kind"]),
                              "text": e.get("text") or "", "speaker": self.speaker(e), "meeting": meeting,
                              "date": e.get("date") or "", "source": e.get("source_id") or "",
                              "locator": e.get("locator") or "", "url": e.get("url") or ""})
        nobody = self.resolution("", "")
        for seg in self.segments:
            for k, text in enumerate((seg.get("text") or "").splitlines()):
                if not text.strip():
                    continue
                meeting = self.meeting_of_line(seg["segment_id"], k)
                lines.append({"where": f"{seg['segment_id']}#{k}", "tier": "T3", "kind": "notes_line", "text": text.strip(),
                              "speaker": nobody, "meeting": meeting,
                              "date": (self.meeting.get(meeting) or seg).get("date") or "", "source": seg.get("source_id") or "",
                              "locator": f"notes block lines {seg.get('line_start')}-{seg.get('line_end')}, line {k + 1} of the block",
                              "url": seg.get("url") or ""})
        terms, by_device = {}, {}
        for device in self.by_label["Device"]:
            # a property of two letters ("HR") is a property all the same, but too short to search for
            sensor, prop = sensor_terms(device), [p for p in property_labels(device) if len(p) >= 3]
            by_device[device["id"]] = {"sensor": [term_key(t) for t in sensor], "property": [term_key(t) for t in prop]}
            for term in sensor + prop:
                terms.setdefault(term_key(term), {"term": term, "hits": None})
        for entry in terms.values():
            pattern = term_pattern(entry["term"])
            entry["hits"] = [line for line in lines if pattern.search(line["text"])]
        self._mentions = {"terms": terms, "by_device": by_device}
        return self._mentions
