#!/usr/bin/env python3
"""Working-group meeting notes -> the records the Graph Inspector's Meetings tab shows.

The input is the extraction of the BBQS working-group notes: a JSON list of meetings, each with
`date`, `group` (and `wg`, the name the notes used), `title`, `agenda`, `lessons`, `agreements`,
`disagreements`, `decisions`, `actions`, `blockers`, `speakers`, `attendees_listed` and a
`source_note`. The output is one JSON document: the meetings, every point made in them as an item of
its own, who each point is tied to, and the words the notes put in quotation marks.

How a point is tied to people. The notes name people by first name or nickname, and the ties are:
  said     the point is attributed to them: a parenthesis of names that closes a clause
           ("... (Alex)", "X (Alex) vs Y (Ben)", "(Ana, Ben supportive)"), or a clause that starts
           with their name and a colon ("Kim: we need a sandbox")
  owns     an action is theirs: it starts "Sam: draft the agenda", "Sam and team: ...", or "Sam to
           draft the agenda"
  relayed  they passed the point on for someone else ("(Kim via Alex)")
  named    the sentence mentions them otherwise, by first name, nickname or a surname only one
           speaker has; this is a weaker tie, since it is not always the same as having said it
A name is resolved to a full name from the meeting's own speakers first, then from the speakers of
the same group, then from everyone named anywhere in the notes; a name that matches nobody, or more
than one person at every step, is kept as written and marked unresolved. Each resolution says which
way it was made, so a reader can check it.

What it is not. The notes are summaries; the extraction says its items are paraphrases except where
quotation marks are used, and some of the source notes were written by Otter.ai or Zoom. Nothing
here is a transcript, and the page says so.

The notes are internal: they name people and what they argued. Keep the input and the output out of
this repository and off the public site; kg/quality.py embeds the output only in a fragment built
for the artifact viewer (`--internal`). This script refuses either path inside the repository.

    python kg/meetings.py /outside/the/repo/meetings_extracted.json --out /outside/the/repo/meetings.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

KIND = "bbqs-meetings"          # the marker tests/guards/inspector-internal-data looks for, written only here
KINDS = (("lessons", "lesson"), ("agreements", "agreement"), ("disagreements", "disagreement"),
         ("decisions", "decision"), ("actions", "action"), ("blockers", "blocker"))
KNOWN_FIELDS = {"wg", "group", "date", "title", "agenda", "speakers", "attendees_listed", "source_note",
                *(field for field, _kind in KINDS)}

# Nicknames the notes use for a first name. Only names the notes themselves use belong here.
NICKNAMES = {"Satra": "Satrajit", "Dave": "David", "Yarik": "Yaroslav", "Sul": "Suliman",
             "Sully": "Suliman", "Jen": "Jennifer", "Liz": "Lizzy", "Alex": "Alexander",
             "Sankar": "Sankaraleengam"}

CAVEAT = ("These are summaries of the meeting notes, not transcripts. The extraction sorted each "
          "meeting into agenda, lessons, agreements, disagreements, decisions and action items, as "
          "paraphrases except where quotation marks are used; some source notes are Otter.ai or Zoom "
          "AI summaries. Who is named depends on who took the notes.")

_SEP = re.compile(r"\s*(?:,|;|&|/|\band\b)\s*")
_PAREN = re.compile(r"\(([^()]{1,80})\)")
_CLAUSE_HEAD = re.compile(r"(?:^|[;?]\s*|\s+vs\.?\s+)([^:;?()]{1,60}):\s+\S")
_ACTION_TO = re.compile(r"^([^:;()]{1,60}?)\s+(?:to|will)\s+[a-z]")
_SPEECH = re.compile(r"\s+(?:agreed|agrees|agreeing(?:\s+with\s+\S+)?|proposed|proposes|proposal|asks|asked|"
                     r"supportive|supports|supported|suggested|suggests|objected|objects|disagreed|disagrees|"
                     r"warned|noted|raised|questioned)\s*$")
_FILLER = {"team", "group", "lab", "others", "all", "everyone"}
# Words in double quotes (straight or curly), or in single quotes that are not apostrophes: a quote
# opens after a non-letter and closes before one, and may hold apostrophes between letters (we're).
_QUOTED = re.compile(r"\"([^\"]{2,})\"|“([^”]{2,})”|(?<![\w’'])'((?:[^']|(?<=\w)'(?=\w)){2,}?)'(?![\w])")


def _fold(text: str) -> str:
    """Case- and accent-blind form of a name, for matching only."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().casefold().strip()


def _first(name: str) -> str:
    return _fold(name.split()[0]) if name.split() else ""


def _family(name: str) -> set[str]:
    """The words of a name after the first ("Ana Ruiz Diaz" -> ruiz, diaz)."""
    return {_fold(w) for w in re.sub(r"\(.*?\)", "", name).split()[1:]}


def _digest(*parts: str, n: int = 10) -> str:
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:n]


class People:
    """Everyone the notes name as a speaker, and the way from a first name back to one of them."""

    def __init__(self, meetings: list[dict]):
        self.everyone = sorted({s.strip() for m in meetings for s in m.get("speakers") or [] if s.strip()})
        self.by_group = defaultdict(set)
        for m in meetings:
            for s in m.get("speakers") or []:
                if s.strip():
                    self.by_group[m.get("group") or m.get("wg") or ""].add(s.strip())
        self.first_names = {_first(s) for s in self.everyone} | {_fold(n) for n in NICKNAMES}
        firsts = sorted({s.split()[0] for s in self.everyone if s.split()} | set(NICKNAMES), key=len, reverse=True)
        lasts = sorted({w for s in self.everyone for w in re.sub(r"\(.*?\)", "", s).split()[1:]}, key=len, reverse=True)
        self._mention = re.compile(r"(?<![\w-])(" + "|".join(map(re.escape, firsts)) + r")"
                                   r"(?:\s+(" + "|".join(map(re.escape, lasts)) + r"))?(?![\w-])") if firsts else None
        # A surname only one speaker has, and that is nobody's first name, names that speaker.
        owners = defaultdict(set)
        for s in self.everyone:
            for w in re.sub(r"\(.*?\)", "", s).split()[1:]:
                owners[w].add(s)
        self.surnames = {w: next(iter(who)) for w, who in owners.items()
                         if len(who) == 1 and _fold(w) not in self.first_names and len(w) > 2}
        self._surname = re.compile(r"(?<![\w-])(?:[A-Z]\.\s*)?(" + "|".join(map(re.escape, sorted(self.surnames, key=len, reverse=True)))
                                   + r")(?![\w-])") if self.surnames else None

    @staticmethod
    def looks_like_name(token: str) -> bool:
        """One to three capitalised words, none an acronym or a number ("NIH", "TF2" are not)."""
        words = token.split()
        return 0 < len(words) <= 3 and all(w[:1].isupper() and not w.isupper() and not any(c.isdigit() for c in w)
                                           for w in words)

    def is_known(self, token: str) -> bool:
        return bool(token.split()) and _fold(token.split()[0]) in self.first_names

    def mentioned(self, text: str) -> list[str]:
        """Names a sentence mentions: a speaker's first name or nickname, with the last name when it
        follows ("Sam Ortiz to lead"); possessives count ("Sam's email"), but not an eponym, a
        possessive followed by a capitalised word ("Sam's Rules"). Then a surname only one speaker
        has, alone or after an initial ("Ortiz", "S. Ortiz")."""
        out = []
        if self._mention:
            for m in self._mention.finditer(text):
                if re.match(r"['’]s\s+[A-Z][a-z]", text[m.end():]):
                    continue
                out.append(" ".join(w for w in m.groups() if w))
        if self._surname:
            covered = {w for name in out for w in name.split()[1:]}
            out += [m.group(1) for m in self._surname.finditer(text) if m.group(1) not in covered]
        return out

    def resolve(self, token: str, here: list[str], group: str = "") -> dict:
        """One name as the notes wrote it -> {as_written, name or None, basis}."""
        words = token.split()
        if len(words) == 1 and token in self.surnames:   # a surname only one speaker has
            return {"as_written": token, "name": self.surnames[token], "basis": "the only speaker with that surname"}
        first = _fold(NICKNAMES.get(words[0], words[0]))
        last = _fold(words[-1]) if len(words) > 1 else ""

        def matching(pool):
            return sorted(s for s in pool if _first(s) == first and (not last or last in _family(s)))

        local = matching(here)
        if len(local) == 1:
            return {"as_written": token, "name": local[0], "basis": "a speaker in this meeting"}
        if len(local) > 1:
            return {"as_written": token, "name": None,
                    "basis": "more than one speaker in this meeting: " + ", ".join(local)}
        in_group = matching(self.by_group.get(group, ()))
        if len(in_group) == 1:
            return {"as_written": token, "name": in_group[0],
                    "basis": "not in this meeting's speakers; the only person of that name who speaks in this group"}
        everywhere = matching(self.everyone)
        if len(everywhere) == 1:
            return {"as_written": token, "name": everywhere[0],
                    "basis": "not in this meeting's speakers; the only person of that name in the notes"}
        if everywhere:
            return {"as_written": token, "name": None,
                    "basis": "not in this meeting's speakers, and several people in the notes have that name: "
                             + ", ".join(everywhere)}
        return {"as_written": token, "name": None, "basis": "no speaker in the notes has that name"}


def _names_in(text: str, people: People, lenient: bool = False) -> list[tuple[str, str]] | None:
    """A run of names ("Alex, Ben", "Ana/Ben", "Kim via Alex", "Ana, Ben supportive") ->
    [(token, how)], else None. Every part must look like a name and at least one must be a
    speaker's, so "(NIH)", "(open)" or "EMBER:" tie nobody; a name no speaker has is kept, and shows
    as unresolved. `lenient` (an owner or speaker prefix) drops acronyms and words like "team" first,
    so "Sam and team:" and "Sam/DCAIC:" still name Sam."""
    via = re.split(r"\s+via\s+", text.strip())
    parts = []
    for chunk in via:
        tokens = [_SPEECH.sub("", t).strip() for t in _SEP.split(chunk) if t.strip()]
        if lenient:
            tokens = [t for t in tokens if not t.isupper() and t.casefold() not in _FILLER]
        parts.append([t for t in tokens if t])
    if len(parts) > 2 or not all(parts):
        return None
    tokens = [t for chunk in parts for t in chunk]
    if not (all(people.looks_like_name(t) for t in tokens) and any(people.is_known(t) for t in tokens)):
        return None
    out = [(t, "attributed") for t in parts[0]]
    return out + [(t, "relayed") for t in parts[1]] if len(parts) == 2 else out


def attributions(text: str, kind: str, people: People, here: list[str], group: str = "") -> list[dict]:
    """Who a point is tied to, and how (the module docstring lists the ties). One entry per person,
    the strongest tie first."""
    found, spans = [], []
    if kind == "action":
        owner = _CLAUSE_HEAD.match(text) or _ACTION_TO.match(text)
        names = _names_in(owner.group(1), people, lenient=True) if owner else None
        if names:
            found += [(t, "owner") for t, _how in names]
            spans.append(owner.span(1))
    for head in _CLAUSE_HEAD.finditer(text):           # "Kim: ..." at the start of any clause
        if any(a <= head.start(1) < b for a, b in spans):
            continue
        names = _names_in(head.group(1), people, lenient=True)
        if names:
            found += names
            spans.append(head.span(1))
    for paren in _PAREN.finditer(text):
        names = _names_in(paren.group(1), people)
        if not names:
            continue
        before, after = text[:paren.start()].rstrip(), text[paren.end():]
        apposition = (re.search(r"(?:\b[A-Z]{2,}|\b(?:team|group|lab))$", before)
                      and not re.match(r"\s*(?:$|[;,)]|vs\b)", after))
        found += [(t, "named") for t, _how in names] if apposition else names   # "NIH (Ana, Ben) and ..." lists members
        spans.append(paren.span())
    rest = "".join(" " if any(a <= i < b for a, b in spans) else c for i, c in enumerate(text))
    found += [(t, "named") for t in people.mentioned(rest)]
    out, seen = [], set()
    for token, how in found:
        resolved = people.resolve(token, here, group)
        key = resolved["name"] or token
        if key in seen:
            continue
        seen.add(key)
        out.append({**resolved, "how": how})
    order = {"owner": 0, "attributed": 1, "relayed": 2, "named": 3}
    return sorted(out, key=lambda w: order.get(w["how"], 9))


def quotes(text: str) -> list[str]:
    return [next(g for g in m.groups() if g) for m in _QUOTED.finditer(text)]


def build(meetings: list[dict], source: dict) -> dict:
    people = People(meetings)
    out_meetings, items = [], []
    tally, spoke, groups_of = defaultdict(Counter), Counter(), defaultdict(set)
    unresolved, unknown = Counter(), Counter()
    for m in sorted(meetings, key=lambda m: (m.get("date") or "", m.get("group") or "", (m.get("title") or "").strip())):
        group = m.get("group") or m.get("wg") or "Unknown group"
        title = (m.get("title") or "").strip()
        mid = "m" + _digest(m.get("date") or "", group, title, n=8)
        speakers = [s.strip() for s in m.get("speakers") or [] if s.strip()]
        for key, value in m.items():
            if key not in KNOWN_FIELDS and isinstance(value, list) and value and all(isinstance(v, str) for v in value):
                unknown[key] += 1
        for s in speakers:
            spoke[s] += 1
            groups_of[s].add(group)
        counts = {}
        for field, kind in KINDS:
            entries = [t.strip() for t in m.get(field) or [] if isinstance(t, str) and t.strip()]
            counts[kind] = len(entries)
            for n, text in enumerate(entries):
                who = attributions(text, kind, people, speakers, group)
                for w in who:
                    if w["name"] is None:
                        unresolved[w["as_written"]] += 1
                    else:
                        tally[w["name"]][w["how"]] += 1
                # Keyed on where the point sits, not its wording, so a flag survives a corrected note.
                items.append({"id": "i" + _digest(mid, kind, str(n + 1)), "meeting": mid, "kind": kind, "n": n + 1,
                              "text": text, "who": who, "quotes": quotes(text)})
        out_meetings.append({
            "id": mid, "date": m.get("date"), "group": group, "as_named": m.get("wg") or group,
            "title": title, "agenda": [a for a in m.get("agenda") or [] if a],
            "speakers": speakers, "attendees": [a.strip() for a in m.get("attendees_listed") or [] if isinstance(a, str) and a.strip()],
            "note": m.get("source_note") or "", "counts": counts,
        })
    ids = Counter(i["id"] for i in items)
    dupes = {k for k, v in ids.items() if v > 1}
    for item in items:                                  # two meetings with one date, group and title
        if item["id"] in dupes:
            item["id"] = f"{item['id']}-{item['meeting']}"
    names = sorted(set(people.everyone) | set(tally))
    return {
        "kind": KIND, "version": 2, "source": source, "caveat": CAVEAT,
        "meetings": out_meetings,
        "items": items,
        "people": [{"name": n, "meetings": spoke[n], "groups": sorted(groups_of[n]),
                    "attributed": tally[n]["attributed"], "owns": tally[n]["owner"],
                    "named": tally[n]["named"] + tally[n]["relayed"]} for n in names],
        "unresolved": [{"as_written": t, "count": c} for t, c in unresolved.most_common()],
        "unread_fields": dict(unknown),
    }


def refuse_on_ci(parser) -> None:
    """These records are internal: they are built by hand, never on a CI runner."""
    if os.environ.get("GITHUB_ACTIONS") == "true" or os.environ.get("CI"):
        parser.error("this runs on CI (GITHUB_ACTIONS or CI is set); internal records are built by hand only")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("notes", type=Path, help="the extracted meetings, a JSON list")
    parser.add_argument("--out", type=Path, required=True, help="where to write the records (outside the repo)")
    parser.add_argument("--describe", default="", help="where the notes came from, shown on the page")
    args = parser.parse_args(argv)
    refuse_on_ci(parser)
    repo = Path(__file__).resolve().parent.parent
    for path, what in ((args.notes, "the notes"), (args.out, "--out")):
        try:
            path.resolve().relative_to(repo)
        except ValueError:
            continue
        parser.error(f"{what} {path} is inside the repository; meeting notes are internal, keep them elsewhere")
    raw = args.notes.read_bytes()
    meetings = json.loads(raw)
    if not isinstance(meetings, list) or not all(isinstance(m, dict) for m in meetings):
        parser.error(f"{args.notes} is not a JSON list of meetings")
    source = {"file": args.notes.name, "sha256": hashlib.sha256(raw).hexdigest(), "meetings": len(meetings),
              "description": args.describe}
    doc = build(meetings, source)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    resolved = sum(1 for i in doc["items"] for w in i["who"] if w["name"])
    total = sum(len(i["who"]) for i in doc["items"])
    print(f"{len(doc['meetings'])} meetings, {len(doc['items'])} items, {total} ties "
          f"({resolved} resolved to a full name), {sum(1 for i in doc['items'] if i['quotes'])} items quote someone; "
          f"wrote {args.out}")
    if doc["unread_fields"]:
        print(f"fields of the notes this does not read: {doc['unread_fields']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
