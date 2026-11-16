#!/usr/bin/env python3
"""Working-group meeting notes -> the records the Graph Inspector's Meetings tab shows.

The input is the extraction of the BBQS working-group notes: a JSON list of meetings, each with
`date`, `group` (and `wg`, the name the notes used), `title`, `agenda`, `lessons`, `agreements`,
`disagreements`, `decisions`, `actions`, `speakers` and a `source_note`. The output is one JSON
document: the meetings, every point made in them as an item of its own, who each point is
attributed to, and the words the notes put in quotation marks.

How a point is attributed. The notes name people by first name or nickname: a lesson ends
"(Satra)", an action starts "Jyl: agenda for Thursday". A name is resolved to a full name from the
meeting's own speakers first, then from everyone named anywhere in the notes; a name that matches
nobody, or more than one person, is kept as written and marked unresolved. A parenthesis that is not
made only of names ("(NIH)", "(open)") attributes nothing. Each resolution says which way it was
made, so a reader can check it.

What it is not. The notes are summaries; the extraction says its items are paraphrases except where
quotation marks are used, and some of the source notes were written by Otter.ai or Zoom. Nothing
here is a transcript, and the page says so.

The notes are internal: they name people and what they argued. Keep the input and the output out of
this repository and off the public site; kg/quality.py embeds the output only in a fragment built
for the artifact viewer (`--internal`).

    python kg/meetings.py notes/meetings_extracted.json --out /somewhere/outside/meetings.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

KINDS = (("lessons", "lesson"), ("agreements", "agreement"), ("disagreements", "disagreement"),
         ("decisions", "decision"), ("actions", "action"))

# Nicknames the notes use for a first name. Only names the notes themselves use belong here.
NICKNAMES = {"Satra": "Satrajit", "Dave": "David", "Yarik": "Yaroslav", "Sul": "Suliman",
             "Sully": "Suliman", "Jen": "Jennifer", "Liz": "Lizzy"}

CAVEAT = ("These are summaries of the meeting notes, not transcripts. The extraction sorted each "
          "meeting into agenda, lessons, agreements, disagreements, decisions and action items, as "
          "paraphrases except where quotation marks are used; some source notes are Otter.ai or Zoom "
          "AI summaries. Who is named depends on who took the notes.")

_SEP = re.compile(r"\s*(?:,|;|&|/|\band\b)\s*")
_PAREN = re.compile(r"\(([^()]{1,80})\)")
_OWNER = re.compile(r"^([^:()]{1,60}):\s+\S")
# Words in double quotes (straight or curly), or in single quotes that are not apostrophes: a quote
# opens after a non-letter and closes before one, and may hold apostrophes between letters (we're).
_QUOTED = re.compile(r"\"([^\"]{2,})\"|“([^”]{2,})”|(?<![\w’'])'((?:[^']|(?<=\w)'(?=\w)){2,}?)'(?![\w])")


def _fold(text: str) -> str:
    """Case- and accent-blind form of a name, for matching only."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().casefold().strip()


def _first(name: str) -> str:
    return _fold(name.split()[0]) if name.split() else ""


def _family(name: str) -> set[str]:
    """The words of a name after the first ("Melissa Kline Struhl" -> kline, struhl)."""
    return {_fold(w) for w in re.sub(r"\(.*?\)", "", name).split()[1:]}


def _digest(*parts: str, n: int = 10) -> str:
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:n]


class People:
    """Everyone the notes name as a speaker, and the way from a first name back to one of them."""

    def __init__(self, meetings: list[dict]):
        self.everyone = sorted({s.strip() for m in meetings for s in m.get("speakers") or [] if s.strip()})
        self.first_names = {_first(s) for s in self.everyone} | {_fold(n) for n in NICKNAMES}
        firsts = sorted({s.split()[0] for s in self.everyone if s.split()} | set(NICKNAMES), key=len, reverse=True)
        lasts = sorted({w for s in self.everyone for w in re.sub(r"\(.*?\)", "", s).split()[1:]}, key=len, reverse=True)
        self._mention = re.compile(r"(?<![\w-])(" + "|".join(map(re.escape, firsts)) + r")"
                                   r"(?:\s+(" + "|".join(map(re.escape, lasts)) + r"))?(?![\w-])") if firsts else None

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
        follows ("Erik Johnson to lead"). Possessives count ("Satra's email")."""
        if not self._mention:
            return []
        return [" ".join(w for w in m.groups() if w) for m in self._mention.finditer(text)]

    def resolve(self, token: str, here: list[str]) -> dict:
        """One name as the notes wrote it -> {as_written, name or None, basis}."""
        words = token.split()
        first = _fold(NICKNAMES.get(words[0], words[0]))
        last = _fold(words[-1]) if len(words) > 1 else ""

        def matching(pool):
            return [s for s in pool if _first(s) == first and (not last or last in _family(s))]

        local = matching(here)
        if len(local) == 1:
            return {"as_written": token, "name": local[0], "basis": "a speaker in this meeting"}
        everywhere = matching(self.everyone)
        if len(local) > 1:
            return {"as_written": token, "name": None,
                    "basis": "more than one speaker in this meeting: " + ", ".join(local)}
        if len(everywhere) == 1:
            return {"as_written": token, "name": everywhere[0],
                    "basis": "not in this meeting's speakers; the only person of that name in the notes"}
        if everywhere:
            return {"as_written": token, "name": None,
                    "basis": "not in this meeting's speakers, and several people in the notes have that name: "
                             + ", ".join(everywhere)}
        return {"as_written": token, "name": None, "basis": "no speaker in the notes has that name"}


def _names_in(text: str, people: People) -> list[tuple[str, str]] | None:
    """A run of names ("Satra, Holly", "Holly/Christina", "Nanthia via Satra") -> [(token, how)],
    else None. Every part must look like a name and at least one must be a speaker's, so "(NIH)",
    "(open)" or "EMBER:" attribute nothing; a name no speaker has is kept, and shows as unresolved."""
    via = re.split(r"\s+via\s+", text.strip())
    parts = [[t for t in _SEP.split(chunk) if t] for chunk in via]
    if len(parts) > 2 or not all(parts):
        return None
    tokens = [t for chunk in parts for t in chunk]
    if not (all(people.looks_like_name(t) for t in tokens) and any(people.is_known(t) for t in tokens)):
        return None
    out = [(t, "attributed") for t in parts[0]]
    return out + [(t, "relayed") for t in parts[1]] if len(parts) == 2 else out


def attributions(text: str, kind: str, people: People, here: list[str]) -> list[dict]:
    """Who a point is attributed to: the names in a parenthesis made only of names ("... (Satra)",
    "X (Satra) vs Y (Han)"), and for an action the owner named before a colon ("Jyl: agenda for
    Thursday"). Anyone else the sentence names ("Robert warned ...", "(Cheryl, John, Holly
    supportive)") is listed as named, a weaker tie: the text mentions them, which is not always the
    same as their having said it."""
    found, rest = [], text
    if kind == "action":
        owner = _OWNER.match(text)
        names = _names_in(owner.group(1), people) if owner else None
        if names:
            found += [(t, "owner") for t, _how in names]
            rest = rest[owner.end(1):]
    kept = []
    for paren in _PAREN.finditer(rest):
        names = _names_in(paren.group(1), people)
        if names:
            found += names
        else:
            kept.append(paren.group(0))
    rest = _PAREN.sub(" ", rest) + " " + " ".join(kept)    # names in other parentheses still count as named
    found += [(t, "named") for t in people.mentioned(rest)]
    out, seen = [], set()
    for token, how in found:
        resolved = people.resolve(token, here)
        key = resolved["name"] or token
        if key in seen:                 # one entry per person, the strongest tie first
            continue
        seen.add(key)
        out.append({**resolved, "how": how})
    return out


def quotes(text: str) -> list[str]:
    return [next(g for g in m.groups() if g) for m in _QUOTED.finditer(text)]


def build(meetings: list[dict], source: dict) -> dict:
    people = People(meetings)
    out_meetings, items = [], []
    tally, spoke, groups_of = defaultdict(Counter), Counter(), defaultdict(set)
    unresolved = Counter()
    for m in sorted(meetings, key=lambda m: (m.get("date") or "", m.get("group") or "", m.get("title") or "")):
        group = m.get("group") or m.get("wg") or "Unknown group"
        mid = "m" + _digest(m.get("date") or "", group, m.get("title") or "", n=8)
        speakers = [s.strip() for s in m.get("speakers") or [] if s.strip()]
        for s in speakers:
            spoke[s] += 1
            groups_of[s].add(group)
        counts = {}
        for field, kind in KINDS:
            entries = [t.strip() for t in m.get(field) or [] if isinstance(t, str) and t.strip()]
            counts[kind] = len(entries)
            for n, text in enumerate(entries):
                who = attributions(text, kind, people, speakers)
                for w in who:
                    if w["name"] is None:
                        unresolved[w["as_written"]] += 1
                    else:
                        tally[w["name"]][w["how"]] += 1
                items.append({"id": "i" + _digest(mid, kind, text), "meeting": mid, "kind": kind, "n": n + 1,
                              "text": text, "who": who, "quotes": quotes(text)})
        out_meetings.append({
            "id": mid, "date": m.get("date"), "group": group, "as_named": m.get("wg") or group,
            "title": m.get("title") or "", "agenda": [a for a in m.get("agenda") or [] if a],
            "speakers": speakers, "note": m.get("source_note") or "", "counts": counts,
        })
    ids = Counter(i["id"] for i in items)
    dupes = {k for k, v in ids.items() if v > 1}
    for item in items:                                  # the same text twice in one meeting: number them
        if item["id"] in dupes:
            item["id"] = f"{item['id']}-{item['n']}"
    names = sorted(set(people.everyone) | set(tally))
    return {
        "kind": "bbqs-meetings", "version": 1, "source": source, "caveat": CAVEAT,
        "meetings": out_meetings,
        "items": items,
        "people": [{"name": n, "meetings": spoke[n], "groups": sorted(groups_of[n]),
                    "attributed": tally[n]["attributed"], "owns": tally[n]["owner"],
                    "named": tally[n]["named"] + tally[n]["relayed"]} for n in names],
        "unresolved": [{"as_written": t, "count": c} for t, c in unresolved.most_common()],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("notes", type=Path, help="the extracted meetings, a JSON list")
    parser.add_argument("--out", type=Path, required=True, help="where to write the records (outside the repo)")
    parser.add_argument("--describe", default="", help="where the notes came from, shown on the page")
    args = parser.parse_args(argv)
    raw = args.notes.read_bytes()
    meetings = json.loads(raw)
    if not isinstance(meetings, list) or not all(isinstance(m, dict) for m in meetings):
        parser.error(f"{args.notes} is not a JSON list of meetings")
    repo = Path(__file__).resolve().parent.parent
    try:
        args.out.resolve().relative_to(repo)
    except ValueError:
        pass
    else:
        parser.error(f"{args.out} is inside the repository; meeting notes are internal, write them elsewhere")
    source = {"file": args.notes.name, "sha256": hashlib.sha256(raw).hexdigest(), "meetings": len(meetings),
              "description": args.describe}
    doc = build(meetings, source)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    resolved = sum(1 for i in doc["items"] for w in i["who"] if w["name"])
    total = sum(len(i["who"]) for i in doc["items"])
    print(f"{len(doc['meetings'])} meetings, {len(doc['items'])} items, {total} attributions "
          f"({resolved} resolved to a full name), {sum(1 for i in doc['items'] if i['quotes'])} items quote someone; "
          f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
