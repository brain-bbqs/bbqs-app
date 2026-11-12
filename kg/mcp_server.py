#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp==2.3.0", "rdflib==7.6.0"]
# ///
"""BBQS knowledge graph over MCP: read-only traversal of the exported graph, held in memory.

One file, one job. It loads the Turtle the exporter writes (kg/export.py) and answers graph
questions over MCP. There is no database behind it, no edge function, no credential and no write
path: all it can do is read a graph it was handed.

    python kg/mcp_server.py                      # stdio: Claude Desktop, Claude Code, Cursor, ...
    python kg/mcp_server.py --http --port 8000   # streamable HTTP at /mcp, for a hosted endpoint
    python kg/mcp_server.py --check              # load the graph, print what it holds, exit
    uv run kg/mcp_server.py                      # same, the header above supplies the dependencies

Where the graph comes from (--source or BBQS_KG_SOURCE, a path or a URL): by default the copy the
site publishes on every deploy and once a day, falling back to the export committed next to this
file. It is re-read every --refresh hours, and describe_graph says which copy is being served and
from when, so a stale answer is visible instead of silent.

The traversal view. Nodes are the typed resources in the graph; a link is a triple between two of
them. Two things are done so that a hop means something:
  * a ProjectRole record (one grant-roster row) becomes ONE `has_role` link from the person to the
    project, carrying the role, instead of a node sitting in the middle;
  * an outside identifier that two or more nodes carry (the same ORCID iD on an investigator and
    in a paper's author list) becomes a node, so that match can be walked.
sparql_query sees the graph exactly as exported, without either.

How "related" is decided. find_related and find_paths rank by spreading activation, the account in
psychology of how one idea brings up another: activation leaves the starting node along every link,
each node it reaches splits what it received equally among the nodes it is linked to, and amounts
that arrive together add up. Nodes are still listed nearest first, as get_neighbors lists them; the
rule decides the order among nodes equally far away, and gives the number shown. Three steps of
arithmetic with nothing to tune: KG._wave is the rule, KG.paths applies the same division to one
path at a time, and kg/README.md works an example by hand.
"""
import argparse
import bisect
import contextvars
import functools
import heapq
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from datetime import time as clock_time
from decimal import ROUND_HALF_UP, Context, Decimal
from email.utils import parsedate_to_datetime
from fractions import Fraction
from pathlib import Path
from typing import Annotated, Any, NamedTuple
from typing import Literal as OneOf

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import RDF
from rdflib.plugins.sparql import prepareQuery
from rdflib.plugins.sparql.parserutils import CompValue
from rdflib.util import guess_format

__version__ = "0.2.0"

HERE = Path(__file__).resolve().parent
BUNDLED_EXPORT = HERE / "export" / "bbqs.ttl"
SCHEMA_FILE = HERE / "bbqs.owl.ttl"                      # definitions of classes and properties, if at hand
PUBLISHED_EXPORT = "https://brain-bbqs.org/kg/bbqs.ttl"  # written by .github/workflows/publish.yml
SCHEMA_NS = "https://brain-bbqs.org/schema#"
ID_NS = "https://brain-bbqs.org/id/"
PREFIXES = {"bbqs": SCHEMA_NS, "bid": ID_NS, "rdf": str(RDF), "xsd": "http://www.w3.org/2001/XMLSchema#"}

# The schema terms this file knows by name. test_mcp_server.py checks each one against
# bbqs.owl.ttl, so a renamed slot fails a test instead of quietly emptying a tool's answers.
LABEL_PREDICATES = ("name", "title", "label", "common_name", "model_name")  # as kg/quality.py
IDENTIFIER_PREDICATES = ("grant_number", "reporter_project_num", "fon", "doi", "pmid", "orcid",
                         "category_key", "aliases")
PROJECT_LABEL = ("Project", "grant_number", "title")  # a project is shown as "<number> · <title>"
CAREER_LABEL = "consortium_role"  # free text on a person; never a role on a project (issue #283)
# class -> how one of its records becomes a single link. `edge` is this view's own name for the
# link, not a schema term.
FOLDED = {
    "ProjectRole": {"edge": "has_role", "from": "held_by", "to": "on_project",
                    "attrs": {"role": "project_role", "role_source": "role_source"}},
}
EXTERNAL = "External"      # node type for an outside identifier shared by two or more nodes
UNRESOLVED = "Unresolved"  # ... and for an id of this graph that links point at but nothing describes

MIN_ID = 8               # shortest id shown; longer where two ids start alike
MAX_DEPTH = 4            # get_neighbors
HUB_LINKS = 30           # get_neighbors does not walk through a node with more links than this
MAX_HOPS = 8             # find_paths
MAX_SEEDS = 5            # find_related: starting nodes in one question
PATH_STEPS = 50_000      # find_paths stops exploring longer paths after this many steps
SHORTEST_STEPS = 50_000  # ... and listing the shortest ones after this many (a deep page can ask for many)
SPARQL_SECONDS = 10.0    # time budget for one sparql_query
MAX_ROWS = 1000
FETCH_SECONDS = 10
MAX_BYTES = 64 * 1024 * 1024


class KGError(ValueError):
    """Something the caller can fix: an unknown node, a bad argument, a rejected query. Its text is
    sent back as the tool's error, so it says what to do next."""


class _OutOfTime(Exception):
    pass


_deadline: contextvars.ContextVar = contextvars.ContextVar("sparql_deadline", default=None)


class _BudgetedGraph(Graph):
    """A Graph whose lookups stop once the running query's time budget is spent. rdflib has no
    query timeout, but every join step of its evaluator comes through triples(), which makes it
    the one place a runaway query (a cross product, an open-ended property path) can be stopped."""

    def triples(self, triple):
        deadline = _deadline.get()
        for found in super().triples(triple):
            if deadline is not None and time.monotonic() > deadline:
                raise _OutOfTime
            yield found


# ---- small helpers -------------------------------------------------------------------------------

def _local(iri: str) -> str:
    return iri.rsplit("#", 1)[-1] if "#" in iri else iri.rstrip("/").rsplit("/", 1)[-1]


def _plain(value: Literal):
    """A literal as a JSON value."""
    v = value.toPython()
    if isinstance(v, Literal):  # ill-typed, e.g. a sentence in an integer field: keep the text
        return str(v)
    if isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, (date, datetime, clock_time)):
        return v.isoformat()
    return str(v)


def _link_shown(link: "Link") -> dict:
    """One link as a reply shows it: its type, which way it points, and what its record carries."""
    return {"edge": link.edge, "direction": "out" if link.out else "in", **dict(link.attrs)}


def _fold(text) -> str:
    """Lower-case, accents removed: 'José' and 'jose' compare equal."""
    decomposed = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def _tokens(text) -> list[str]:
    return re.findall(r"[a-z0-9]+", _fold(text))


def _key(text) -> str:
    """How a name or identifier is compared when used as a node reference."""
    return " ".join(_fold(text).split())


def _clip(text: str, width: int) -> str:
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def _as_list(value) -> list[str]:
    """A list argument, however the client serialised it: a real array, a JSON string
    ('["a","b"]') or a comma string ("a, b")."""
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                value = json.loads(text)
            except (ValueError, RecursionError):           # not JSON, or bracketed past what it can read
                value = text.strip("[]").split(",")
        else:
            value = text.split(",")
    if not isinstance(value, (list, tuple, set)):
        value = [value]
    return [s for s in (str(v).strip().strip("\"'") for v in value) if s]


def _bounded(value, low: int, high: int, name: str) -> int:
    """A depth or hop count: out of range is an error, because clamping would change the question."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise KGError(f"{name} must be a whole number between {low} and {high}.") from None
    if not low <= number <= high:
        raise KGError(f"{name} must be between {low} and {high}.")
    return number


def _page(value, high: int, low: int = 1) -> int:
    """A page size or offset: clamped, since every reply says how many there are in all."""
    try:
        return min(max(int(value), low), high)
    except (TypeError, ValueError):
        raise KGError("limit and offset must be whole numbers.") from None


def _same(have, want) -> bool:
    """A stored value against one asked for: case and accents ignored, and 2025 equal to 2025.0."""
    if isinstance(want, float) and want.is_integer():
        want = int(want)
    return _key(have) == _key(want)


def _id_forms(value: str):
    """An identifier as written, and without the resolver in front of it, so both
    'https://orcid.org/0000-0002-1825-0097' and '0000-0002-1825-0097' find the node."""
    yield value
    bare = re.sub(r"^https?://(?:dx\.)?(?:doi\.org|orcid\.org)/", "", value, flags=re.I)
    if bare != value:
        yield bare


def _algebra_names(node) -> set[str]:
    """Every operator named anywhere in a parsed SPARQL query."""
    names, stack = set(), [node]
    while stack:
        current = stack.pop()
        if isinstance(current, CompValue):
            names.add(current.name)
            stack.extend(current.values())
        elif isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, (list, tuple, set, frozenset)):
            stack.extend(current)
    return names


_FOUR_DIGITS = Context(prec=4, rounding=ROUND_HALF_UP)


def _shown(strength: Fraction):
    """A strength as sent: a whole number as it is, anything else to four significant digits,
    rounded from the exact fraction (1/64 is 0.01563, as by hand). Ordering never uses this."""
    if strength.denominator == 1:
        return int(strength)
    return float(_FOUR_DIGITS.divide(Decimal(strength.numerator), Decimal(strength.denominator)))


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _committed(path: Path) -> str | None:
    """When a file was last committed, if git tracks it and it has no local changes. A checkout
    stamps every file with the time of the checkout, so the modification time of the committed
    export says when the repo was cloned, not how old the data in it is."""
    def git(*args):
        return subprocess.run(["git", "-C", str(path.parent), *args, "--", path.name],
                              capture_output=True, text=True, timeout=5)
    try:
        status = git("status", "--porcelain")
        if status.returncode or status.stdout.strip():
            return None
        return _iso(datetime.fromisoformat(git("log", "-1", "--format=%cI").stdout.strip()))
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


@functools.lru_cache(maxsize=1)
def _definitions() -> dict:
    """What the schema says each class and property means: name -> definition. Empty when the
    schema file is not next to this one (the server run from a URL), which costs the descriptions
    and nothing else."""
    try:
        schema = Graph().parse(str(SCHEMA_FILE), format="turtle")
    except Exception:
        return {}
    meaning = URIRef("http://www.w3.org/2004/02/skos/core#definition")
    return {str(s)[len(SCHEMA_NS):]: " ".join(str(o).split())
            for s, o in schema.subject_objects(meaning) if str(s).startswith(SCHEMA_NS)}


# ---- the traversal view --------------------------------------------------------------------------

@dataclass(frozen=True)
class Link:
    """One link, seen from one of its two ends."""
    edge: str
    out: bool           # True: this node --edge--> other.  False: other --edge--> this node.
    other: str          # IRI of the node at the other end
    attrs: tuple = ()   # ((name, value), ...) carried by a folded record, e.g. the role


@dataclass
class Node:
    iri: str
    type: str
    id: str = ""
    label: str = ""
    props: dict = field(default_factory=dict)   # property -> sorted list of values
    links: list = field(default_factory=list)   # every Link touching this node
    names: list = field(default_factory=list)   # its names and identifiers, as _key() forms
    near: dict = field(default_factory=dict)    # neighbour IRI -> the links to it, however many there are


class Reached(NamedTuple):
    """What the first wave of activation brings to one node (see KG._wave)."""
    hops: int                   # links from the starting node
    strength: Fraction          # how much arrives; 1 = a direct link
    routes: int                 # how many shortest routes brought it
    strongest: Fraction         # what the strongest single one of them brought


class KG:
    """An exported graph, indexed for traversal. Immutable once built: reloading builds a new one."""

    def __init__(self, graph: Graph, snapshot: dict | None = None):
        self.graph = graph
        self.snapshot = {**(snapshot or {}), "triples": len(graph)}
        self.problem: str | None = None                  # set by GraphSource when a re-read failed
        self.nodes: dict[str, Node] = {}
        self.edge_counts: Counter = Counter()            # (from type, edge, to type) -> links
        self.edge_attrs: dict = defaultdict(lambda: defaultdict(Counter))
        self.unfolded: Counter = Counter()               # folded-class records missing an end
        self.repeated: Counter = Counter()               # ... and with an end or a role given twice
        self.multityped = 0                              # nodes with more than one rdf:type
        self.blank = 0                                   # triples with a blank node at either end
        self._build()

    # -- construction --

    def _build(self):
        types: dict[str, set] = defaultdict(set)
        for s, o in self.graph.subject_objects(RDF.type):
            if isinstance(s, URIRef):
                types[str(s)].add(_local(str(o)))
        node_type = {iri: sorted(found)[0] for iri, found in types.items()}
        self.multityped = sum(1 for found in types.values() if len(found) > 1)   # filed under the first
        for s in self.graph.subjects():                  # a subject with facts but no rdf:type
            if isinstance(s, URIRef):
                node_type.setdefault(str(s), "Untyped")

        props: dict = defaultdict(lambda: defaultdict(list))
        triples = []                                      # between two nodes
        outside: dict = defaultdict(list)                 # outside IRI -> [(node, predicate)]
        for s, p, o in self.graph:
            if isinstance(s, BNode) or isinstance(o, BNode):
                self.blank += 1                           # not a node of this view: counted, not walked
            if p == RDF.type or not isinstance(s, URIRef):
                continue
            subject, predicate = str(s), _local(str(p))
            if isinstance(o, Literal):
                props[subject][predicate].append(_plain(o))
            elif isinstance(o, URIRef):
                if str(o) in node_type:
                    triples.append((subject, predicate, str(o)))
                else:                                     # an identifier, or a node that was not exported
                    props[subject][predicate].append(str(o))
                    outside[str(o)].append((subject, predicate))

        folded = {iri for iri, t in node_type.items() if t in FOLDED}
        for iri, t in node_type.items():
            if iri not in folded:
                self.nodes[iri] = Node(iri, t, props={k: sorted(v, key=str) for k, v in props[iri].items()})

        ends: dict = defaultdict(lambda: defaultdict(list))
        for subject, predicate, obj in triples:
            if subject in folded:
                ends[subject][predicate].append(obj)
            elif obj not in folded:
                self._link(subject, predicate, obj)
        for iri in sorted(folded):
            rule = FOLDED[node_type[iri]]
            sources, targets = ends[iri][rule["from"]], ends[iri][rule["to"]]
            # One record is one person on one project in one role. A record that gives either end,
            # or the role, more than once says two things at once: it is left out and counted.
            given = [len(sources) + len(props[iri].get(rule["from"], ())), len(targets) + len(props[iri].get(rule["to"], ()))]
            given += [len(props[iri].get(slot, ())) for slot in rule["attrs"].values()]
            if max(given) > 1:
                self.repeated[node_type[iri]] += 1
            elif sources and targets and sources[0] in self.nodes and targets[0] in self.nodes:
                attrs = tuple((name, str(props[iri][slot][0])) for name, slot in rule["attrs"].items()
                              if props[iri].get(slot))
                self._link(sources[0], rule["edge"], targets[0], attrs)
            else:
                self.unfolded[node_type[iri]] += 1

        for iri, references in sorted(outside.items()):
            holders = sorted({(node, predicate) for node, predicate in references if node in self.nodes})
            if len({node for node, _ in holders}) >= 2:
                missing = iri.startswith(ID_NS)           # one of this graph's own ids, with no node behind it
                self.nodes[iri] = Node(iri, UNRESOLVED if missing else EXTERNAL, id="" if missing else "ext:" + iri,
                                       label=iri)
                for node, predicate in holders:
                    self._link(node, predicate, iri)

        self._assign_ids()
        for node in self.nodes.values():
            if not node.label:
                node.label = self._label(node)
            if node.type not in (EXTERNAL, UNRESOLVED):   # those are reached by walking, or by their id
                node.names = sorted({_key(node.label)} | {
                    _key(form) for predicate in LABEL_PREDICATES + IDENTIFIER_PREDICATES
                    for value in node.props.get(predicate, ()) for form in _id_forms(str(value))})
        for node in self.nodes.values():
            node.links.sort(key=lambda l: (l.edge, not l.out, _fold(self.nodes[l.other].label), l.other, l.attrs))

        for node in self.nodes.values():                  # a link from a node to itself leads nowhere
            near: dict = defaultdict(list)
            for link in node.links:
                if link.other != node.iri:
                    near[link.other].append(link)
            node.near = {other: tuple(links) for other, links in near.items()}
        self.types = sorted({n.type for n in self.nodes.values()})
        self.edges = sorted({edge for _, edge, _ in self.edge_counts})
        self._by_name: dict = defaultdict(list)
        self._words: dict = defaultdict(dict)             # token -> {iri: (weight, property)}
        for node in self.nodes.values():
            for name in node.names:
                self._by_name[name].append(node)
            for predicate, values in node.props.items():
                weight = 3.0 if predicate in LABEL_PREDICATES + IDENTIFIER_PREDICATES else 1.0
                for value in values:
                    for token in _tokens(value):
                        if weight > self._words[token].get(node.iri, (0.0, ""))[0]:
                            self._words[token][node.iri] = (weight, predicate)
        self._vocabulary = sorted(self._words)

    def _link(self, source: str, edge: str, target: str, attrs: tuple = ()):
        self.nodes[source].links.append(Link(edge, True, target, attrs))
        self.nodes[target].links.append(Link(edge, False, source, attrs))
        self.edge_counts[(self.nodes[source].type, edge, self.nodes[target].type)] += 1
        for name, value in attrs:
            self.edge_attrs[edge][name][value] += 1

    def _assign_ids(self):
        """Short ids, git-style: the first MIN_ID characters of the id, or as many more as it takes
        to tell it from every other one. A node outside the id namespace is known by its IRI."""
        tails = sorted(iri[len(ID_NS):] for iri in self.nodes if iri.startswith(ID_NS))
        for i, tail in enumerate(tails):
            need = MIN_ID
            for other in tails[max(i - 1, 0): i] + tails[i + 1: i + 2]:
                same = next((n for n, (a, b) in enumerate(zip(tail, other)) if a != b), min(len(tail), len(other)))
                need = max(need, same + 1)
            self.nodes[ID_NS + tail].id = tail[:need]
        self._tails = sorted((tail.lower(), tail) for tail in tails)    # for a prefix, whatever its case
        for node in self.nodes.values():
            node.id = node.id or node.iri
        self._by_id = {node.id: node for node in self.nodes.values()}

    @staticmethod
    def _label(node: Node) -> str:
        def first(predicate):
            return next((str(v) for v in node.props.get(predicate, ())), None)

        plain = next((v for v in map(first, LABEL_PREDICATES) if v), node.id)
        kind, number, title = PROJECT_LABEL
        if node.type == kind and first(number):
            # resources.name holds the grant number on some projects and the title on others, so
            # every project is labelled the same way from the award facts (as kg/quality.py does).
            heading = first(title) or plain
            return f"{first(number)} · {heading}" if heading != first(number) else heading
        return plain

    # -- lookups --

    def resolve(self, reference) -> Node:
        """The node a reference names: an id from another tool, an IRI, or an exact name/identifier."""
        text = str(reference or "").strip().strip("<>")
        if not text:
            raise KGError("No node given. Pass an id from search_nodes, or an exact name or grant number.")
        if text.lower().startswith("ext:") and text[4:] in self.nodes:
            return self.nodes[text[4:]]
        tail = text[4:] if text.lower().startswith("bid:") else text
        for candidate in (text, ID_NS + tail):
            if candidate in self.nodes and self.nodes[candidate].type != EXTERNAL:
                return self.nodes[candidate]
        if tail in self._by_id and self._by_id[tail].type != EXTERNAL:   # an id as another tool showed it
            return self._by_id[tail]
        if re.fullmatch(r"[0-9a-f-]{6,}", tail.lower()):
            start = bisect.bisect_left(self._tails, (tail.lower(),))
            found = [t for folded, t in self._tails[start: start + 6] if folded.startswith(tail.lower())]
            if len(found) == 1:
                return self.nodes[ID_NS + found[0]]
            if found:
                raise KGError(f"'{reference}' is the start of more than one id: "
                              f"{self._listing(self.nodes[ID_NS + t] for t in found)}. Pass a longer id.")
        named = list({node.iri: node for form in _id_forms(text)
                      for node in self._by_name.get(_key(form), ())}.values())
        if len(named) == 1:
            return named[0]
        if named:
            raise KGError(f"'{reference}' names {len(named)} nodes: {self._listing(named)}. Pass one of these ids.")
        if text in self.nodes:   # an outside identifier no node owns, e.g. an author who is not a member
            return self.nodes[text]
        raise KGError(f"No node matches '{reference}'. Find it with search_nodes; it takes partial names.")

    def _listing(self, nodes, most: int = 8) -> str:
        nodes = sorted(nodes, key=lambda n: (n.type, _fold(n.label), n.id))
        shown = "; ".join(f"{n.id} ({n.type}: {_clip(n.label, 60)})" for n in nodes[:most])
        return shown + (f"; and {len(nodes) - most} more" if len(nodes) > most else "")

    def _pick(self, wanted, known, what: str):
        """Validate a list of type or edge names against the ones the graph has; None = no filter."""
        names = _as_list(wanted)
        if not names:
            if wanted is None or (isinstance(wanted, str) and wanted.strip() in ("", "[]"))                     or (isinstance(wanted, (list, tuple, set)) and not wanted):
                return None
            raise KGError(f"{_clip(repr(wanted), 60)} names no {what}. This graph has: {', '.join(known)}.")
        by_fold = {k.casefold(): k for k in known}
        missing = [n for n in names if n.casefold() not in by_fold]
        if missing:
            raise KGError(f"Unknown {what} '{missing[0]}'. This graph has: {', '.join(known)}.")
        return {by_fold[n.casefold()] for n in names}

    def brief(self, node: Node) -> dict:
        return {"id": node.id, "type": node.type, "label": _clip(node.label, 100), "links": len(node.links)}

    def status(self) -> dict:
        """Which copy of the graph this is and how old, so staleness shows in the answer."""
        status = dict(self.snapshot)
        dated = next((status[k] for k in ("last_modified", "committed", "file_modified") if k in status), None)
        if dated:
            written = datetime.strptime(dated, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            status["age_days"] = max((datetime.now(timezone.utc) - written).days, 0)
        if self.problem:
            status["preferred_source_failed"] = self.problem
        return status

    def cite(self) -> dict:
        """The short form of status(), carried by every answer so each one says where it came from."""
        status = self.status()
        dated = next((status[k] for k in ("last_modified", "committed", "file_modified") if k in status), None)
        cited = {"graph": status["source"], **({"dated": dated[:10], "age_days": status["age_days"]} if dated else {})}
        return {**cited, "preferred_source_failed": True} if self.problem else cited   # describe_graph says why

    def answered(self, reply: dict) -> dict:
        """A tool's answer, with the graph it came from under `snapshot` (as in describe_graph)."""
        if "snapshot" in reply:
            raise RuntimeError("an answer already uses the key 'snapshot'")
        return {**reply, "snapshot": self.cite()}

    # -- the tools --

    def describe(self, type=None, sparql: bool = True) -> dict:
        if type:
            return self._describe_type(type)
        by_type: dict = defaultdict(list)
        for node in self.nodes.values():
            by_type[node.type].append(node)
        node_types = []
        for name, group in sorted(by_type.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            filled = Counter(p for n in group for p in n.props)
            node_types.append({"type": name, "count": len(group),
                               "unlinked": sum(1 for n in group if not n.links),
                               "properties": dict(sorted(filled.items(), key=lambda kv: (-kv[1], kv[0])))})
        edge_types = []
        for (source, edge, target), count in sorted(self.edge_counts.items(), key=lambda kv: (-kv[1], kv[0])):
            row = {"edge": edge, "from": source, "to": target, "count": count}
            if edge in self.edge_attrs:
                row["carries"] = {name: dict(values.most_common()) for name, values in self.edge_attrs[edge].items()}
            edge_types.append(row)
        unlinked = sum(1 for n in self.nodes.values() if not n.links)
        notes = [
            f"A missing link means 'not recorded', never 'no'. This graph is still being linked: {unlinked} of "
            f"{len(self.nodes)} nodes have no links at all (see 'unlinked' per type), and each property count "
            "says how many nodes of that type have the property filled.",
        ]
        plain = next((e for (_, e, t), _ in self.edge_counts.most_common()
                      if e not in {r["edge"] for r in FOLDED.values()} and t not in (EXTERNAL, UNRESOLVED)), None)
        for kind, rule in FOLDED.items():
            if rule["edge"] not in self.edges:
                continue
            slots = "".join(f" ; bbqs:{slot} ?{name}" for name, slot in rule["attrs"].items())
            notes.append(
                f"{rule['edge']} is the grant roster: one link per person per project, carrying "
                f"{' and '.join(rule['attrs'])}. It is the only authority for a role on a project; {CAREER_LABEL} on "
                "a person is a free-text career or consortium label and says nothing about any one grant."
                + (f" In sparql_query the roster is still records, not links: ?r a bbqs:{kind} ; bbqs:{rule['from']} "
                   f"?person ; bbqs:{rule['to']} ?project{slots} ."
                   + (f" Every other link is a triple of the same name, e.g. ?a bbqs:{plain} ?b ." if plain else "")
                   if sparql else ""))
        notes.append(
            "find_related and find_paths rank by strength, which comes from spreading activation: activation leaves "
            "the starting node along every link, each node it reaches splits what it received equally among the nodes "
            "it is linked to, and amounts arriving together add up. A direct link is 1; one node with 5 neighbours in "
            "between leaves 0.2; two such routes make 0.4. Nearest first, then strongest: strength compares nodes the "
            "same distance away, and being a sum it can pass 1 where many routes arrive. It says how exclusive the "
            "nodes in between look in the data as recorded, so where links are still missing a tie can look stronger "
            "than it is.")
        if EXTERNAL in by_type:
            via = sorted({f"{source} -{edge}->" for (source, edge, target) in self.edge_counts if target == EXTERNAL})
            notes.append(f"{EXTERNAL} nodes are outside identifiers (such as ORCID iDs) that two or more nodes carry "
                         f"({', '.join(via)}), kept as nodes so the match can be walked. An identifier only one "
                         "node carries is just a property of it.")
        if UNRESOLVED in by_type:
            notes.append(f"{UNRESOLVED} nodes are ids of this graph that two or more links point at but nothing "
                         "describes: the node they name is missing from this export.")
        if self.unfolded:
            notes.append("Roster records left out because one end did not resolve: "
                         + ", ".join(f"{n} {t}" for t, n in self.unfolded.items()) + ".")
        if self.repeated:
            notes.append("Roster records left out because they give a person, a project or a role more than once: "
                         + ", ".join(f"{n} {t}" for t, n in self.repeated.items()) + ".")
        if self.multityped:
            notes.append(f"Nodes with more than one type: {self.multityped}. Each is listed under the first of its "
                         "types in alphabetical order.")
        if self.blank:
            notes.append(f"Triples with a blank node at one end: {self.blank}. A blank node is not a node here, so "
                         "they are not walked.")
        return {"graph": "BBQS consortium knowledge graph, public read-only snapshot", "snapshot": self.status(),
                "nodes": len(self.nodes), "links": sum(self.edge_counts.values()), "unlinked_nodes": unlinked,
                "node_types": node_types, "edge_types": edge_types, "notes": notes}

    def _describe_type(self, type) -> dict:
        """One node type in full: what the schema says it and its properties mean, how full each
        property is, the values it takes when they are few, and its links."""
        kind = next(iter(self._pick(type, self.types, "node type")))
        group = sorted((n for n in self.nodes.values() if n.type == kind), key=lambda n: (_fold(n.label), n.iri))
        meaning = _definitions()
        own = {EXTERNAL: "An outside identifier (such as an ORCID iD) that two or more nodes carry.",
               UNRESOLVED: "An id of this graph that links point at but nothing describes."}
        properties = []
        for name, filled in sorted(Counter(p for n in group for p in n.props).items(), key=lambda kv: (-kv[1], kv[0])):
            row = {"property": name, "filled": filled}
            if name in meaning:
                row["description"] = meaning[name]
            values = Counter(str(v) for n in group for v in n.props.get(name, ()))
            if len(values) <= 12 and all(len(v) <= 40 for v in values):
                row["values"] = dict(values.most_common())      # few enough to be a vocabulary: list it
            else:
                row["example"] = _clip(next(str(v) for n in group for v in n.props.get(name, ())), 60)
            properties.append(row)
        links = Counter((l.edge, l.out, self.nodes[l.other].type) for n in group for l in n.links)
        reply = {"type": kind, "count": len(group), "unlinked": sum(1 for n in group if not n.links)}
        if kind in meaning or kind in own:
            reply["description"] = meaning.get(kind) or own[kind]
        return {**reply, "properties": properties,
                "links": [{"edge": edge, "direction": "out" if out else "in", "other": other, "count": count}
                          for (edge, out, other), count in sorted(links.items(), key=lambda kv: (-kv[1], kv[0]))]}

    def search(self, query: str = "", type=None, where: dict | None = None, limit: int = 10, offset: int = 0) -> dict:
        limit, offset = _page(limit, 100), _page(offset, 10 ** 6, 0)
        kinds = self._pick(type, self.types, "node type")
        pool = [n for n in self.nodes.values() if kinds is None or n.type in kinds]
        if where:
            if not isinstance(where, dict):
                raise KGError('where must be an object of property -> value, e.g. {"mechanism": "R61"}.')
            for prop, wanted in where.items():
                if not any(prop in n.props for n in pool):
                    known = sorted({p for n in pool for p in n.props})
                    raise KGError(f"No {'/'.join(sorted(kinds)) if kinds else 'node'} has a property '{prop}'. "
                                  f"Properties: {', '.join(known)}.")
                pool = [n for n in pool if any(_same(v, wanted) for v in n.props.get(prop, ()))]
        terms = list(dict.fromkeys(_tokens(query)))
        if not terms:
            if kinds is None and not where:
                raise KGError("Give a query, a type, or a where filter.")
            ranked = [(n, None) for n in sorted(pool, key=lambda n: (_fold(n.label), n.iri))]
        else:
            ranked = self._rank(terms, {n.iri for n in pool} if (kinds is not None or where) else None)
        results = []
        for node, hit in ranked[offset: offset + limit]:
            row = self.brief(node)
            if hit:
                row["match"] = hit
            results.append(row)
        return {"total": len(ranked), "offset": offset, "results": results}

    def _rank(self, terms: list[str], allowed) -> list:
        """Nodes matching the query terms, best first. A term matches a word it equals or begins;
        rarer terms and matches in names count for more; a node matching every term outranks one
        matching some."""
        scores: Counter = Counter()
        matched: Counter = Counter()
        where_hit: dict = {}
        for term in terms:
            found: dict = {}
            start = bisect.bisect_left(self._vocabulary, term)
            for word in self._vocabulary[start:]:
                if not word.startswith(term):
                    break
                if word != term and len(term) < 3:
                    break
                closeness = 1.0 if word == term else 0.5
                for iri, (weight, prop) in self._words[word].items():
                    if (allowed is None or iri in allowed) and weight * closeness > found.get(iri, (0.0, ""))[0]:
                        found[iri] = (weight * closeness, prop)
            rarity = math.log(1 + len(self.nodes) / len(found)) if found else 0.0
            for iri, (strength, prop) in found.items():
                scores[iri] += strength * rarity
                matched[iri] += 1
                where_hit.setdefault(iri, (term, prop))
                if prop not in LABEL_PREDICATES + IDENTIFIER_PREDICATES:
                    where_hit[iri] = (term, prop)   # prefer showing a match the label does not reveal
        phrase = " ".join(terms)
        ranked = []
        for iri, score in scores.items():
            node = self.nodes[iri]
            score *= (matched[iri] / len(terms)) ** 2
            names = [" ".join(_tokens(name)) for name in node.names]
            if phrase in names:
                score += 1000
            elif any(name.startswith(phrase) for name in names):
                score += 50
            elif any(phrase in name for name in names):
                score += 25
            ranked.append((-score, -len(node.links), _fold(node.label), iri))
        ranked.sort()
        return [(self.nodes[iri], self._excerpt(self.nodes[iri], *where_hit[iri])) for _, _, _, iri in ranked]

    @staticmethod
    def _excerpt(node: Node, term: str, prop: str):
        """Where a search matched, when the label does not already show it."""
        if term in _fold(node.label):
            return None
        for value in node.props.get(prop, ()):
            text = str(value)
            at = _fold(text).find(term)
            if at >= 0:
                at = min(at, len(text))
                start, end = max(at - 60, 0), min(at + 90, len(text))
                return {"property": prop, "text": ("…" if start else "") + " ".join(text[start:end].split())
                        + ("…" if end < len(text) else "")}
        return {"property": prop}

    def node(self, reference, edge_limit: int = 25) -> dict:
        edge_limit = _page(edge_limit, 500, 0)
        node = self.resolve(reference)
        groups: dict = defaultdict(list)
        for link in node.links:
            groups[(link.edge, link.out)].append(link)
        edges = []
        for (edge, out), links in sorted(groups.items(), key=lambda kv: (kv[0][0], not kv[0][1])):
            row = {"edge": edge, "direction": "out" if out else "in", "count": len(links),
                   "nodes": [{**self.brief(self.nodes[l.other]), **dict(l.attrs)} for l in links[:edge_limit]]}
            if len(links) > edge_limit:
                row["more"] = len(links) - edge_limit
            edges.append(row)
        return {"id": node.id, "iri": node.iri, "type": node.type, "label": node.label,
                "properties": {k: v[0] if len(v) == 1 else v for k, v in sorted(node.props.items())},
                "links": len(node.links), "edges": edges}

    def neighbors(self, reference, edge=None, direction: str = "both", type=None, depth: int = 1,
                  limit: int = 50, offset: int = 0, through_hubs: bool = False) -> dict:
        start = self.resolve(reference)
        follow = self._pick(edge, self.edges, "edge")
        kinds = self._pick(type, self.types, "node type")
        if direction not in ("out", "in", "both"):
            raise KGError("direction must be out, in or both.")
        depth, limit, offset = _bounded(depth, 1, MAX_DEPTH, "depth"), _page(limit, 200), _page(offset, 10 ** 6, 0)
        # A hub is reached like any node but not walked through: two hops from a person would
        # otherwise be everyone in the same working group. Naming the edges to follow, or asking
        # for it, walks through; the node the walk starts from is always expanded.
        stop_at_hubs = follow is None and not through_hubs
        seen, reached, frontier, hubs = {start.iri}, [], [start], []
        for hop in range(1, depth + 1):
            arrived = []
            for current in frontier:
                if stop_at_hubs and current is not start and len(current.links) > HUB_LINKS:
                    hubs.append(current)
                    continue
                for link in current.links:
                    if (follow is not None and link.edge not in follow) or link.other in seen \
                            or (direction == "out" and not link.out) or (direction == "in" and link.out):
                        continue
                    seen.add(link.other)
                    arrived.append(self.nodes[link.other])
                    reached.append((hop, link, current, self.nodes[link.other]))
            frontier = arrived
        by_type = dict(Counter(r[3].type for r in reached).most_common())
        if kinds is not None:
            reached = [r for r in reached if r[3].type in kinds]
        reached.sort(key=lambda r: (r[0], r[1].edge, r[3].type, _fold(r[3].label), r[3].iri))
        nodes = []
        for hop, link, via, node in reached[offset: offset + limit]:
            step = {"edge": link.edge, "direction": "out" if link.out else "in", **dict(link.attrs)}
            if via is not start:
                step["from"] = via.id
            nodes.append({**self.brief(node), "hops": hop, "via": step})
        reply = {"start": self.brief(start), "depth": depth, "total": len(reached), "offset": offset,
                 "reached_by_type": by_type, "nodes": nodes}
        if hubs:
            reply["hubs_not_walked_through"] = [self.brief(hub) for hub in hubs]
        return reply

    # -- spreading activation: what find_related and find_paths rank by --

    def _ways(self, avoid=frozenset()):
        """For one question: which neighbours a node passes activation to, as node -> {neighbour: the
        links that lead there}. Two nodes are one neighbour to each other however many links record
        it. `avoid` names link types that are not travelled; a neighbour reached only by those is
        not passed to, and the node splits among the neighbours left."""
        if not avoid:
            return lambda iri: self.nodes[iri].near
        kept: dict = {}

        def ways(iri: str) -> dict:
            if iri not in kept:
                kept[iri] = {other: allowed for other, links in self.nodes[iri].near.items()
                             if (allowed := tuple(link for link in links if link.edge not in avoid))}
            return kept[iri]
        return ways

    def _wave(self, start: Node, avoid=frozenset(), ways=None) -> dict:
        """The first wave of activation spreading from `start`: iri -> Reached, for every node it
        gets to. Three rules, each from the published theory of how one concept brings up another:
          * it travels one link at a time, so what is nearer is reached sooner;
          * a node splits what it received equally among the nodes it is linked to (the fan
            effect): a project with 5 neighbours passes 1/5 to each, a working group of 114
            members 1/114;
          * amounts that arrive at a node together add up.
        The start sends one whole unit to each neighbour, so that a direct link is 1. A node is read
        once, when the wave first reaches it, so only the shortest routes count:
        strength = the sum, over the shortest routes from `start`, of the product of 1/neighbours
        over the nodes in between. It is the same from either end, and it is worked in exact
        fractions, so equal things tie exactly and nothing is ordered by rounding.
        Without the name: a breadth-first search that carries one number, the chance that a random
        walker leaving `start` stands on the node after as many steps as it is links away, times the neighbours of
        `start`. Two links out it is the Resource Allocation index of link prediction."""
        ways = ways or self._ways(avoid)
        reached = {start.iri: Reached(0, Fraction(1), 1, Fraction(1))}
        ring, hops = [start.iri], 0
        while ring:
            hops += 1
            arriving: dict = {}                    # iri -> [strength, routes, strongest]
            for iri in ring:
                here, out = reached[iri], ways(iri)
                share = Fraction(1, 1 if iri == start.iri else len(out))
                amount, best = here.strength * share, here.strongest * share
                for other in out:
                    if other in reached:
                        continue
                    entry = arriving.get(other)
                    if entry is None:
                        arriving[other] = [amount, here.routes, best]
                    else:
                        entry[0] += amount
                        entry[1] += here.routes
                        entry[2] = max(entry[2], best)
            reached.update((iri, Reached(hops, *entry)) for iri, entry in arriving.items())
            ring = list(arriving)
        return reached

    @staticmethod
    def _strongest_route(start: str, end: str, wave: dict, ways) -> list:
        """The strongest of the shortest routes from `start` to `end`, as [iri, ...], from the wave
        of `start`. Of several equally strong it is the one find_paths lists first: the first by
        its nodes, read from whichever end has the smaller IRI. So both tools show the same route,
        and the same one whichever end the question started from."""
        def passed_on(iri: str) -> Fraction:       # by a node on a strongest route to it, to each neighbour
            return wave[iri].strongest if iri == start else wave[iri].strongest / len(ways(iri))

        def came_from(iri: str) -> list:           # the nodes a strongest route can reach `iri` from
            return sorted(other for other in ways(iri) if other in wave and wave[other].hops == wave[iri].hops - 1
                          and passed_on(other) == wave[iri].strongest)

        if end < start:                            # read from `end`: the first choice at every step
            route = [end]
            while route[-1] != start:
                route.append(came_from(route[-1])[0])
            return route[::-1]
        onward: dict = defaultdict(list)           # read from `start`: find every strongest route first
        seen, todo = {end}, [end]
        while todo:
            iri = todo.pop()
            for other in came_from(iri):
                onward[other].append(iri)
                if other not in seen:
                    seen.add(other)
                    todo.append(other)
        route = [start]
        while route[-1] != end:
            route.append(min(onward[route[-1]]))
        return route

    def related(self, references, type=None, limit: int = 5, offset: int = 0, avoid_edges=None,
                max_hops: int = 4) -> dict:
        seeds = self._seeds(references)
        kinds = self._pick(type, self.types, "node type")
        avoid = self._pick(avoid_edges, self.edges, "edge") or set()
        # Every type at once is many lists, so each is kept shorter than when a few are named.
        limit, offset = _page(limit, 25 if kinds and len(kinds) <= 3 else 10), _page(offset, 10 ** 6, 0)
        max_hops = _bounded(max_hops, 1, MAX_HOPS, "max_hops")
        ways = self._ways(avoid)
        waves = [self._wave(seed, ways=ways) for seed in seeds]
        started = {seed.iri for seed in seeds}
        # Each type is ranked on its own: a working group collects activation from a hundred
        # members and a paper from one project, so one list of both mostly ranks them by size.
        ranked: dict = {kind: [] for kind in kinds or ()}       # a type asked for and not reached is listed, empty
        beyond: Counter = Counter()                             # per type: reached, but farther than max_hops
        within = 0
        for iri in waves[0]:
            if iri in started or not all(iri in wave for wave in waves[1:]):
                continue                                         # with several starting nodes: only what each reaches
            node = self.nodes[iri]
            # A node is judged by its worst tie: the farthest starting node, and of those the
            # weakest. Then by its next worst, and so on. With one starting node that is: nearest
            # first, then strongest.
            ties = tuple(sorted(((wave[iri].hops, -wave[iri].strength) for wave in waves), reverse=True))
            within += ties[0][0] <= max_hops
            if kinds is not None and node.type not in kinds:
                continue
            rows = ranked.setdefault(node.type, [])
            if ties[0][0] > max_hops:
                beyond[node.type] += 1
            else:
                rows.append((ties, _fold(node.label), iri))
        groups = []
        for rows in ranked.values():
            rows.sort()
        for kind, rows in sorted(ranked.items(), key=lambda kv: (not kv[1], kv[1][0][0] if kv[1] else (), kv[0])):
            page = rows[offset: offset + limit]
            group = {"type": kind, "within": len(rows),
                     "nodes": [self._related_row(seeds, waves, row[2], ways) for row in page]}
            if page and len(rows) > offset + limit and rows[offset + limit][0] == page[-1][0]:
                level = page[-1][0]                              # the list was cut among equals: say how many
                group["tied"] = {"hops": level[0][0], "strength": _shown(-level[0][1]),
                                 "count": sum(1 for row in rows if row[0] == level),
                                 "listed": sum(1 for row in page if row[0] == level)}
            if beyond[kind]:
                group["beyond"] = beyond[kind]
            groups.append(group)
        reply = {"start": [self.brief(seed) for seed in seeds], "related": groups}
        without = f" without {', '.join(sorted(avoid))}" if avoid else ""
        if avoid:
            reply["avoided"] = sorted(avoid)
        alone = [seed for seed, wave in zip(seeds, waves) if len(wave) == 1]
        apart = [seed for seed in seeds[1:] if seed.iri not in waves[0]]
        if alone:
            # A link from a node to itself leads nowhere, so a node with only such links is alone too.
            others = "other nodes" if any(seed.links and not seed.near for seed in alone) else ""
            reply["note"] = (f"No links{' to ' + others if others else ''}{without} are recorded for "
                             f"{self._listing(alone)}, so nothing is tied to {'it' if len(alone) == 1 else 'them'}. "
                             "A missing link means 'not recorded'.")
        elif apart:
            reply["note"] = (f"No chain of links{without} joins {self._listing(seeds[:1])} and "
                             f"{self._listing(apart)}, so nothing is tied to all of them.")
        elif not within:                           # one starting node always has a neighbour within one link
            reply["note"] = (f"Nothing is within {max_hops} link{'' if max_hops == 1 else 's'}{without} of every one "
                             "of these nodes.")
        return reply

    def _seeds(self, references) -> list:
        """The starting nodes of find_related: one reference, or several however the client sent
        them. A name may hold a comma, so a string is split only if it is not a node as it stands."""
        if isinstance(references, str):
            text = references.strip()
            try:
                references = [self.resolve(text)]
            except KGError as whole:
                parts = _as_list(text)                           # a list in one string: split at the commas
                if parts in ([], [text]):
                    raise
                references, failed, named = [], None, None
                for part in parts:
                    try:
                        references.append(self.resolve(part))
                    except KGError as this_part:
                        failed = failed or this_part
                        if not str(this_part).startswith("No node matches"):
                            named = named or this_part           # it names nodes, only not one alone
                if named and len(parts) == 1:
                    raise named from None                        # one name, quoted or bracketed: what it names
                if failed and not references and not named:
                    raise whole from None                        # no part of it is a node either
                if failed:                                       # some of it is: say which part is not
                    raise KGError(f"Read as {len(parts)} nodes. {named or failed}") from None
        elif not isinstance(references, (list, tuple)):
            references = [references]
        nodes = [r if isinstance(r, Node) else self.resolve(r) for r in references]
        seeds = list({node.iri: node for node in nodes}.values())
        if not seeds:
            raise KGError("No node given. Pass an id from search_nodes, or an exact name or grant number.")
        if len(seeds) > MAX_SEEDS:
            raise KGError(f"{len(seeds)} starting nodes given; at most {MAX_SEEDS} at a time.")
        return seeds

    def _related_row(self, seeds: list, waves: list, iri: str, ways) -> dict:
        node = self.nodes[iri]
        if len(seeds) == 1:
            return {**self.brief(node), **self._tie(seeds[0], waves[0], iri, ways)}
        # Several starting nodes: the row is headed by its worst tie, and `per_start` gives each one.
        # The routes are not spelled out here (find_paths gives them for any pair).
        per_start = [{"start": seed.id, "hops": wave[iri].hops, "strength": _shown(wave[iri].strength),
                      **({"routes": wave[iri].routes} if wave[iri].routes > 1 else {})} for seed, wave in zip(seeds, waves)]
        worst = max((wave[iri] for wave in waves), key=lambda found: (found.hops, -found.strength))
        return {**self.brief(node), "hops": worst.hops, "strength": _shown(worst.strength), "per_start": per_start}

    def _tie(self, seed: Node, wave: dict, iri: str, ways) -> dict:
        """How one starting node reaches one node: how far, how strongly, and mostly by which route."""
        found = wave[iri]
        tie = {"hops": found.hops, "strength": _shown(found.strength)}
        if found.routes > 1:                       # `share`: the part of the strength the route shown brings
            tie.update(routes=found.routes, share=_shown(found.strongest / found.strength))
        if found.hops == 1:
            first, *others = ways(seed.iri)[iri]
            tie["link"] = _link_shown(first)
            if others:                             # more than one link joins the two: still one tie
                tie["link"]["also"] = [_link_shown(link) for link in others]
            return tie
        # `splits`: how many neighbours the node divided among, so 1/splits, multiplied along the
        # route, is the route's strength.
        tie["through"] = [{"id": self.nodes[at].id, "label": _clip(self.nodes[at].label, 40), "splits": len(ways(at))}
                          for at in self._strongest_route(seed.iri, iri, wave, ways)[1:-1]]
        return tie

    def paths(self, source, target, max_hops: int = 6, limit: int = 5, avoid_edges=None, offset: int = 0) -> dict:
        a, b = self.resolve(source), self.resolve(target)
        max_hops, limit = _bounded(max_hops, 1, MAX_HOPS, "max_hops"), _page(limit, 25)
        offset = _page(offset, 10 ** 6, 0)
        avoid = self._pick(avoid_edges, self.edges, "edge") or set()
        reply = {"source": self.brief(a), "target": self.brief(b), "listed": 0, "paths": []}
        if a is b:
            return {**reply, "note": "source and target are the same node."}
        ways = self._ways(avoid)
        # Always searched from the same end, whichever way round the question was asked, so that
        # the answer is the same list both ways, cut in the same place.
        first, last = sorted((a, b), key=lambda node: node.iri)
        wave = self._wave(last, ways=ways)        # from the far end: how far each node is from it, how strongly tied
        without = f" without {', '.join(sorted(avoid))}" if avoid else ""
        if first.iri not in wave:
            return {**reply, "note": f"Not connected{without}: no chain of links joins these two nodes."}
        tie = wave[first.iri]
        reply.update(shortest=tie.hops, routes=tie.routes, strength=_shown(tie.strength))
        if tie.hops > max_hops:
            return {**reply, "note": f"The shortest connection{without} is {tie.hops} hops; max_hops is {max_hops}."}
        want = offset + limit + 1                 # one more than asked for, to know whether there are more
        found = self._strongest_shortest(first.iri, last.iri, wave, ways, want)
        cut = len(found) < min(want, tie.routes)  # the budget ran out before the shortest paths asked for
        steps_left, length, searched = [PATH_STEPS], tie.hops, False
        # Then the longer ones, a length at a time. Between two nodes that are linked there are
        # none: any other way from one to the other is the long way round that link.
        while not cut and tie.hops > 1 and len(found) < want and length < max_hops:
            searched = True
            if steps_left[0] <= 0:
                break
            length += 1
            level: list = []
            self._walk(first.iri, last.iri, length, wave, ways, [first.iri], level, steps_left)
            found.extend(sorted(((self._left(path, ways), path) for path in level), key=lambda one: (-one[0], one[1])))
        page = found[offset: offset + limit]
        reply.update(listed=len(page), paths=[self._path(path if first is a else path[::-1], strength, ways)
                                              for strength, path in page])
        if len(found) > offset + limit or cut:
            reply["more"] = True
        if cut or (searched and steps_left[0] <= 0):  # gave up: some paths may be missing, or out of order
            reply["partial"] = True
        return reply

    @staticmethod
    def _left(path: list, ways) -> Fraction:
        """What is left of one unit after each node between the two ends has split it among its
        neighbours. The shortest paths' strengths add up to the strength of the tie (see _wave)."""
        left = Fraction(1)
        for iri in path[1:-1]:
            left /= len(ways(iri))
        return left

    @staticmethod
    def _strongest_shortest(first: str, last: str, wave: dict, ways, want: int) -> list:
        """The `want` strongest of the shortest paths from `first` to `last`, strongest first, as
        (strength, [iri, ...]), without listing them all: there can be thousands. `wave` is the
        wave from `last`, which says of every node how far it is from `last` and how strong the
        strongest route onward is. So the best a partly built path can still become is known
        exactly, and paths are finished in order of strength. Equally strong ones come in the
        order of their nodes. It stops after SHORTEST_STEPS paths begun, which only a page far down
        a list of a great many paths can reach; the caller then says the answer is partial."""
        heap = [(-wave[first].strongest, (first,), Fraction(1))]
        found, budget = [], SHORTEST_STEPS
        while heap and len(found) < want and budget > 0:
            _, trail, so_far = heapq.heappop(heap)       # so_far: what the nodes between `first` and the last one left
            here = trail[-1]
            if here == last:
                found.append((so_far, list(trail)))
                continue
            passed = so_far if here == first else so_far / len(ways(here))
            for other in ways(here):
                if other in wave and wave[other].hops == wave[here].hops - 1:
                    best = passed if other == last else passed * wave[other].strongest / len(ways(other))
                    heapq.heappush(heap, (-best, trail + (other,), passed))
                    budget -= 1
        return found

    def _walk(self, current, target, remaining, wave, ways, trail, out, steps_left):
        """Every path of exactly `remaining` more links from `current` to `target` that takes no
        detour: no node on it is linked to an earlier one except the one just before it. A path
        with such a shortcut is a shorter path plus padding, and says nothing the shorter one
        does not."""
        if remaining == 0:
            out.append(list(trail))
            return
        for nxt in ways(current):
            if steps_left[0] <= 0:
                return
            if nxt in trail or nxt not in wave or wave[nxt].hops > remaining - 1 \
                    or (nxt == target and remaining != 1) \
                    or any(earlier in ways(nxt) for earlier in trail[:-1]):
                continue
            steps_left[0] -= 1
            trail.append(nxt)
            self._walk(nxt, target, remaining - 1, wave, ways, trail, out, steps_left)
            trail.pop()

    def _path(self, path: list, strength: Fraction, ways) -> dict:
        def show(iri):
            return f'{self.nodes[iri].type} "{_clip(self.nodes[iri].label, 70)}"'

        def named(links):
            return " + ".join(link.edge + "".join(f" {value}" for name, value in link.attrs if name == "role")
                              for link in links)

        text = show(path[0])
        for here, nxt in zip(path, path[1:]):
            links = ways(here)[nxt]                # usually one; all of them are named, each the way it points
            forth, back = [link for link in links if link.out], [link for link in links if not link.out]
            arrows = ([f"-[{named(forth)}]->"] if forth else []) + ([f"<-[{named(back)}]-"] if back else [])
            text += f" {' / '.join(arrows)} " + show(nxt)
        return {"hops": len(path) - 1, "strength": _shown(strength), "text": text,
                "nodes": [self.nodes[iri].id for iri in path]}

    def sparql(self, query: str, limit: int = 100) -> dict:
        limit = _page(limit, MAX_ROWS)
        text = re.sub(r"\bbid:([0-9a-fA-F][0-9a-fA-F-]*)", self._full_id, str(query))
        try:
            prepared = prepareQuery(text, initNs=PREFIXES)
        except Exception as exc:  # pyparsing's ParseException and rdflib's own; the message is the useful part
            raise KGError("Not accepted. Only SPARQL SELECT and ASK queries run here: "
                          + " ".join(str(exc).split())[:300]) from exc
        algebra = prepared.algebra
        if algebra.name not in ("SelectQuery", "AskQuery"):
            raise KGError("Read-only: only SELECT and ASK queries run here.")
        if algebra.get("datasetClause") or "ServiceGraphPattern" in _algebra_names(algebra):
            raise KGError("FROM and SERVICE are not accepted: a query runs against the loaded graph only.")
        budget = _deadline.set(time.monotonic() + SPARQL_SECONDS)
        try:
            result = self.graph.query(prepared)
            if result.type == "ASK":
                return {"answer": bool(result.askAnswer)}
            rows, more = [], False
            for row in result:
                if len(rows) == limit:
                    more = True
                    break
                rows.append([self._cell(cell) for cell in row])
        except _OutOfTime:
            raise KGError(f"Stopped after {SPARQL_SECONDS:g} seconds. Narrow the query: anchor a variable to a "
                          "class or a known node, and avoid unbounded * and + paths.") from None
        except Exception as exc:
            raise KGError("Query failed: " + " ".join(str(exc).split())[:300]) from exc
        finally:
            _deadline.reset(budget)
        reply = {"columns": [str(v) for v in result.vars], "rows": rows}
        if more:
            reply["more"] = True
        return reply

    def _full_id(self, match) -> str:
        """`bid:<short id>` in a query, written out as the IRI it stands for."""
        tail = match.group(1)
        if ID_NS + tail in self.nodes or len(tail) >= 36:
            return match.group(0)
        return f"<{self.resolve(match.group(0)).iri}>"

    def _cell(self, term):
        if term is None or isinstance(term, Literal):
            return None if term is None else _plain(term)
        if isinstance(term, BNode):
            return f"_:{term}"
        iri = str(term)
        if iri in self.nodes and iri.startswith(ID_NS):
            return "bid:" + self.nodes[iri].id
        for prefix, namespace in PREFIXES.items():
            if prefix != "bid" and iri.startswith(namespace) and re.fullmatch(r"\w+", iri[len(namespace):]):
                return f"{prefix}:{iri[len(namespace):]}"
        return f"<{iri}>"


# ---- where the graph comes from ------------------------------------------------------------------

class GraphSource:
    """Reads the graph, and reads it again when it has changed. Serves one KG at a time; a failed
    re-read keeps the one already loaded and records why in `problem`."""

    def __init__(self, location: str | None = None, refresh_hours: float = 1.0):
        self.locations = [location] if location else (
            [PUBLISHED_EXPORT] + ([str(BUNDLED_EXPORT)] if BUNDLED_EXPORT.exists() else []))
        self.refresh_seconds = refresh_hours * 3600 if refresh_hours and refresh_hours > 0 else None
        self.problem: str | None = None
        self._kg: KG | None = None
        self._seen: dict = {}      # location -> ETag, or (mtime, size): what was last read from it
        self._due = 0.0
        self._lock = threading.Lock()

    def current(self) -> KG:
        with self._lock:
            if self._kg is None or (self.refresh_seconds is not None and time.monotonic() >= self._due):
                self._read_all()
                self._due = time.monotonic() + (self.refresh_seconds or 0)
            self._kg.problem = self.problem
            return self._kg

    def _read_all(self):
        problems = []
        for location in self.locations:
            try:
                fresh = self._read(location)
            except Exception as exc:  # unreachable, an HTTP error, not Turtle: fall through to the next
                problems.append(f"{self._shown(location)}: {' '.join(str(exc).split())[:200] or type(exc).__name__}")
                continue
            if fresh is not None and self._kg is not None and len(fresh.nodes) * 2 < len(self._kg.nodes):
                # An export taken while the database was half reachable still parses. Losing most
                # of the graph between two reads is treated as a failed read, not as news.
                problems.append(f"{self._shown(location)}: holds {len(fresh.nodes)} nodes, under half of the "
                                f"{len(self._kg.nodes)} being served, so it was not taken")
                continue
            if fresh is not None:
                self._kg = fresh
            break
        self.problem = "; ".join(problems) or None
        if self._kg is None:
            raise KGError("No knowledge graph could be loaded. " + (self.problem or "No source is configured."))

    def _read(self, location: str) -> KG | None:
        """The graph at `location`, or None when it has not changed since it was last read."""
        if re.match(r"https?://", location, flags=re.I):
            request = urllib.request.Request(location, headers={"User-Agent": f"bbqs-kg-mcp/{__version__}"})
            if isinstance(self._seen.get(location), str):
                request.add_header("If-None-Match", self._seen[location])
            try:
                with urllib.request.urlopen(request, timeout=FETCH_SECONDS) as response:
                    data, headers = response.read(MAX_BYTES + 1), response.headers
            except urllib.error.HTTPError as exc:
                if exc.code == 304:
                    return None
                raise RuntimeError(f"HTTP {exc.code}") from exc
            seen, modified = headers.get("ETag"), {}
            if headers.get("Last-Modified"):
                try:
                    modified = {"last_modified": _iso(parsedate_to_datetime(headers["Last-Modified"]))}
                except (TypeError, ValueError):
                    pass
        else:
            path = Path(location).expanduser()
            stat = path.stat()
            seen = (stat.st_mtime_ns, stat.st_size)
            if self._seen.get(location) == seen:
                return None
            data = path.read_bytes()
            committed = _committed(path)
            modified = {"committed": committed} if committed else {
                "file_modified": _iso(datetime.fromtimestamp(stat.st_mtime, timezone.utc))}
        if len(data) > MAX_BYTES:
            raise RuntimeError(f"larger than {MAX_BYTES // 2 ** 20} MB")
        graph = _BudgetedGraph().parse(data=data, format=guess_format(location.split("?")[0]) or "turtle")
        kg = KG(graph, {"source": self._shown(location), **modified, "loaded_at": _iso(datetime.now(timezone.utc))})
        if not kg.nodes:
            raise RuntimeError("it holds no nodes")
        self._seen[location] = seen
        return kg

    @staticmethod
    def _shown(location: str) -> str:
        """A location as reported to clients: a URL as is, a file by name (not its place on disk)."""
        if re.match(r"https?://", location, flags=re.I):
            return location
        path = Path(location)
        return "kg/export/bbqs.ttl (the committed export)" if path.resolve() == BUNDLED_EXPORT else path.name


# ---- MCP ----------------------------------------------------------------------------------------

INSTRUCTIONS = (
    "Read-only access to the BBQS consortium knowledge graph: projects (NIH awards), investigators and their "
    "roles on projects, organizations, working groups, species, publications, datasets, devices, software and "
    "funding opportunities. Call describe_graph first: it lists the node types, the link types and how "
    "complete each is. Find a starting node with search_nodes. Then get_node gives its record, find_related "
    "what is most closely tied to it (or to several nodes at once), find_paths how two nodes are connected, and "
    "get_neighbors everything within a few links; use sparql_query for counts and aggregates. The data is a "
    "public snapshot of a graph that is still being linked, so a missing link means 'not recorded', not 'no'."
)
NODE = "A node: an id returned by another tool, a full IRI, or an exact name, grant number, ORCID, DOI or PMID."
WITHOUT_SPARQL = "; for a count, search_nodes gives the total"


def instructions(sparql: bool = True) -> str:
    """INSTRUCTIONS, or without the tool that is not offered."""
    return INSTRUCTIONS if sparql else INSTRUCTIONS.replace("; use sparql_query for counts and aggregates", WITHOUT_SPARQL)


def build_server(source: GraphSource, sparql: bool = True):
    """The MCP server over `source`. Every tool is a read; nothing here can change the graph."""
    from anyio import to_thread
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.server.mcpserver.tools import Tool
    from mcp_types import ToolAnnotations
    from pydantic import ConfigDict, Field
    from starlette.responses import JSONResponse

    read_only = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True,
                                open_world_hint=False)
    tools: list = []

    def tool(fn=None, *, description: str | None = None):
        """Register `fn` as a read-only tool. Its answer goes out as compact JSON (indentation is
        token cost on every result), and a KGError becomes the tool's error text so the model can
        read what went wrong and correct itself, instead of a bare 'Error executing tool'. An
        argument the tool does not take is refused, not dropped: a misspelt max_hops would
        otherwise answer a different question without a word."""
        if fn is None:
            return lambda fn: tool(fn, description=description)

        @functools.wraps(fn)
        def answer(*args, **kwargs):
            try:
                return json.dumps(fn(*args, **kwargs), separators=(",", ":"), ensure_ascii=False, default=str)
            except KGError as exc:
                raise ToolError(str(exc)) from exc
        made = Tool.from_function(answer, description=description, annotations=read_only, structured_output=False)
        loose = made.fn_metadata.arg_model
        strict = type(loose.__name__, (loose,), {"__module__": loose.__module__,
                                                 "model_config": ConfigDict({**loose.model_config, "extra": "forbid"})})
        made.fn_metadata.arg_model = strict
        made.parameters = strict.model_json_schema(by_alias=True)
        tools.append(made)
        return fn

    describe_text = ("The map of the graph. Node types with counts and the properties each carries, link types with "
                     "their endpoints, how complete the data is, and which snapshot is being served. Call this first; "
                     "call it again with a type before filtering on that type's properties"
                     + (" or writing SPARQL about it." if sparql else "."))

    @tool(description=describe_text)
    def describe_graph(
        type: Annotated[str | None, Field(description="A node type, for that type in full: what each property "
                                          "means, the values it takes, and its links.")] = None,
    ) -> dict:
        return source.current().describe(type, sparql=sparql)

    @tool
    def search_nodes(
        query: Annotated[str, Field(description="Words to look for: a name, grant number, ORCID, DOI, or a "
                                    "topic that appears in abstracts, keywords or descriptions. Partial words "
                                    "match from their start. May be empty when type or where is given.")] = "",
        type: Annotated[str | list[str] | None, Field(description="Only these node types, e.g. Project or "
                                                      "[\"Investigator\", \"Publication\"].")] = None,
        where: Annotated[dict[str, Any] | None, Field(description="Exact property values a node must have, "
                                                      "e.g. {\"mechanism\": \"R61\"} or {\"year\": 2025}. "
                                                      "Case-insensitive.")] = None,
        limit: Annotated[int, Field(description="Results per page, 1-100.")] = 10,
        offset: Annotated[int, Field(description="Results to skip, for the next page.")] = 0,
    ) -> dict:
        """Find nodes by text, or list them by type and exact property values. Returns the ids the other
        tools take, best match first, with where the text matched when the label does not show it."""
        kg = source.current()
        return kg.answered(kg.search(query, type, where, limit, offset))

    @tool
    def get_node(
        node: Annotated[str, Field(description=NODE)],
        edge_limit: Annotated[int, Field(description="Neighbours listed per link type; the rest are counted "
                                         "in 'more' (page through them with get_neighbors).")] = 25,
    ) -> dict:
        """Everything recorded about one node: all its properties, and every link grouped by type and
        direction with the nodes at the other end."""
        kg = source.current()
        return kg.answered(kg.node(node, edge_limit))

    @tool
    def get_neighbors(
        node: Annotated[str, Field(description=NODE)],
        edge: Annotated[str | list[str] | None, Field(description="Follow only these link types, e.g. has_role. "
                                                      "Default: all.")] = None,
        direction: Annotated[OneOf["out", "in", "both"], Field(description="out: links pointing away from the "
                                                               "node; in: pointing at it; both (default).")] = "both",
        type: Annotated[str | list[str] | None, Field(description="Return only nodes of these types. The walk "
                                                      "still passes through every type.")] = None,
        depth: Annotated[int, Field(description=f"How many links away to go, 1-{MAX_DEPTH}.")] = 1,
        limit: Annotated[int, Field(description="Nodes per page, 1-200.")] = 50,
        offset: Annotated[int, Field(description="Nodes to skip, for the next page.")] = 0,
        through_hubs: Annotated[bool, Field(description="Also walk through hubs. Naming edge does the same.")] = False,
    ) -> dict:
        """Walk outward from a node: every node within `depth` links, nearest first, each with the link
        that reached it. `type` filters what is returned, not what is walked through, so depth 2 from a
        species with type Investigator gives the people on the projects that study it. A hub (a node with
        a great many links, such as a working group) is returned but not walked through, and listed in
        the reply, so two links from a person is not everyone in the same working group. This tool lists;
        it does not rank. For what is most closely tied to a node, use find_related."""
        kg = source.current()
        return kg.answered(kg.neighbors(node, edge, direction, type, depth, limit, offset, through_hubs))

    @tool
    def find_related(
        nodes: Annotated[str | list[str], Field(description="The starting node, or a list of up to "
                                                f"{MAX_SEEDS} to ask what they have in common. Each is: " + NODE)],
        type: Annotated[str | list[str] | None, Field(description="Only these node types, e.g. Investigator "
                                                      "for 'which people'. Default: every type, each ranked on "
                                                      "its own.")] = None,
        limit: Annotated[int, Field(description="Nodes per type, 1-25 (1-10 when no type, or more than three, "
                                    "are named).")] = 5,
        offset: Annotated[int, Field(description="Nodes to skip per type, for the next page.")] = 0,
        avoid_edges: Annotated[str | list[str] | None, Field(description="Link types not to spread along, e.g. "
                                                             "member_of_group to leave working groups out of "
                                                             "it.")] = None,
        max_hops: Annotated[int, Field(description=f"How many links away to look, 1-{MAX_HOPS}. Nodes farther "
                                       "than that are counted, not listed.")] = 4,
    ) -> dict:
        """What is most closely tied to a node, or to several nodes at once, ranked the way one idea brings up
        another (spreading activation). Activation leaves each starting node along every link; each node it
        reaches splits what it received equally among the nodes it is linked to; amounts that arrive together
        add up. So a direct link has strength 1, a tie through one node with 5 neighbours 0.2, and two such
        routes 0.4. Each node type is ranked on its own, nearest first and then strongest: strength compares
        nodes the same distance away, and being a sum it can pass 1 where many routes arrive. With several
        starting nodes only what every one of them reaches is returned, each node placed by its worst tie (the
        farthest starting node, then the weakest); `per_start` gives the tie to each one, and only nodes
        equal on every tie count as equals. Per type, `within` counts the nodes within max_hops and `beyond`
        those farther. A row one link away has `link` (and `also` for further links between the same two);
        a farther one has `through`, the strongest route, each node on it with `splits`, the neighbours it
        divided among, and, where there are several routes, `routes` and `share`, the part of the strength
        the route shown brings. find_paths lists the routes. `tied` says a list was cut among equals, whose
        order (by name) means nothing."""
        kg = source.current()
        return kg.answered(kg.related(nodes, type, limit, offset, avoid_edges, max_hops))

    @tool
    def find_paths(
        source_node: Annotated[str, Field(description=NODE)],
        target_node: Annotated[str, Field(description=NODE)],
        max_hops: Annotated[int, Field(description=f"Longest chain to consider, 1-{MAX_HOPS}.")] = 6,
        limit: Annotated[int, Field(description="Paths to return, 1-25.")] = 5,
        avoid_edges: Annotated[str | list[str] | None, Field(description="Link types not to use, e.g. "
                                                             "member_of_group to skip 'both are in the same "
                                                             "working group'.")] = None,
        offset: Annotated[int, Field(description="Paths to skip, for the next page.")] = 0,
    ) -> dict:
        """How two nodes are connected: the shortest chains of links between them, strongest first, then
        longer ones up to max_hops. A chain that goes the long way round a direct link is left out. A path's
        strength is what is left of one unit after every node in between has split it equally among the
        nodes it is linked to, so a path through a hub (a working group with a hundred members) is weak.
        The reply counts the shortest paths (`routes`) and adds up their `strength`: the two figures
        find_related shows for the pair. `shortest` is their length and `listed` the number of paths on this
        page. `more` means there are further paths, reached with offset; `partial` means the search stopped
        early, so some paths may be missing."""
        kg = source.current()
        return kg.answered(kg.paths(source_node, target_node, max_hops, limit, avoid_edges, offset))

    if sparql:
        @tool
        def sparql_query(
            query: Annotated[str, Field(description="A SPARQL SELECT or ASK query. Prefixes bbqs: (schema terms) "
                                        "and bid: (node ids) are already declared, and an id from another tool "
                                        "works as bid:<id>.")],
            limit: Annotated[int, Field(description=f"Rows to return, 1-{MAX_ROWS}.")] = 100,
        ) -> dict:
            """Read-only SPARQL over the graph exactly as exported, for counts, aggregates and anything the
            other tools cannot express. Classes and properties are the names describe_graph lists, as
            bbqs:Project, bbqs:grant_number and so on; describe_graph's notes give the roster pattern."""
            kg = source.current()
            return kg.answered(kg.sparql(query, limit))

    server = MCPServer("bbqs-kg", title="BBQS knowledge graph", version=__version__, instructions=instructions(sparql),
                       website_url="https://brain-bbqs.org/", tools=tools)

    @server.custom_route("/health", methods=["GET"])
    async def health(_request):
        kg = await to_thread.run_sync(source.current)    # may re-read the source: keep it off the event loop
        return JSONResponse({"name": "bbqs-kg", "version": __version__, "mcp_endpoint": "/mcp",
                             "nodes": len(kg.nodes), "snapshot": kg.status()})

    return server


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="BBQS knowledge graph over MCP: read-only graph traversal.")
    parser.add_argument("--source", default=os.environ.get("BBQS_KG_SOURCE"), metavar="PATH_OR_URL",
                        help="Turtle file or URL to serve (or set BBQS_KG_SOURCE). Default: the copy published "
                             f"at {PUBLISHED_EXPORT}, else the export committed next to this file.")
    parser.add_argument("--refresh", type=float, default=1.0, metavar="HOURS",
                        help="Re-read the source this often (default 1). 0 reads it once.")
    parser.add_argument("--http", action="store_true", help="Serve streamable HTTP at /mcp instead of stdio.")
    parser.add_argument("--host", default="127.0.0.1", help="With --http: address to bind (default 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8000, help="With --http: port (default 8000).")
    parser.add_argument("--no-sparql", action="store_true", help="Do not offer the sparql_query tool.")
    parser.add_argument("--check", action="store_true", help="Load the graph, print what it holds, and exit.")
    args = parser.parse_args(argv)

    source = GraphSource(args.source, args.refresh)
    try:
        kg = source.current()
    except KGError as exc:
        print(f"bbqs-kg: {exc}", file=sys.stderr)
        return 2
    summary = (f"bbqs-kg {__version__}: {len(kg.nodes)} nodes, {sum(kg.edge_counts.values())} links, "
               f"{kg.snapshot['triples']} triples from {kg.snapshot['source']}")
    if source.problem:
        summary += f"\n  not served from the preferred source -- {source.problem}"
    if args.check:
        print(summary)
        for row in kg.describe()["edge_types"]:
            print(f"  {row['from']} -{row['edge']}-> {row['to']}: {row['count']}")
        return 0
    print(summary, file=sys.stderr)   # stdout belongs to the protocol in stdio mode

    server = build_server(source, sparql=not args.no_sparql)
    if args.http:
        server.run("streamable-http", host=args.host, port=args.port, stateless_http=True, json_response=True)
    else:
        server.run("stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
