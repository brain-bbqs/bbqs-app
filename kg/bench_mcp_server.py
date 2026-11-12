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

  questions  Every competency question in competency_questions.yaml, asked twice over MCP: as SPARQL
             through sparql_query, and without SPARQL through the graph tools (search_nodes,
             get_node, find_related). Each way must return the rows the export gives when it is
             queried directly, with no server in between. Exit code 1 if any does not.
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
import platform
import queue
import re
import statistics
import subprocess
import sys
import threading
import time
from collections import defaultdict
from fractions import Fraction
from pathlib import Path

import yaml
from rdflib import Graph

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import mcp_server as m  # noqa: E402

SERVER = HERE / "mcp_server.py"
QUESTIONS = HERE / "competency_questions.yaml"
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

    def all_of(self, kind: str) -> list:
        """Every node of one type (search_nodes, a page at a time); none if the graph has no such type."""
        if ("all", kind) not in self.cache:
            found, total = [], None
            while total is None or len(found) < total:
                page, error, _, _ = self.timed("search_nodes", type=kind, limit=100, offset=len(found))
                if error:                                   # "Unknown node type": nothing of that kind was exported
                    break
                total = page["total"]
                found += page["results"]
            self.cache["all", kind] = found
        return self.cache["all", kind]

    def node(self, node_id: str) -> dict:
        """One node in full (get_node): its properties, and how many links of each kind it has."""
        if ("node", node_id) not in self.cache:
            self.cache["node", node_id] = self.call("get_node", node=node_id, edge_limit=0)
        return self.cache["node", node_id]

    def values(self, node_id: str, name: str) -> list:
        """Every value a node has for one property."""
        value = self.node(node_id)["properties"].get(name, [])
        return value if isinstance(value, list) else [value]

    def tied(self, node: str, kind: str, edges: set) -> list:
        """The nodes of one type directly tied to `node` by one of `edges` (find_related, one link away,
        a page at a time), each with the link that ties it."""
        found, reached = [], None
        while reached is None or len(found) < reached:
            reply, error, _, _ = self.timed("find_related", nodes=node, type=kind, max_hops=1, limit=25, offset=len(found))
            if error:                                       # no such type in this graph
                return []
            group = reply["related"][0]
            reached = group["reached"]
            found += group["nodes"]
            if not group["nodes"]:
                break
        return [row for row in found if {row["link"]["edge"], *row["link"].get("also", ())} & edges]


def bid(node_id: str) -> str:
    """A node, as sparql_query writes one in a cell."""
    return "bid:" + node_id


# ---- the questions, without SPARQL -----------------------------------------------------------------
# Each takes the client and returns the rows the question's SPARQL would, in the same column order,
# using only search_nodes, get_node and find_related. `how` says in a few words which.

def cq01(c):
    return [[bid(p["id"]), number, mechanism] for p in c.all_of("Project")
            for number in c.values(p["id"], "grant_number") for mechanism in c.values(p["id"], "mechanism") or [None]]


def cq02(c):
    count, total = defaultdict(int), defaultdict(int)
    for p in c.all_of("Project"):
        for mechanism in c.values(p["id"], "mechanism"):
            for amount in c.values(p["id"], "award_amount"):
                count[mechanism] += 1
                total[mechanism] += amount
    return [[mechanism, count[mechanism], total[mechanism]] for mechanism in count]


def cq03(c):
    return [[bid(p["id"]), number, name] for p in c.all_of("Project")
            for org in c.tied(p["id"], "ResearchOrganization", {"part_of_org"})
            for number in c.values(p["id"], "grant_number") for name in c.values(org["id"], "name")]


def cq04(c):
    return [[name, person["link"]["role"]] for person in c.tied("R34DA059723", "Investigator", {"has_role"})
            if "role" in person["link"] for name in c.values(person["id"], "name")]


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
    return [[name, f"<{orcid}>"] for person in c.all_of("Investigator")
            for name in c.values(person["id"], "name") for orcid in c.values(person["id"], "orcid")]


def cq08(c):
    return [[name] for person in c.tied("WG-Devices", "Investigator", {"member_of_group"})
            for name in c.values(person["id"], "name")]


def cq09(c):
    return [[bid(p["id"]), number] for p in c.tied("House Mouse", "Project", {"studies_species"})
            for number in c.values(p["id"], "grant_number")]


def cq10(c):
    mammals, found = [], None
    while found is None or len(mammals) < found:
        page = c.call("search_nodes", type="Species", where={"taxonomy_class": "Mammalia"}, limit=100, offset=len(mammals))
        found = page["total"]
        mammals += page["results"]
    rows = {(bid(p["id"]), number) for species in mammals for p in c.tied(species["id"], "Project", {"studies_species"})
            for number in c.values(p["id"], "grant_number")}
    return [list(row) for row in rows]


def cq11(c):
    rows = []
    for p in c.all_of("Project"):
        full = c.node(p["id"])
        if "studies_species" in full["properties"] or any(e["edge"] == "studies_species" for e in full["edges"]):
            continue                                        # it names a species, resolved to a node or not
        rows += [[bid(p["id"]), number, scope] for number in c.values(p["id"], "grant_number")
                 for scope in c.values(p["id"], "study_scope") or [None]]
    return rows


def cq12(c):
    return [[number, title] for p in c.all_of("Project") for paper in c.tied(p["id"], "Publication", {"produced"})
            for number in c.values(p["id"], "grant_number") for title in c.values(paper["id"], "title")]


def cq13(c):
    return [[number, name] for p in c.all_of("Project")
            for dataset in c.tied(p["id"], "Dataset", {"funded_datasets", "produced"})
            for number in c.values(p["id"], "grant_number") for name in c.values(dataset["id"], "name")]


def cq14(c):
    return [[number, label] for p in c.all_of("Project")
            for category in c.tied(p["id"], "DeviceCategory", {"uses_device_category"})
            for number in c.values(p["id"], "grant_number") for label in c.values(category["id"], "label")]


def cq15(c):
    rows = []
    for device in c.all_of("Device"):
        categories = [bid(row["id"]) for row in c.tied(device["id"], "DeviceCategory", {"device_category"})] or [None]
        rows += [[name, model, category] for maker in c.tied(device["id"], "DeviceManufacturer", {"manufacturer"})
                 for name in c.values(maker["id"], "name") for model in c.values(device["id"], "model_name")
                 for category in categories]
    return rows


def cq16(c):
    return [[name, repo] for tool in c.all_of("SoftwareTool")
            for name in c.values(tool["id"], "name") for repo in c.values(tool["id"], "repo_url")]


def cq17(c):
    return [[name, expires] for call in c.all_of("FundingOpportunity") for name in c.values(call["id"], "name")
            for expires in c.values(call["id"], "expiration_date") if expires > "2026-09-29"]


def cq18(c):
    return [[name, institution] for job in c.all_of("Job")
            for name in c.values(job["id"], "name") for institution in c.values(job["id"], "job_institution")]


def cq19(c):
    local = c.node("R34DA059723")["iri"].rsplit("/", 1)[-1]     # the project's own id, as the records name it
    rows = []
    for record in c.all_of("ProvenanceRecord"):
        if local not in c.values(record["id"], "prov_entity_id") or "title" not in c.values(record["id"], "prov_entity_column"):
            continue
        sources = [(bid(source["id"]), c.values(source["id"], "grade") or [None])
                   for source in c.tied(record["id"], "SourceClass", {"prov_source_class"})]
        sources += [(f"<{iri}>", [None]) for iri in c.values(record["id"], "prov_source_class")]   # named, not exported
        rows += [[value, source, grade] for value in c.values(record["id"], "prov_value_text")
                 for source, grades in sources for grade in grades]
    return rows


WALKS = {
    "CQ01": (cq01, "list the projects; read each one's properties"),
    "CQ02": (cq02, "list the projects; add up their awards by mechanism"),
    "CQ03": (cq03, "from each project, the organization one link away"),
    "CQ04": (cq04, "from the project, the people one link away, with the role on the link"),
    "CQ05": (cq05, "from each project, its people; count the projects per person"),
    "CQ06": (cq06, "from each organization, the people one link away"),
    "CQ07": (cq07, "list the investigators; read each one's ORCID"),
    "CQ08": (cq08, "from the working group, the people one link away"),
    "CQ09": (cq09, "from the species, the projects one link away"),
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
}


def same(rows) -> list:
    """Rows in one order and one spelling, so two ways of asking can be compared."""
    def cell(value):
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value
    return sorted(json.dumps([cell(v) for v in row], sort_keys=True, default=str, ensure_ascii=False) for row in rows)


def ask_questions(client: Client, kg: m.KG, source: str, show: str | None = None, fresh: bool = True) -> dict:
    """Every question, three ways: the export queried directly (the reference), sparql_query over MCP,
    and the graph tools over MCP. `fresh` forgets, before each question, what earlier ones fetched."""
    spec = yaml.safe_load(QUESTIONS.read_text(encoding="utf8"))
    prologue = "".join(f"PREFIX {k}: <{v}>\n" for k, v in spec["prefixes"].items())
    plain = Graph().parse(source, format="turtle")            # the export itself, with no server in between
    schema = {str(s)[len(m.SCHEMA_NS):] for s in Graph().parse(str(m.SCHEMA_FILE), format="turtle").subjects()
              if str(s).startswith(m.SCHEMA_NS)} if m.SCHEMA_FILE.exists() else None
    rows_out = []
    for question in spec["questions"]:
        direct = same([kg._cell(cell) for cell in row] for row in plain.query(prologue + question["sparql"]))
        reply, error, sparql_seconds, _ = client.timed("sparql_query", query=question["sparql"], limit=m.MAX_ROWS)
        by_sparql = same(reply["rows"]) if reply else None
        walk, how = WALKS[question["id"]]
        if fresh:
            client.cache = {}                                 # each question from scratch, as a client would ask it
        calls, began = client.calls, time.perf_counter()
        by_tools = same(walk(client))
        walk_seconds, calls = time.perf_counter() - began, client.calls - calls
        terms = set(re.findall(r"\bbbqs:(\w+)", question["sparql"]))
        if schema is not None and terms - schema:
            status = "not modelled"                           # the schema has no such term: nothing can answer it yet
        elif direct:
            status = "answered"
        elif question["access"] == "full":
            status = "needs the full export"                  # its source rows are not public
        else:
            status = "empty"
        rows_out.append({"id": question["id"], "question": question["question"], "area": question["area"],
                         "status": status, "rows": len(direct), "sparql_agrees": by_sparql == direct,
                         "tools_agree": by_tools == direct, "how": how, "tool_calls": calls,
                         "sparql_ms": round(sparql_seconds * 1000, 1), "tools_ms": round(walk_seconds * 1000, 1),
                         **({"error": error} if error else {})})
        if show == question["id"]:
            print(f"{question['id']}  {question['question']}\n  status: {status}; {len(direct)} rows from the export queried directly")
            for name, got in (("sparql_query", by_sparql or []), (f"graph tools ({how})", by_tools)):
                print(f"\n  through {name}: {len(got)} rows, {'the same' if got == direct else 'DIFFERENT'}")
                for row in got[:200]:
                    print("    " + row)
                for row in sorted(set(direct) - set(got))[:20]:
                    print("    MISSING " + row)
    answered = [r for r in rows_out if r["rows"]]
    return {"asked": len(rows_out), "answered": len(answered),
            "need_the_full_export": sum(r["status"] == "needs the full export" for r in rows_out),
            "not_modelled": sum(r["status"] == "not modelled" and not r["rows"] for r in rows_out),
            "sparql_agree": sum(r["sparql_agrees"] for r in answered), "tools_agree": sum(r["tools_agree"] for r in answered),
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


def measure_ranking(source: str, progress=None) -> dict:
    kg = m.GraphSource(source, 0).current()                   # a graph of its own: ties are taken out and put back
    linked = sorted((node for node in kg.nodes.values() if node.near), key=lambda node: node.iri)
    exact = sum({iri: (found.hops, found.strength) for iri, found in kg._wave(start).items() if found.hops}
                == first_arrivals(kg, start) for start in linked)
    ways = {"find_related": lambda start, kind, skip: kg.related(start, type=kind, limit=10, offset=skip)["related"][0]["nodes"],
            "find_related, up to 8 links": lambda start, kind, skip: kg.related(
                start, type=kind, limit=10, offset=skip, max_hops=m.MAX_HOPS)["related"][0]["nodes"],
            "get_neighbors": lambda start, kind, skip: kg.neighbors(start, type=kind, depth=4, limit=10, offset=skip)["nodes"],
            "get_neighbors, through hubs": lambda start, kind, skip: kg.neighbors(
                start, type=kind, depth=4, limit=10, offset=skip, through_hubs=True)["nodes"]}
    hits, cases = dict.fromkeys(ways, 0), 0

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
            already = sum(1 for iri in start.near if kg.nodes[iri].type == hidden.type)   # these head the list
            for name, ask in ways.items():
                hits[name] += hidden.id in [row["id"] for row in ask(start.id, hidden.type, already)]
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
        ordered = sorted(seconds)
        out[name] = {"calls": len(todo), "median_ms": round(statistics.median(seconds), 1),
                     "p95_ms": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 1),
                     "median_bytes": int(statistics.median(sizes)), "largest_bytes": max(sizes)}
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
        out.append(f"\nQUESTIONS  {q['asked']} asked; {q['answered']} have an answer in this export. Of those, the same rows as "
                   f"the export queried directly: {q['sparql_agree']} through sparql_query, {q['tools_agree']} through the "
                   "graph tools. The rest return nothing either way" + ("." if q["all_agree"] else ": NOT SO, see below."))
        for r in q["questions"]:
            def mark(ok, rows=r["rows"]):
                return "DIFFERENT" if not ok else "same" if rows else "none"
            out.append(f"  {r['id']}  {r['rows']:4d} rows  sparql {mark(r['sparql_agrees']):9s} {r['sparql_ms']:7.1f} ms   "
                       f"tools {mark(r['tools_agree']):9s} {r['tools_ms']:7.1f} ms {r['tool_calls']:4d} calls   "
                       f"{r['status']:21s} {r['question']}")
    if "ranking" in results:
        r = results["ranking"]
        out.append(f"\nRANKING  {r['cases']} cases: one real tie hidden, the other end looked for among the first ten of its type")
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
        rest = [f"{q[key]} {what}" for key, what in (("need_the_full_export", "need the full export"),
                                                     ("not_modelled", "not modelled yet")) if q[key]]
        out += ["| | Result |", "|---|---|",
                f"| Competency questions with an answer in this export | **{q['answered']} of {q['asked']}**"
                + (f" ({', '.join(rest)})" if rest else "") + " |",
                f"| Those {q['answered']}, asked as SPARQL through the server: same rows as the export queried directly | "
                f"**{q['sparql_agree']} of {q['answered']}** |",
                f"| Those {q['answered']}, asked without SPARQL through the graph tools: same rows again | "
                f"**{q['tools_agree']} of {q['answered']}** |"]
    if r:
        first = r["in_first_ten"]
        out += [f"| A hidden tie is in the first ten `find_related` returns ({r['cases']:,} cases) | "
                f"**{first['find_related']:.0f}%** ({first['find_related, up to 8 links']:.0f}% looking up to 8 links) |",
                f"| The same for `get_neighbors`, which lists by distance alone | {first['get_neighbors']:.0f}% "
                f"({first['get_neighbors, through hubs']:.0f}% walking through hubs) |",
                f"| Strengths equal to a slow second version of the rule, exactly | **{r['starts_exactly_equal']} of "
                f"{r['starts_checked_against_the_slow_version']}** starting nodes |"]
    if s:
        t = s["tools"]
        out += [f"| A `find_related` call (median; 95th percentile) | {t['find_related']['median_ms']:.0f} ms; "
                f"{t['find_related']['p95_ms']:.0f} ms |",
                f"| A `find_paths` call | {t['find_paths']['median_ms']:.0f} ms; {t['find_paths']['p95_ms']:.0f} ms |",
                f"| A `find_related` reply (median; largest) | {t['find_related']['median_bytes'] / 1000:.1f} kB; "
                f"{t['find_related']['largest_bytes'] / 1000:.1f} kB |"]
    if q:
        out += ["", "<details><summary>Every question, both ways</summary>", "",
                "| | Question | Rows | As SPARQL | Without SPARQL | How, without SPARQL |", "|---|---|---:|:---:|:---:|---|"]
        for row in q["questions"]:
            note = "" if row["status"] == "answered" else f" *({row['status']})*"
            cells = ["**differs**" if not ok else "same" if row["rows"] else "none"
                     for ok in (row["sparql_agrees"], row["tools_agree"])]
            out.append(f"| {row['id']} | {row['question']}{note} | {row['rows']} | {cells[0]} | {cells[1]} | {row['how']} |")
        out += ["", "</details>"]
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
            results["questions"] = ask_questions(client, kg, args.source, args.show)
        if "speed" in parts:
            say("speed: timing calls on real nodes")
            questions = yaml.safe_load(QUESTIONS.read_text(encoding="utf8"))["questions"]
            results["speed"] = measure_speed(client, kg, questions)
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
