#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp==2.3.0", "rdflib==7.6.0", "PyYAML==6.0.3"]
# ///
"""Benchmark for kg/mcp_server.py: the consortium's own questions, asked the way a client asks.

    python kg/bench_mcp_server.py                      # run everything, print the report
    python kg/bench_mcp_server.py --show CQ04          # one question: the rows each way returned
    python kg/bench_mcp_server.py --only questions     # one part: questions, ranking or speed
    python kg/bench_mcp_server.py --update README.md   # rewrite the results block in the main README
    python kg/bench_mcp_server.py --json out.json      # the numbers, for a machine
    python kg/bench_mcp_server.py --source other.ttl   # another export than the committed one
    uv run kg/bench_mcp_server.py                      # same, the header above supplies the dependencies

It starts the real server as a client would (a process, JSON-RPC over stdio) and has three parts.

  questions  Every competency question, asked twice over MCP: as SPARQL through sparql_query, and
             without SPARQL through the graph tools (search_nodes, get_node, find_related). Each
             way must return the rows the export gives when it is queried directly, with no server
             in between. Exit code 1 if any does not. The questions are the 19 the KG is scored
             on (competency_questions.yaml) and the 23 proposed in issue #441
             (competency_questions_extended.yaml): 42 in all.
  ranking    Is the order find_related gives worth having? Hide one real tie, start at one of its
             ends, ask for nodes of the hidden end's type, and see whether the hidden end is among
             the first ten returned that the start is not already tied to. The same for
             get_neighbors, which lists by distance alone. Also: every strength against a second,
             slower version of the rule that leaves nothing out.
  speed      How long a call takes and how big a reply is, on real nodes, over stdio.

The questions and the ranking do not depend on the machine; the speed does, and says which it was.
"""
import argparse
import json
import math
import platform
import queue
import re
import statistics
import subprocess
import sys
import threading
import time
from collections import defaultdict
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import yaml
from rdflib import BNode, Graph, Literal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import mcp_server as m  # noqa: E402

SERVER = HERE / "mcp_server.py"
QUESTION_FILES = {"adopted": HERE / "competency_questions.yaml",             # CQ01-CQ19: what quality.py scores
                  "proposed": HERE / "competency_questions_extended.yaml"}   # CQ20-CQ42: issue #441, not adopted yet
START, END = "<!-- kg-mcp-benchmark:start -->", "<!-- kg-mcp-benchmark:end -->"
PARTS = ("questions", "ranking", "speed")


# ---- the server, as a client sees it ---------------------------------------------------------------

class Client:
    """A raw JSON-RPC client on the server's stdin and stdout: no SDK on this side, so what works
    here is what any MCP client gets."""

    def __init__(self, source: str):
        began = time.perf_counter()
        self.process = subprocess.Popen([sys.executable, str(SERVER), "--source", source, "--refresh", "0"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding="utf-8")
        self.lines: queue.Queue = queue.Queue()
        threading.Thread(target=lambda: [self.lines.put(line) for line in self.process.stdout], daemon=True).start()
        self.number, self.calls, self.cache = 0, 0, {}
        hello = self._ask("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                         "clientInfo": {"name": "kg-benchmark", "version": "0"}})
        self.ready_seconds = time.perf_counter() - began
        self.version = hello["serverInfo"]["version"]
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, message: dict):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def _ask(self, method: str, params: dict) -> dict:
        self.number += 1
        self._send({"jsonrpc": "2.0", "id": self.number, "method": method, "params": params})
        while True:
            try:
                reply = json.loads(self.lines.get(timeout=120))
            except queue.Empty:
                raise SystemExit(f"bench: the server did not answer {method} within two minutes") from None
            if reply.get("id") == self.number:
                if "error" in reply:
                    raise SystemExit(f"bench: {method} failed: {reply['error']}")
                return reply["result"]

    def timed(self, tool: str, **arguments):
        """One tool call: (answer or None, error text or None, seconds, bytes of the reply)."""
        began = time.perf_counter()
        result = self._ask("tools/call", {"name": tool, "arguments": arguments})
        seconds = time.perf_counter() - began
        self.calls += 1
        text = "".join(block["text"] for block in result["content"] if block["type"] == "text")
        if result.get("isError"):
            return None, text, seconds, len(text.encode("utf-8"))
        return json.loads(text), None, seconds, len(text.encode("utf-8"))

    def call(self, tool: str, **arguments) -> dict:
        answer, error, _, _ = self.timed(tool, **arguments)
        if error:
            raise SystemExit(f"bench: {tool}({arguments}) was refused: {error}")
        return answer

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=30)
        self.process.stdout.close()

    # -- what the graph tools give, in the shapes the questions need --

    def listed(self, **arguments) -> list:
        """Every node search_nodes lists for these arguments, a page at a time; none when the graph
        has no such type of node or no such property."""
        found, total = [], None
        while total is None or len(found) < total:
            page, error, _, _ = self.timed("search_nodes", limit=100, offset=len(found), **arguments)
            if error:
                if nothing_of_the_kind(error):
                    return []
                raise SystemExit(f"bench: search_nodes({arguments}) was refused: {error}")
            total = page["total"]
            found += page["results"]
            if not page["results"]:
                break
        return found

    def all_of(self, kind: str) -> list:
        """Every node of one type."""
        if ("all", kind) not in self.cache:
            self.cache["all", kind] = self.listed(type=kind)
        return self.cache["all", kind]

    def where(self, kind: str, **wanted) -> list:
        """Every node of one type holding exactly these property values. search_nodes ignores case
        and accents in a value, a question does not, so each node found is read to make sure."""
        return [node for node in self.listed(type=kind, where=wanted)
                if all(value in self.values(node["id"], name) for name, value in wanted.items())]

    def node(self, node_id: str) -> dict:
        """One node in full (get_node): its properties, and its links with the node at the other end,
        up to 500 of each kind (linked() says when that is not all of them)."""
        if ("node", node_id) not in self.cache:
            self.cache["node", node_id] = self.call("get_node", node=node_id, edge_limit=500)
        return self.cache["node", node_id]

    def values(self, node_id: str, name: str) -> list:
        """Every value a node has for one property."""
        value = self.node(node_id)["properties"].get(name, [])
        return value if isinstance(value, list) else [value]

    def linked(self, node_id: str, edge: str, direction: str) -> list:
        """The nodes at the other end of one kind of link, one entry per link (get_node). `direction`
        is "out" for links pointing away from the node and "in" for links pointing at it. An entry
        carries what its link carries, e.g. the role."""
        groups = [group for group in self.node(node_id)["edges"] if group["edge"] == edge and group["direction"] == direction]
        if any("more" in group for group in groups):
            raise Unwalkable(f"{node_id} has more {edge} links than get_node lists at once (500)")
        return [row for group in groups for row in group["nodes"]]

    def pointed(self, node_id: str, name: str) -> list:
        """Everything a node points at through one property, one entry for each: a node (as get_node
        lists it) where the other end is one, otherwise the value itself. An identifier that two or
        more nodes share is both a value and a node in the server's view; here it is the node."""
        rows, values = self.linked(node_id, name, "out"), list(self.values(node_id, name))
        for row in rows:
            if row["type"] in (m.EXTERNAL, m.UNRESOLVED):    # the link and one of the values are the same entry
                iri = row["id"][4:] if row["type"] == m.EXTERNAL else self.node(row["id"])["iri"]
                if iri in values:
                    values.remove(iri)
        return rows + values

    def has(self, node_id: str, name: str) -> bool:
        """Whether a node says anything at all under one property, as a link or as a value."""
        full = self.node(node_id)
        return any(group["edge"] == name and group["direction"] == "out" for group in full["edges"]) \
            or name in full["properties"]

    def tied(self, node: str, kind: str, edges: set) -> list:
        """The nodes of one type directly tied to `node` by one of `edges` (find_related, one link away,
        a page at a time), each with the link that ties it. One entry per node, however many links
        tie it: where the number of links matters, `linked` is the one to use."""
        found, reached = [], None
        while reached is None or len(found) < reached:
            reply, error, _, _ = self.timed("find_related", nodes=node, type=kind, max_hops=1, limit=25, offset=len(found))
            if error:
                if nothing_of_the_kind(error):
                    return []
                raise SystemExit(f"bench: find_related({node}, {kind}) was refused: {error}")
            group = reply["related"][0]
            reached = group["within"]
            found += group["nodes"]
            if not group["nodes"]:
                break
        return [row for row in found if {row["link"]["edge"], *(link["edge"] for link in row["link"].get("also", ()))} & edges]


class Unwalkable(Exception):
    """A question the graph tools cannot answer here in full: it fails on its own, not the run."""


def nothing_of_the_kind(error: str) -> bool:
    """A refusal that says only that the graph holds no such type of node, or no such property: an
    empty answer, not a failure."""
    return "Unknown node type" in error or "has a property" in error


def bid(node_id: str) -> str:
    """A node, as sparql_query writes one in a cell: bid:<id> for one of this graph's own ids (a
    short id never holds a colon), and any other by its address: bbqs:Name where a declared prefix
    fits, <address> otherwise."""
    iri = node_id[4:] if node_id.startswith("ext:") else node_id
    return "bid:" + iri if ":" not in iri else address(iri)


def address(iri: str) -> str:
    """An IRI that is not one of this graph's nodes, written as a SPARQL cell writes it."""
    for prefix, namespace in m.PREFIXES.items():
        if prefix != "bid" and iri.startswith(namespace) and re.fullmatch(r"\w+", iri[len(namespace):]):
            return f"{prefix}:{iri[len(namespace):]}"
    return f"<{iri}>"


def cell(entry):
    """What sparql_query writes for something a node points at (see Client.pointed)."""
    return bid(entry["id"]) if isinstance(entry, dict) else entry


# ---- the questions, without SPARQL -----------------------------------------------------------------
# Each takes the client and returns the rows the question's SPARQL would, in the same column order,
# using only search_nodes, get_node and find_related. `how` says in a few words which.
#
# They are written for any export the exporter could write, not only today's: a property may be
# missing or given twice, a link may point at an id nothing describes, the same two nodes may be
# linked twice. What they take for granted is the schema: a link ends at the type its range names.
#
# What a walk cannot see is what the server's view leaves out. describe_graph counts most of it:
# a roster record with an end missing, or with an end, a role or its source given twice (no link is
# made of it); what a record says besides those, its other types, and a link to a record; a node's
# second rdf:type (it is listed under the first); a blank node (not a node of the view). Two are not
# counted: a language tag and a datatype (the text is kept, the tag or type is not). The export does
# carry datatypes (xsd:anyURI on 477 values, xsd:date on 27), and no question tells them apart.
# SPARQL reads the file as it is, so where a question can tell, the comparison below says DIFFERENT. The
# export the exporter writes has none of these but two roster records with an end missing, which
# no question can tell. CQ17 and CQ39 compare xsd:date values as ISO text, which is what they are.

def cq01(c):
    return [[bid(p["id"]), number, mechanism] for p in c.all_of("Project")
            for number in c.values(p["id"], "grant_number") for mechanism in c.values(p["id"], "mechanism") or [None]]


def cq02(c):
    count, total = defaultdict(int), defaultdict(int)
    for p in c.all_of("Project"):
        for mechanism in c.values(p["id"], "mechanism"):
            for amount in c.values(p["id"], "award_amount"):
                if isinstance(amount, bool) or not isinstance(amount, (int, float)):
                    continue                                    # not a number: SPARQL cannot add it either
                count[mechanism] += 1
                total[mechanism] += amount
    return [[mechanism, count[mechanism], total[mechanism]] for mechanism in count]


def cq03(c):
    return [[bid(p["id"]), number, name] for p in c.all_of("Project")
            for org in c.tied(p["id"], "ResearchOrganization", {"part_of_org"})
            for number in c.values(p["id"], "grant_number") for name in c.values(org["id"], "name")]


def cq04(c):
    return [[name, person["role"]] for p in c.where("Project", grant_number="R34DA059723")
            for person in c.linked(p["id"], "has_role", "in") if "role" in person
            for name in c.values(person["id"], "name")]


def cq05(c):
    projects = defaultdict(set)
    for p in c.all_of("Project"):
        for person in c.tied(p["id"], "Investigator", {"has_role"}):
            projects[person["id"]].add(p["id"])
    return [[name, len(held)] for person, held in projects.items() if len(held) > 1 for name in c.values(person, "name")]


def cq06(c):
    return [[name, org_name] for org in c.all_of("ResearchOrganization")
            for person in c.tied(org["id"], "Investigator", {"members"})
            for name in c.values(person["id"], "name") for org_name in c.values(org["id"], "name")]


def cq07(c):
    return [[name, cell(orcid)] for person in c.all_of("Investigator")
            for name in c.values(person["id"], "name") for orcid in c.pointed(person["id"], "orcid")]


def cq08(c):
    return [[name] for group in c.where("WorkingGroup", name="WG-Devices")
            for person in c.tied(group["id"], "Investigator", {"member_of_group"})
            for name in c.values(person["id"], "name")]


def cq09(c):
    return [[bid(p["id"]), number] for species in c.where("Species", common_name="House Mouse")
            for p in c.tied(species["id"], "Project", {"studies_species"})
            for number in c.values(p["id"], "grant_number")]


def cq10(c):
    rows = {(bid(p["id"]), number) for species in c.where("Species", taxonomy_class="Mammalia")
            for p in c.tied(species["id"], "Project", {"studies_species"})
            for number in c.values(p["id"], "grant_number")}
    return [list(row) for row in rows]


def cq11(c):
    return [[bid(p["id"]), number, scope] for p in c.all_of("Project")
            if not c.has(p["id"], "studies_species")        # it names no species, resolved to a node or not
            for number in c.values(p["id"], "grant_number") for scope in c.values(p["id"], "study_scope") or [None]]


def cq12(c):
    return [[number, title] for p in c.all_of("Project") for paper in c.tied(p["id"], "Publication", {"produced"})
            for number in c.values(p["id"], "grant_number") for title in c.values(paper["id"], "title")]


def cq13(c):
    return [[number, name] for p in c.all_of("Project")
            for edge in ("funded_datasets", "produced")     # a dataset both funded and produced is two rows
            for dataset in c.linked(p["id"], edge, "out") if dataset["type"] == "Dataset"
            for number in c.values(p["id"], "grant_number") for name in c.values(dataset["id"], "name")]


def cq14(c):
    return [[number, label] for p in c.all_of("Project")
            for category in c.tied(p["id"], "DeviceCategory", {"uses_device_category"})
            for number in c.values(p["id"], "grant_number") for label in c.values(category["id"], "label")]


def cq15(c):
    rows = []
    for device in c.all_of("Device"):
        categories = [cell(category) for category in c.pointed(device["id"], "device_category")] or [None]
        rows += [[name, model, category] for maker in c.tied(device["id"], "DeviceManufacturer", {"manufacturer"})
                 for name in c.values(maker["id"], "name") for model in c.values(device["id"], "model_name")
                 for category in categories]
    return rows


def cq16(c):
    return [[name, cell(repo)] for tool in c.all_of("SoftwareTool")
            for name in c.values(tool["id"], "name") for repo in c.pointed(tool["id"], "repo_url")]


def cq17(c):
    return [[name, expires] for call in c.all_of("FundingOpportunity") for name in c.values(call["id"], "name")
            for expires in c.values(call["id"], "expiration_date") if expires > "2026-09-29"]


def cq18(c):
    return [[name, cell(institution)] for job in c.all_of("Job")
            for name in c.values(job["id"], "name") for institution in c.pointed(job["id"], "job_institution")]


def _local(c, node_id: str) -> str:
    """A node's own id in full, as a provenance record names it."""
    return c.node(node_id)["iri"].partition(m.ID_NS)[2]


def cq19(c):
    wanted = {_local(c, p["id"]) for p in c.where("Project", grant_number="R34DA059723")}
    rows = []
    for record in c.all_of("ProvenanceRecord") if wanted else ():
        about = wanted & set(c.values(record["id"], "prov_entity_id"))
        if not about or "title" not in c.values(record["id"], "prov_entity_column"):
            continue
        for source in c.pointed(record["id"], "prov_source_class"):
            grades = (c.values(source["id"], "grade") if isinstance(source, dict) else []) or [None]
            rows += [[value, cell(source), grade] for _ in about for value in c.values(record["id"], "prov_value_text")
                     for grade in grades]
    return rows


# -- the 23 proposed in issue #441 --

def _roles_of(c) -> dict:
    """person id -> [(project, the role on the link or None), ...], one entry per roster record."""
    held = defaultdict(list)
    for p in c.all_of("Project"):
        for person in c.linked(p["id"], "has_role", "in"):
            held[person["id"]].append((p["id"], person.get("role")))
    return held


def cq20(c):
    rows = []
    for person, held in _roles_of(c).items():
        numbers = {p: c.values(p, "grant_number") for p, _ in held}
        if sum(1 for found in numbers.values() if found) > 1:        # a project with no number does not count
            grants = sorted({number for found in numbers.values() for number in found})
            rows += [[name, ", ".join(grants)] for name in c.values(person, "name")]
    return rows


def cq21(c):
    return [[name] for person in c.all_of("Investigator") if not c.has(person["id"], "orcid")
            for name in c.values(person["id"], "name")]


def cq22(c):
    rows = set()
    for person in c.all_of("Investigator"):
        orgs = [org["id"] for org in c.linked(person["id"], "members", "in")]
        orgs += [org["id"] for p in c.linked(person["id"], "has_role", "out") for org in c.linked(p["id"], "part_of_org", "out")]
        rows |= {(name, org_name) for name in c.values(person["id"], "name") for org in orgs for org_name in c.values(org, "name")}
    return [list(row) for row in rows]


def cq23(c):
    rows = []
    for group in c.all_of("WorkingGroup"):
        for person in c.linked(group["id"], "member_of_group", "in"):
            grants = [number for p in c.linked(person["id"], "has_role", "out") for number in c.values(p["id"], "grant_number")]
            rows += [[group_name, name, grant] for group_name in c.values(group["id"], "name")
                     for name in c.values(person["id"], "name") for grant in grants or [None]]
    return rows


def cq24(c):
    rows = []
    for person, held in _roles_of(c).items():
        roles = sorted({role for _, role in held if role})
        if len(roles) > 1:
            rows += [[name, ", ".join(roles)] for name in c.values(person, "name")]
    return rows


def cq25(c):
    rows = []
    for species in c.all_of("Species"):
        named = sum(wanted in c.values(species["id"], name) for name, wanted in
                    (("name", "Mus musculus"), ("common_name", "House Mouse"), ("aliases", "Mus musculus")))
        for p in c.linked(species["id"], "studies_species", "in") * named:      # once for each name that fits
            rows += [[number, title] for number in c.values(p["id"], "grant_number")
                     for title in c.values(p["id"], "title") or [None]]
    return rows


def cq26(c):
    studied = defaultdict(set)
    for p in c.all_of("Project"):
        for species in c.linked(p["id"], "studies_species", "out"):
            for name in c.values(species["id"], "name"):
                studied[name].add(p["id"])
    return [[name, len(projects)] for name, projects in studied.items()]


def cq27(c):
    return [[number, raw] for p in c.all_of("Project") if not c.has(p["id"], "studies_species")
            for number in c.values(p["id"], "grant_number") for raw in c.values(p["id"], "studies_species_name")]


def cq28(c):
    kinds = ("Publication", "Dataset", "SoftwareTool", "MLModel")
    made = defaultdict(lambda: {kind: set() for kind in kinds})
    for p in c.all_of("Project"):
        for number in c.values(p["id"], "grant_number"):
            made[number]                                            # a project that produced nothing still has a row
            for output in c.linked(p["id"], "produced", "out"):
                if output["type"] in kinds:
                    made[number][output["type"]].add(output["id"])
    return [[number] + [len(made[number][kind]) for kind in kinds] for number in made]


def cq29(c):
    papers, grants = defaultdict(set), defaultdict(set)
    for p in c.all_of("Project"):
        produced = {output["id"] for output in c.linked(p["id"], "produced", "out") if output["type"] == "Publication"}
        numbers = c.values(p["id"], "grant_number")
        if produced and numbers:
            for person in c.linked(p["id"], "has_role", "in"):
                papers[person["id"]] |= produced
                grants[person["id"]] |= set(numbers)
    return [[name, len(papers[person]), ", ".join(sorted(grants[person]))] for person in papers for name in c.values(person, "name")]


def cq30(c):
    sourced = {entity for record in c.all_of("ProvenanceRecord") if c.has(record["id"], "prov_source_class")
               for entity in c.values(record["id"], "prov_entity_id")}
    return [[bid(dataset["id"]), name] for dataset in c.all_of("Dataset") if _local(c, dataset["id"]) not in sourced
            for _ in c.linked(dataset["id"], "produced", "in") for name in c.values(dataset["id"], "name")]


def cq31(c):
    rows = []
    for model in c.all_of("MLModel"):
        benches = c.linked(model["id"], "evaluated_by", "out") + c.linked(model["id"], "evaluates", "in")
        grants = [number for p in c.linked(model["id"], "produced", "in") for number in c.values(p["id"], "grant_number")]
        rows += [[name, bench_name, grant] for bench in benches if bench["type"] == "Benchmark"
                 for name in c.values(model["id"], "name") for bench_name in c.values(bench["id"], "name")
                 for grant in grants or [None]]
    return rows


def cq32(c):
    return [[name, len(c.pointed(org["id"], "members"))] for org in c.all_of("ResearchOrganization")
            for name in c.values(org["id"], "name")]


def cq33(c):
    return [[name] for org in c.all_of("ResearchOrganization") if not c.has(org["id"], "members")
            for name in c.values(org["id"], "name")]


def cq34(c):
    rows = []
    for org in c.all_of("ResearchOrganization"):
        projects = {p["id"] for person in c.linked(org["id"], "members", "out") for p in c.linked(person["id"], "has_role", "out")}
        if len(projects) > 1:
            rows += [[name, len(projects)] for name in c.values(org["id"], "name")]
    return rows


def cq35(c):
    titles = defaultdict(list)
    for job in c.all_of("Job"):
        for title in c.values(job["id"], "name"):
            for institution in c.pointed(job["id"], "job_institution"):
                titles[cell(institution)].append(title)
    return [[institution, len(found), "; ".join(found)] for institution, found in titles.items()]


def cq36(c):
    postings = defaultdict(int)
    for job in c.all_of("Job"):
        for kind in c.values(job["id"], "job_type"):
            postings[kind] += 1
    return [[kind, count] for kind, count in postings.items()]


def cq37(c):
    return [[title, cell(poster)] for job in c.all_of("Job") for title in c.values(job["id"], "name")
            for poster in c.pointed(job["id"], "posted_by")]


def cq38(c):
    return [[number] for p in c.all_of("Project") if not c.has(p["id"], "produced")
            for number in c.values(p["id"], "grant_number")]


def cq39(c):
    return [[name, expires] for call in c.all_of("FundingOpportunity") for name in c.values(call["id"], "name")
            for expires in c.values(call["id"], "expiration_date") if "2026-10-14" <= expires <= "2027-04-14"]


def cq40(c):
    records = defaultdict(int)
    for record in c.all_of("ProvenanceRecord"):
        for source in c.linked(record["id"], "prov_source_class", "out"):
            for grade in c.values(source["id"], "grade"):
                if isinstance(grade, (int, float)) and grade < 3:
                    for table in c.values(record["id"], "prov_entity_table") or [None]:
                        records[bid(source["id"]), grade, table] += 1
    return [[*key, count] for key, count in records.items()]


def cq41(c):
    rows = []
    for p in c.all_of("Project"):
        leads = [name for person in c.linked(p["id"], "has_role", "in") if "pi" in person.get("role", "").lower()
                 for name in c.values(person["id"], "name")] or [None]
        for dataset in c.pointed(p["id"], "funded_datasets"):
            names = (c.values(dataset["id"], "name") if isinstance(dataset, dict) else []) or [None]
            rows += [[number, name, lead] for number in c.values(p["id"], "grant_number") for name in names for lead in leads]
    return rows


def cq42(c):
    return [[name] for group in c.all_of("WorkingGroup")
            if not any(c.linked(person["id"], "has_role", "out") for person in c.linked(group["id"], "member_of_group", "in"))
            for name in c.values(group["id"], "name")]


WALKS = {
    "CQ01": (cq01, "list the projects; read each one's properties"),
    "CQ02": (cq02, "list the projects; add up their awards by mechanism"),
    "CQ03": (cq03, "from each project, the organization one link away"),
    "CQ04": (cq04, "find the project by grant number; its people, with the role on each link"),
    "CQ05": (cq05, "from each project, its people; count the projects per person"),
    "CQ06": (cq06, "from each organization, the people one link away"),
    "CQ07": (cq07, "list the investigators; read each one's ORCID"),
    "CQ08": (cq08, "find the working group by name; from it, the people one link away"),
    "CQ09": (cq09, "find the species by its common name; from it, the projects one link away"),
    "CQ10": (cq10, "find the mammal species; from each, its projects"),
    "CQ11": (cq11, "list the projects; keep those with no species named"),
    "CQ12": (cq12, "from each project, the publications one link away"),
    "CQ13": (cq13, "from each project, the datasets one link away"),
    "CQ14": (cq14, "from each project, the device categories one link away"),
    "CQ15": (cq15, "from each device, its maker and its category"),
    "CQ16": (cq16, "list the software tools; read each one's repository"),
    "CQ17": (cq17, "list the funding calls; keep those still open"),
    "CQ18": (cq18, "list the jobs; read each one's institution"),
    "CQ19": (cq19, "list the provenance records; keep the project's title; read the source's grade"),
    "CQ20": (cq20, "from each project, its people; keep those on more than one"),
    "CQ21": (cq21, "list the investigators; keep those with no ORCID"),
    "CQ22": (cq22, "from each person, their organization, and their projects' organizations"),
    "CQ23": (cq23, "from each working group, its members; from each member, their projects"),
    "CQ24": (cq24, "from each project, its people and the role on each link"),
    "CQ25": (cq25, "find the species by any of its names; from it, its projects"),
    "CQ26": (cq26, "from each project, its species; count the projects per species"),
    "CQ27": (cq27, "list the projects; keep those naming a species only in free text"),
    "CQ28": (cq28, "from each project, count what it produced, by type"),
    "CQ29": (cq29, "from each project, its people and its publications"),
    "CQ30": (cq30, "list the datasets; keep the produced ones no provenance record names"),
    "CQ31": (cq31, "from each model, its benchmarks and the project that produced it"),
    "CQ32": (cq32, "from each organization, count the members one link away"),
    "CQ33": (cq33, "list the organizations; keep those with no member"),
    "CQ34": (cq34, "from each organization, its members; from each member, their projects"),
    "CQ35": (cq35, "list the jobs; group them by institution"),
    "CQ36": (cq36, "list the jobs; count them by kind"),
    "CQ37": (cq37, "list the jobs; read who posted each"),
    "CQ38": (cq38, "list the projects; keep those that produced nothing"),
    "CQ39": (cq39, "list the funding calls; keep those expiring in the window"),
    "CQ40": (cq40, "list the provenance records; read each source's grade"),
    "CQ41": (cq41, "from each project, the datasets it funded and its PIs"),
    "CQ42": (cq42, "from each working group, its members; see whether any has a project"),
}


def joined_cells(sparql: str) -> dict:
    """The columns in which a query joins several values into one cell (GROUP_CONCAT), read from its
    SELECT clause: column -> separator. SPARQL leaves the order inside such a cell open."""
    select = sparql[:re.search(r"\bWHERE\b|\{", sparql).start()]
    columns = re.findall(r"\((?:[^()]|\([^()]*\))*\)|\?\w+", select)
    return {at: (re.search(r'separator\s*=\s*"([^"]*)"', column) or [None, " "])[1]
            for at, column in enumerate(columns) if "GROUP_CONCAT" in column.upper()}


def reference(term, ids: dict):
    """One cell of the export queried directly, written out here rather than by the server, so that
    a fault in how the server writes a value cannot hide in both the reference and its answer. The
    rules are the ones sparql_query's description gives a client (a number as a number, a truth value
    as true or false, a date or time as ISO text, any other literal as its text, a node of this graph
    as bid:<id>); only the short ids are the server's, because they are names, not values."""
    if term is None:
        return None
    if isinstance(term, BNode):
        return f"_:{term}"
    if isinstance(term, Literal):
        value = term.toPython()
        if isinstance(value, Literal):                         # ill-typed, e.g. text in a number field
            return str(value)
        if isinstance(value, Decimal):
            return int(value) if value == value.to_integral_value() else float(value)
        if isinstance(value, float) and not math.isfinite(value):   # JSON has no number for them: as XSD writes them
            return "NaN" if math.isnan(value) else ("INF" if value > 0 else "-INF")
        if isinstance(value, (int, float, str)):
            return value
        return value.isoformat() if hasattr(value, "isoformat") else str(term)
    iri = str(term)
    return "bid:" + ids[iri] if iri in ids else address(iri)


def same(rows, joined: dict | None = None) -> list:
    """Rows in one order and one spelling, so that two ways of asking can be compared. Duplicate rows
    count. Four things are evened out, because none is part of the answer: the order of the values
    in a cell that joins several (`joined`, from joined_cells); whether an IRI came back as an IRI
    (in angle brackets, or as prefix:name) or as text, which the graph tools do not tell apart; a
    number's last digits, which depend on the order a sum was taken in (12 significant digits are
    kept, whole numbers or not); and a blank node's label, which each reading of a file makes up."""
    def cell(value, column):
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            value = float(f"{value:.12g}")
            return int(value) if value.is_integer() else value
        if not isinstance(value, str):
            return value
        if column in (joined or {}):
            return (joined[column]).join(sorted(value.split(joined[column])))
        if re.fullmatch(r"_:\S+", value):
            return "_:"
        if re.fullmatch(r"<[^<>\s]+>", value):
            return value[1:-1]
        written = re.fullmatch(r"([A-Za-z]\w*):(\w+)", value)
        if written and written.group(1) in m.PREFIXES and written.group(1) != "bid":
            return m.PREFIXES[written.group(1)] + written.group(2)
        return value
    return sorted(json.dumps([cell(value, column) for column, value in enumerate(row)], sort_keys=True, default=str,
                             ensure_ascii=False) for row in rows)


def load_questions() -> tuple:
    """Every question, each marked with the set it belongs to, and the prefixes its SPARQL assumes."""
    questions, prologue = [], ""
    for name, path in QUESTION_FILES.items():
        spec = yaml.safe_load(path.read_text(encoding="utf8"))
        prologue = "".join(f"PREFIX {k}: <{v}>\n" for k, v in spec["prefixes"].items())
        questions += [{**question, "set": name} for question in spec["questions"]]
    return questions, prologue


def ask_questions(client: Client, kg: m.KG, source: str, show: str | None = None, fresh: bool = True,
                  access: str = "anon") -> dict:
    """Every question, three ways: the export queried directly (the reference), sparql_query over MCP,
    and the graph tools over MCP. `fresh` forgets, before each question, what earlier ones fetched.
    `access` is what the export is: "anon" (the public one), or "full", which holds jobs and provenance."""
    questions, prologue = load_questions()
    ids = {iri: node.id for iri, node in kg.nodes.items() if iri.startswith(m.ID_NS)}
    plain = Graph().parse(source, format="turtle")            # the export itself, with no server in between
    schema = {str(s)[len(m.SCHEMA_NS):] for s in Graph().parse(str(m.SCHEMA_FILE), format="turtle").subjects()
              if str(s).startswith(m.SCHEMA_NS)} if m.SCHEMA_FILE.exists() else None
    rows_out = []
    for question in questions:
        joined = joined_cells(question["sparql"])
        problems = []
        try:
            direct = same(([reference(term, ids) for term in row] for row in plain.query(prologue + question["sparql"])),
                          joined)
        except Exception as exc:                              # the file itself cannot answer it, e.g. text in a sum
            direct = None
            problems.append("the export queried directly: " + " ".join(str(exc).split())[:200])
        reply, error, sparql_seconds, _ = client.timed("sparql_query", query=question["sparql"], limit=m.MAX_ROWS)
        by_sparql = same(reply["rows"], joined) if reply else None
        walk, how = WALKS[question["id"]]
        if fresh:
            client.cache = {}                                 # each question from scratch, as a client would ask it
        calls, began = client.calls, time.perf_counter()
        try:
            by_tools = same(walk(client), joined)
        except Unwalkable as exc:
            by_tools = None
            problems.append(f"the graph tools: {exc}")
        walk_seconds, calls = time.perf_counter() - began, client.calls - calls
        terms = set(re.findall(r"\bbbqs:(\w+)", question["sparql"]))
        if direct is None:
            status = "could not be asked"                     # the export queried directly refused it
        elif direct:
            status = "answered"
        elif schema is not None and terms - schema:
            status = "not modelled"                           # the schema has no such term: nothing can answer it yet
        elif question["access"] == "full" and access == "anon":
            status = "needs the full export"                  # its source rows are not public
        else:
            status = "none in this export"                    # asked and understood: there is nothing of the kind to list
        if error:
            problems.append(f"sparql_query: {error}")
        rows_out.append({"id": question["id"], "set": question["set"], "question": question["question"],
                         "area": question["area"], "status": status, "rows": None if direct is None else len(direct),
                         "sparql_agrees": direct is not None and by_sparql == direct,
                         "tools_agree": direct is not None and by_tools == direct, "how": how,
                         "tool_calls": calls, "sparql_ms": round(sparql_seconds * 1000, 1),
                         "tools_ms": round(walk_seconds * 1000, 1), **({"error": "; ".join(problems)} if problems else {})})
        if show == question["id"]:
            print(f"{question['id']}  {question['question']}\n  status: {status}; {len(direct or ())} rows from the export "
                  "queried directly" + "".join(f"\n  problem: {problem}" for problem in problems))
            for name, got in (("sparql_query", by_sparql or []), (f"graph tools ({how})", by_tools or [])):
                print(f"\n  through {name}: {len(got)} rows, {'the same' if got == direct else 'DIFFERENT'}")
                for row in got[:200]:
                    print("    " + row)
                for row in sorted(set(direct or ()) - set(got))[:20]:
                    print("    MISSING " + row)
    asked_ok = [r for r in rows_out if r["rows"] is not None]   # a question the file refused is neither
    answered, silent = [r for r in asked_ok if r["rows"]], [r for r in asked_ok if not r["rows"]]
    adopted = [r for r in rows_out if r["set"] == "adopted"]

    def count(status):
        return sum(r["status"] == status for r in silent)

    refused = sum(r["status"] == "could not be asked" for r in rows_out)

    return {"asked": len(rows_out), "adopted": len(adopted), "answered": len(answered),
            "answered_adopted": sum(1 for r in adopted if r["rows"]),
            "need_the_full_export": count("needs the full export"), "none_in_this_export": count("none in this export"),
            "not_modelled": count("not modelled"), "could_not_be_asked": refused,
            "sparql_agree": sum(r["sparql_agrees"] for r in answered), "tools_agree": sum(r["tools_agree"] for r in answered),
            "silent_agree": sum(r["sparql_agrees"] and r["tools_agree"] for r in silent),
            "all_agree": all(r["sparql_agrees"] and r["tools_agree"] for r in rows_out), "questions": rows_out}


# ---- the ranking -----------------------------------------------------------------------------------

def first_arrivals(kg: m.KG, start: m.Node) -> dict:
    """The rule with nothing left out, written without the server's shortcuts: one unit leaves
    `start` for each neighbour, and from then on every node, every tick, splits all it holds
    equally among all its neighbours, the one it came from included. node -> (first tick it held
    anything, how much). The server's strengths must be exactly these."""
    def neighbours(iri):
        return sorted({link.other for link in kg.nodes[iri].links if link.other != iri})

    holding, arrived = {start.iri: Fraction(len(neighbours(start.iri)))}, {start.iri: None}
    for tick in range(1, len(kg.nodes) + 1):
        moved: dict = {}
        for iri, amount in holding.items():
            around = neighbours(iri)
            for other in around:
                moved[other] = moved.get(other, 0) + amount / len(around)
        new = {iri: (tick, amount) for iri, amount in moved.items() if iri not in arrived}
        if not new:
            break
        arrived.update(new)
        holding = moved
    del arrived[start.iri]
    return arrived


WAYS = {   # the ways of asking for nodes of one type near a start, ten at a time after `skip` of them
    "find_related": lambda kg, start, kind, skip: kg.related(start, type=kind, limit=10, offset=skip)["related"][0]["nodes"],
    "find_related, up to 8 links": lambda kg, start, kind, skip: kg.related(
        start, type=kind, limit=10, offset=skip, max_hops=m.MAX_HOPS)["related"][0]["nodes"],
    "get_neighbors": lambda kg, start, kind, skip: kg.neighbors(start, type=kind, depth=4, limit=10, offset=skip)["nodes"],
    "get_neighbors, through hubs": lambda kg, start, kind, skip: kg.neighbors(
        start, type=kind, depth=4, limit=10, offset=skip, through_hubs=True)["nodes"],
}


def look_for(kg: m.KG, start: m.Node, hidden: m.Node) -> dict:
    """One case of the measure, with the tie between `start` and `hidden` already hidden: does each
    way of asking list `hidden` among the first ten nodes of its type after the ones `start` is
    still linked to directly? Those come first in either tool, and are not news."""
    already = sum(1 for iri in start.near if kg.nodes[iri].type == hidden.type)
    return {name: hidden.id in [row["id"] for row in ask(kg, start.id, hidden.type, already)] for name, ask in WAYS.items()}


def measure_ranking(source: str | None = None, progress=None, kg: m.KG | None = None) -> dict:
    """The hidden-tie measure over every tie of the graph at `source` (or of `kg`, which is left as
    it was found: each tie is taken out and put back)."""
    kg = kg or m.GraphSource(source, 0).current()             # a graph of its own: ties are taken out and put back
    linked = sorted((node for node in kg.nodes.values() if node.near), key=lambda node: node.iri)
    exact = sum({iri: (found.hops, found.strength) for iri, found in kg._wave(start).items() if found.hops}
                == first_arrivals(kg, start) for start in linked)
    hits, cases = dict.fromkeys(WAYS, 0), 0

    def rebuild(node):                                        # the neighbours of a node, from its links
        near: dict = defaultdict(list)
        for link in node.links:
            if link.other != node.iri:
                near[link.other].append(link)
        node.near = {other: tuple(links) for other, links in near.items()}

    pairs = [(node, kg.nodes[other]) for node in linked for other in node.near if node.iri < other]
    for done, (node, other) in enumerate(pairs):
        kept = list(node.links), list(other.links)
        node.links[:] = [link for link in node.links if link.other != other.iri]
        other.links[:] = [link for link in other.links if link.other != node.iri]
        rebuild(node), rebuild(other)
        for start, hidden in ((node, other), (other, node)):
            if not start.near:
                continue                                      # it was the start's only tie: nothing to go on
            cases += 1
            for name, found in look_for(kg, start, hidden).items():
                hits[name] += found
        node.links[:], other.links[:] = kept
        rebuild(node), rebuild(other)
        if progress and done % 100 == 0:
            progress(f"ranking: {done} of {len(pairs)} ties hidden and looked for")
    lists = tied = 0
    for node in linked:
        for group in kg.related(node.id, type="Investigator")["related"]:
            if group["nodes"]:
                lists, tied = lists + 1, tied + ("tied" in group)
    return {"cases": cases, "in_first_ten": {name: round(100 * count / cases, 1) for name, count in hits.items()},
            "starts_checked_against_the_slow_version": len(linked), "starts_exactly_equal": exact,
            "lists_of_people": lists, "lists_of_people_cut_among_equals": tied}


# ---- the speed -------------------------------------------------------------------------------------

def spread(milliseconds: list, sizes: list) -> dict:
    """How long a set of calls took and how big the replies were."""
    ordered = sorted(milliseconds)
    return {"calls": len(milliseconds), "median_ms": round(statistics.median(milliseconds), 1),
            "p95_ms": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 1),
            "median_bytes": int(statistics.median(sizes)), "largest_bytes": max(sizes)}


def measure_speed(client: Client, kg: m.KG, questions: list) -> dict:
    linked = sorted((node for node in kg.nodes.values() if node.near), key=lambda node: node.iri)
    sample = linked[::5]
    calls = {
        "find_related": [("find_related", {"nodes": node.id}) for node in sample],
        "find_related, one type": [("find_related", {"nodes": node.id, "type": "Investigator"}) for node in sample],
        "find_paths": [("find_paths", {"source_node": a.id, "target_node": b.id})
                       for a, b in zip(sample, sample[7:] + sample[:7]) if b.iri in kg._wave(a)],
        "get_neighbors, two links": [("get_neighbors", {"node": node.id, "depth": 2}) for node in sample],
        "get_node": [("get_node", {"node": node.id}) for node in sample],
        "search_nodes": [("search_nodes", {"query": node.label.split()[0]}) for node in sample if node.label.split()],
        "sparql_query": [("sparql_query", {"query": q["sparql"]}) for q in questions],
    }
    out = {}
    for name, todo in calls.items():
        seconds, sizes = [], []
        for tool, arguments in todo:
            _, _, took, size = client.timed(tool, **arguments)
            seconds.append(took * 1000)
            sizes.append(size)
        out[name] = spread(seconds, sizes)
    return {"tools": out, "ready_seconds": round(client.ready_seconds, 2),
            "machine": f"{platform.system()} {platform.machine()}, Python {platform.python_version()}"}


# ---- the report ------------------------------------------------------------------------------------

def report(results: dict) -> str:
    """The results as plain text, for a terminal."""
    snapshot, out = results["snapshot"], []
    out.append(f"bbqs-kg {results['server']}: {results['nodes']} nodes, {results['links']} links, from "
               f"{snapshot['source']}" + (f", dated {snapshot['dated']}" if snapshot.get("dated") else ""))
    if "questions" in results:
        q = results["questions"]
        proposed, silent = q["asked"] - q["adopted"], q["asked"] - q["answered"] - q.get("could_not_be_asked", 0)
        out.append(f"\nQUESTIONS  {q['asked']} asked ({q['adopted']} the KG is scored on, {proposed} proposed in issue #441); "
                   f"{q['answered']} return rows on this export. Of those, the same rows as the export queried directly: "
                   f"{q['sparql_agree']} through sparql_query, {q['tools_agree']} through the graph tools. Of the other "
                   f"{silent}, {q['silent_agree']} return nothing either way"
                   + (f"; {q['could_not_be_asked']} could not be asked" if q.get("could_not_be_asked") else "")
                   + ("." if q["all_agree"] else ": NOT ALL AGREE, see below."))
        for r in q["questions"]:
            def mark(ok, rows=r["rows"]):
                return "—" if rows is None else "DIFFERENT" if not ok else "same" if rows else "none"
            if r["set"] == "proposed" and r["id"] == next(x["id"] for x in q["questions"] if x["set"] == "proposed"):
                out.append("  -- proposed in issue #441, not adopted yet --")
            out.append(f"  {r['id']}  {'—' if r['rows'] is None else r['rows']:>4} rows  sparql {mark(r['sparql_agrees']):9s} {r['sparql_ms']:7.1f} ms   "
                       f"tools {mark(r['tools_agree']):9s} {r['tools_ms']:7.1f} ms {r['tool_calls']:4d} calls   "
                       f"{r['status']:21s} {r['question']}" + (f"\n        {r['error']}" if r.get("error") else ""))
    if "ranking" in results:
        r = results["ranking"]
        out.append(f"\nRANKING  {r['cases']} cases: one real tie hidden, the other end looked for among the first ten of its type "
                   "listed after the start's direct ties")
        for name, share in r["in_first_ten"].items():
            out.append(f"  {name:30s} {share:5.1f}%")
        out.append(f"  strengths exactly equal to the slow version of the rule: {r['starts_exactly_equal']} of "
                   f"{r['starts_checked_against_the_slow_version']} starting nodes")
        out.append(f"  default lists of people cut among equals: {r['lists_of_people_cut_among_equals']} of {r['lists_of_people']}")
    if "speed" in results:
        s = results["speed"]
        out.append(f"\nSPEED  over stdio, {s['machine']}; ready {s['ready_seconds']} s after starting")
        for name, t in s["tools"].items():
            out.append(f"  {name:26s} {t['calls']:4d} calls   median {t['median_ms']:6.1f} ms   95th {t['p95_ms']:6.1f} ms   "
                       f"reply median {t['median_bytes']:6d} bytes, largest {t['largest_bytes']:6d}")
    return "\n".join(out)


def markdown(results: dict) -> str:
    """The results as the block the main README carries, between its two markers."""
    snapshot = results["snapshot"]
    q, r, s = results.get("questions"), results.get("ranking"), results.get("speed")
    out = [START, f"Graph: {results['nodes']} nodes, {results['links']} links"
           + (f", export of {snapshot['dated']}" if snapshot.get("dated") else "") + f". Server {results['server']}.", ""]
    if q:
        proposed, refused = q["asked"] - q["adopted"], q.get("could_not_be_asked", 0)
        silent = q["asked"] - q["answered"] - refused
        rest = [f"{q[key]} {what}" for key, what in (("need_the_full_export", "need the full export"),
                                                     ("none_in_this_export", "find none in this export"),
                                                     ("not_modelled", "not modelled yet")) if q.get(key)]
        out += ["| | Result |", "|---|---|",
                f"| Competency questions that return rows on this export | **{q['answered']} of {q['asked']}**: "
                f"{q['answered_adopted']} of the {q['adopted']} the KG is scored on"
                + (f", {q['answered'] - q['answered_adopted']} of the {proposed} proposed in #441" if proposed else "") + " |",
                f"| Those {q['answered']}, asked as SPARQL through the server: same rows as the export queried directly | "
                f"**{q['sparql_agree']} of {q['answered']}** |",
                f"| Those {q['answered']}, asked without SPARQL through the graph tools: same rows again | "
                f"**{q['tools_agree']} of {q['answered']}** |"]
        if silent:
            out.append(f"| The other {silent}" + (f" ({', '.join(rest)})" if rest else "") + ": no rows either way | "
                       f"**{q['silent_agree']} of {silent}** |")
        if refused:
            out.append(f"| {refused} could not be asked: the export queried directly refused {'it' if refused == 1 else 'them'} "
                       "| **not compared** |")
    if r:
        first = r["in_first_ten"]
        out += [f"| Hide a real tie: the hidden end is among the first ten `find_related` lists after the start's direct ties "
                f"({r['cases']:,} cases) | **{first['find_related']:.0f}%** "
                f"({first['find_related, up to 8 links']:.0f}% looking up to 8 links) |",
                f"| The same for `get_neighbors`, which lists by distance alone | {first['get_neighbors']:.0f}% "
                f"({first['get_neighbors, through hubs']:.0f}% walking through hubs) |",
                f"| Strengths equal to a slow second version of the rule, exactly | **{r['starts_exactly_equal']} of "
                f"{r['starts_checked_against_the_slow_version']}** starting nodes |"]
    if s:
        t = s["tools"]
        out += [f"| A `find_related` call (median; 95th percentile) | {t['find_related']['median_ms']:.0f} ms; "
                f"{t['find_related']['p95_ms']:.0f} ms |",
                f"| A `find_paths` call | {t['find_paths']['median_ms']:.0f} ms; {t['find_paths']['p95_ms']:.0f} ms |",
                f"| A `find_related` reply (median; largest of the {t['find_related']['calls']} timed) | "
                f"{t['find_related']['median_bytes'] / 1000:.1f} kB; {t['find_related']['largest_bytes'] / 1000:.1f} kB |"]
    if q:
        out += ["", f"<details><summary>All {q['asked']} questions, both ways</summary>", "",
                "| | Question | Rows | As SPARQL | Without SPARQL | How, without SPARQL |", "|---|---|---:|:---:|:---:|---|"]
        first_proposed = next((row["id"] for row in q["questions"] if row["set"] == "proposed"), None)
        for row in q["questions"]:
            if row["id"] == first_proposed:
                out.append("| | **Proposed in [#441](https://github.com/brain-bbqs/bbqs-app/issues/441), not adopted yet** | | | | |")
            note = "" if row["status"] == "answered" else f" *({row['status']})*"
            cells = ["—" if row["rows"] is None else "**differs**" if not ok else "same" if row["rows"] else "none"
                     for ok in (row["sparql_agrees"], row["tools_agree"])]
            shown = "—" if row["rows"] is None else row["rows"]
            out.append(f"| {row['id']} | {row['question']}{note} | {shown} | {cells[0]} | {cells[1]} | {row['how']} |")
        out += ["", f"The first {q['adopted']} are the questions the knowledge graph is scored on "
                    "([`kg/competency_questions.yaml`](kg/competency_questions.yaml))."
                    + (" The rest are the extended set proposed in [#441](https://github.com/brain-bbqs/bbqs-app/issues/441) "
                       "([`kg/competency_questions_extended.yaml`](kg/competency_questions_extended.yaml)); they count toward "
                       "nothing until that issue adopts them." if first_proposed else "")
                    + " A question of the form \"which X has no Y\" lists every X with no Y *recorded*, which in a graph "
                    "still being linked is not the same as having none.", "", "</details>"]
    if s:
        out += ["", f"Times are over stdio on one machine ({s['machine']}) and will differ on yours. Everything else is the "
                    "same wherever it is run."]
    out.append(END)
    return "\n".join(out)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark kg/mcp_server.py with the consortium's competency questions.")
    parser.add_argument("--source", default=str(m.BUNDLED_EXPORT), metavar="PATH",
                        help="Turtle file to serve and to check against (default: the committed export).")
    parser.add_argument("--only", choices=PARTS, action="append", help="Run only this part (may be repeated).")
    parser.add_argument("--show", metavar="ID", help="Print the rows of one question, e.g. CQ04, each way it was asked.")
    parser.add_argument("--access", choices=("anon", "full"), default="anon",
                        help="What the export is: the public one (default) or a full one, with jobs and provenance.")
    parser.add_argument("--json", metavar="PATH", help="Also write the results as JSON.")
    parser.add_argument("--markdown", action="store_true", help="Print the results as the README block.")
    parser.add_argument("--update", metavar="README", help="Rewrite the block between the benchmark markers in this file.")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):                    # names in the graph are not all ASCII
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parts = args.only or (["questions"] if args.show else list(PARTS))
    if args.update and set(parts) != set(PARTS):
        parser.error("--update needs every part: leave --only and --show out.")

    def say(text):
        print(text, file=sys.stderr, flush=True)

    kg = m.GraphSource(args.source, 0).current()
    cite = kg.cite()
    results = {"server": m.__version__, "nodes": len(kg.nodes), "links": sum(kg.edge_counts.values()),
               "snapshot": {"source": cite["graph"], **({"dated": cite["dated"]} if "dated" in cite else {})}}
    client = Client(args.source)
    try:
        if "questions" in parts:
            say("questions: asking each one over MCP, as SPARQL and through the graph tools")
            results["questions"] = ask_questions(client, kg, args.source, args.show, access=args.access)
        if "speed" in parts:
            say("speed: timing calls on real nodes")
            results["speed"] = measure_speed(client, kg, load_questions()[0])
    finally:
        client.close()
    if "ranking" in parts:
        say("ranking: hiding each tie in turn (about a minute)")
        results["ranking"] = measure_ranking(args.source, say)
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=1, ensure_ascii=False) + "\n", encoding="utf8")
    if args.update:
        readme = Path(args.update)
        text = readme.read_text(encoding="utf8")
        if START not in text or END not in text:
            parser.error(f"{readme} has no benchmark block: it needs the lines {START} and {END}.")
        readme.write_text(text[:text.index(START)] + markdown(results) + text[text.index(END) + len(END):], encoding="utf8")
        say(f"updated the block in {readme}")
    if not args.show:
        print(markdown(results) if args.markdown else report(results))
    return 1 if "questions" in results and not results["questions"]["all_agree"] else 0


if __name__ == "__main__":
    sys.exit(main())
