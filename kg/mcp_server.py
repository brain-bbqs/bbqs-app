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
"""
import argparse
import bisect
import contextvars
import functools
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
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from datetime import time as clock_time
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Annotated, Any
from typing import Literal as OneOf

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import RDF
from rdflib.plugins.sparql import prepareQuery
from rdflib.plugins.sparql.parserutils import CompValue
from rdflib.util import guess_format

__version__ = "0.1.0"

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
PATH_STEPS = 50_000      # find_paths stops exploring after this many steps
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
            except ValueError:
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
        self._build()

    # -- construction --

    def _build(self):
        types: dict[str, set] = defaultdict(set)
        for s, o in self.graph.subject_objects(RDF.type):
            if isinstance(s, URIRef):
                types[str(s)].add(_local(str(o)))
        node_type = {iri: sorted(found)[0] for iri, found in types.items()}
        for s in self.graph.subjects():                  # a subject with facts but no rdf:type
            if isinstance(s, URIRef):
                node_type.setdefault(str(s), "Untyped")

        props: dict = defaultdict(lambda: defaultdict(list))
        triples = []                                      # between two nodes
        outside: dict = defaultdict(list)                 # outside IRI -> [(node, predicate)]
        for s, p, o in self.graph:
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

        ends: dict = defaultdict(dict)
        for subject, predicate, obj in triples:
            if subject in folded:
                ends[subject][predicate] = obj
            elif obj not in folded:
                self._link(subject, predicate, obj)
        for iri in sorted(folded):
            rule = FOLDED[node_type[iri]]
            source, target = ends[iri].get(rule["from"]), ends[iri].get(rule["to"])
            if source in self.nodes and target in self.nodes:
                attrs = tuple((name, str(props[iri][slot][0])) for name, slot in rule["attrs"].items()
                              if props[iri].get(slot))
                self._link(source, rule["edge"], target, attrs)
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

        self._adjacent = {iri: defaultdict(set) for iri in self.nodes}   # node -> other -> edge names
        for node in self.nodes.values():
            for link in node.links:
                self._adjacent[node.iri][link.other].add(link.edge)
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
        self._tails = tails
        for node in self.nodes.values():
            node.id = node.id or node.iri

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
        if re.fullmatch(r"[0-9a-f-]{6,}", tail.lower()):
            start = bisect.bisect_left(self._tails, tail.lower())
            found = [t for t in self._tails[start: start + 6] if t.startswith(tail.lower())]
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
            return None
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

    def describe(self, type=None) -> dict:
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
                "a person is a free-text career or consortium label and says nothing about any one grant. "
                f"In sparql_query the roster is still records, not links: ?r a bbqs:{kind} ; bbqs:{rule['from']} "
                f"?person ; bbqs:{rule['to']} ?project{slots} ."
                + (f" Every other link is a triple of the same name, e.g. ?a bbqs:{plain} ?b ." if plain else ""))
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

    def paths(self, source, target, max_hops: int = 6, limit: int = 5, avoid_edges=None) -> dict:
        a, b = self.resolve(source), self.resolve(target)
        max_hops, limit = _bounded(max_hops, 1, MAX_HOPS, "max_hops"), _page(limit, 25)
        avoid = self._pick(avoid_edges, self.edges, "edge") or set()
        reply = {"source": self.brief(a), "target": self.brief(b), "found": 0, "paths": []}
        if a is b:
            return {**reply, "note": "source and target are the same node."}
        distance = {b.iri: 0}                     # hops to the target, over the links allowed
        queue = deque([b.iri])
        while queue:
            current = queue.popleft()
            for link in self.nodes[current].links:
                if link.edge not in avoid and link.other not in distance:
                    distance[link.other] = distance[current] + 1
                    queue.append(link.other)
        without = f" without {', '.join(sorted(avoid))}" if avoid else ""
        if a.iri not in distance:
            return {**reply, "note": f"Not connected{without}: no chain of links joins these two nodes."}
        shortest = distance[a.iri]
        if shortest > max_hops:
            return {**reply, "shortest": shortest,
                    "note": f"The shortest connection{without} is {shortest} hops; max_hops is {max_hops}."}
        steps_left, found = [PATH_STEPS], []
        for length in range(shortest, max_hops + 1):
            level: list = []
            self._walk(a.iri, b.iri, length, distance, avoid, [a.iri], [], level, steps_left)
            level.sort(key=lambda path: (sum(math.log2(1 + len(self.nodes[l.other].links)) for l in path[:-1]),
                                         [(l.edge, l.other) for l in path]))
            found.extend(level)
            if len(found) >= limit or steps_left[0] <= 0:
                break
        reply.update(found=min(len(found), limit), shortest=shortest,
                     paths=[self._path(a, path) for path in found[:limit]])
        if len(found) > limit or steps_left[0] <= 0:
            reply["more"] = True
        return reply

    def _walk(self, current, target, remaining, distance, avoid, trail, links, out, steps_left):
        """Every path of exactly `remaining` more links from `current` to `target` that takes no
        detour: no node on it is linked to an earlier one except the one just before it. A path
        with such a shortcut is a shorter path plus padding, and says nothing the shorter one
        does not."""
        if remaining == 0:
            out.append(list(links))
            return
        for link in self.nodes[current].links:
            if steps_left[0] <= 0:
                return
            nxt = link.other
            if link.edge in avoid or nxt in trail or distance.get(nxt, MAX_HOPS + 1) > remaining - 1 \
                    or (nxt == target and remaining != 1) \
                    or any(self._adjacent[nxt].get(earlier, set()) - avoid for earlier in trail[:-1]):
                continue
            steps_left[0] -= 1
            trail.append(nxt)
            links.append(link)
            self._walk(nxt, target, remaining - 1, distance, avoid, trail, links, out, steps_left)
            trail.pop()
            links.pop()

    def _path(self, start: Node, links: list) -> dict:
        def show(node):
            return f'{node.type} "{_clip(node.label, 70)}"'

        text, ids = show(start), [start.id]
        for link in links:
            detail = link.edge + "".join(f" {value}" for name, value in link.attrs if name == "role")
            text += (f" -[{detail}]-> " if link.out else f" <-[{detail}]- ") + show(self.nodes[link.other])
            ids.append(self.nodes[link.other].id)
        return {"hops": len(links), "text": text, "nodes": ids}

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
    "complete each is. Find a starting node with search_nodes, then walk with get_node, get_neighbors and "
    "find_paths; use sparql_query for counts and aggregates. The data is a public snapshot of a graph that is "
    "still being linked, so a missing link means 'not recorded', not 'no'."
)
NODE = "A node: an id returned by another tool, a full IRI, or an exact name, grant number, ORCID, DOI or PMID."


def build_server(source: GraphSource, sparql: bool = True):
    """The MCP server over `source`. Every tool is a read; nothing here can change the graph."""
    from anyio import to_thread
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp_types import ToolAnnotations
    from pydantic import Field
    from starlette.responses import JSONResponse

    server = MCPServer("bbqs-kg", title="BBQS knowledge graph", version=__version__, instructions=INSTRUCTIONS,
                       website_url="https://brain-bbqs.org/")
    read_only = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True,
                                open_world_hint=False)

    def tool(fn):
        """Register `fn` as a read-only tool. Its answer goes out as compact JSON (indentation is
        token cost on every result), and a KGError becomes the tool's error text so the model can
        read what went wrong and correct itself, instead of a bare 'Error executing tool'."""
        @functools.wraps(fn)
        def answer(*args, **kwargs):
            try:
                return json.dumps(fn(*args, **kwargs), separators=(",", ":"), ensure_ascii=False, default=str)
            except KGError as exc:
                raise ToolError(str(exc)) from exc
        server.add_tool(answer, annotations=read_only, structured_output=False)
        return fn

    @tool
    def describe_graph(
        type: Annotated[str | None, Field(description="A node type, for that type in full: what each property "
                                          "means, the values it takes, and its links.")] = None,
    ) -> dict:
        """The map of the graph. Node types with counts and the properties each carries, link types with
        their endpoints, how complete the data is, and which snapshot is being served. Call this first;
        call it again with a type before filtering on that type's properties or writing SPARQL about it."""
        return source.current().describe(type)

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
        the reply, so two links from a person is not everyone in the same working group."""
        kg = source.current()
        return kg.answered(kg.neighbors(node, edge, direction, type, depth, limit, offset, through_hubs))

    @tool
    def find_paths(
        source_node: Annotated[str, Field(description=NODE)],
        target_node: Annotated[str, Field(description=NODE)],
        max_hops: Annotated[int, Field(description=f"Longest chain to consider, 1-{MAX_HOPS}.")] = 6,
        limit: Annotated[int, Field(description="Paths to return, 1-25.")] = 5,
        avoid_edges: Annotated[str | list[str] | None, Field(description="Link types not to use, e.g. "
                                                             "member_of_group to skip 'both are in the same "
                                                             "working group'.")] = None,
    ) -> dict:
        """How two nodes are connected: the shortest chains of links between them, then longer ones up to
        max_hops. A chain that goes the long way round a direct link is left out. Among equally short
        paths, those through less-connected nodes come first, since a path through a hub (a working
        group with a hundred members) says less."""
        kg = source.current()
        return kg.answered(kg.paths(source_node, target_node, max_hops, limit, avoid_edges))

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
