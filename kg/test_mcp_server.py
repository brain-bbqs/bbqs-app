#!/usr/bin/env python3
"""Tests for kg/mcp_server.py.

    python kg/test_mcp_server.py        # needs kg/requirements.txt and kg/requirements-mcp.txt

Four layers, each catching what the others cannot:

  the view      -- a small hand-built graph whose every answer was worked out by hand: folding the
                   roster, shared identifiers, references, search, neighbours, relatedness, paths,
                   SPARQL.
  the export    -- the committed graph: every competency question the baseline says is answered
                   comes back through sparql_query, the walking tools agree with SPARQL, and the
                   ranking is the natural process it is named after, and earns its keep.
  the guards    -- cross-file invariants: schema terms the server names exist in the TBox, the
                   pinned dependencies agree, and no tool can change the graph.
  the protocol  -- the server as a client sees it: a real process, raw JSON-RPC over stdio and
                   over streamable HTTP. Nothing here is skipped when a dependency is missing.
"""
import asyncio
import http.server
import inspect
import json
import os
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from collections import Counter
from fractions import Fraction
from pathlib import Path
from unittest import mock

import yaml
from rdflib import Graph

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bench_mcp_server as bench  # noqa: E402
import mcp_server as m  # noqa: E402

SERVER = HERE / "mcp_server.py"
EXPORT = HERE / "export" / "bbqs.ttl"

# ---- the fixture: small enough to check every answer by hand --------------------------------------
ADA, BOB, CYD, DEE = "11111111", "22222222", "33333333", "44444444"
P1, P2, P3 = "55555555", "66666666", "77777777"
MOUSE, ZEBRA, WGD, WGA, ORG = "88888888", "99999999", "aaaa1111", "bbbb2222", "cccc3333"
PUB1, PUB2, PUB3, DS1, DEV, CAT, MAN = "dddd4444", "eeee5555", "ffff6666", "0000aaaa", "0000bbbb", "0000cccc", "0000dddd"
TWIN1, TWIN2 = "a1b2c3d4-0002", "a1b2c3d4-0004"      # ids that start alike, as two seeded rows do
O1 = "https://orcid.org/0000-0001-0000-0001"           # Ada's, and on PUB1's author list
O4 = "https://orcid.org/0000-0004-0000-0004"           # on PUB2 and PUB3; nobody in the graph owns it


def _iri(short: str) -> str:
    """The fixture's full id for a short one, as a Turtle name."""
    return f"bid:{short}-4000-8000-000000000001" if "-" in short else f"bid:{short}-0000-4000-8000-000000000001"


FIXTURE = f"""
@prefix bbqs: <https://brain-bbqs.org/schema#> .
@prefix bid: <https://brain-bbqs.org/id/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

{_iri(ADA)} a bbqs:Investigator ; bbqs:name "Ada Lovelace" ; bbqs:consortium_role "Principal Investigator (PI)" ;
    bbqs:orcid <{O1}> ; bbqs:skills "pose estimation" ; bbqs:member_of_group {_iri(WGD)} .
{_iri(BOB)} a bbqs:Investigator ; bbqs:name "Bob Müller" ; bbqs:orcid <https://orcid.org/0000-0002-0000-0002> ;
    bbqs:member_of_group {_iri(WGD)}, {_iri(WGA)} .
{_iri(CYD)} a bbqs:Investigator ; bbqs:name "Cyd  Charisse" ; bbqs:member_of_group {_iri(WGA)} .
{_iri(DEE)} a bbqs:Investigator ; bbqs:name "Dee Isolated" .
{_iri(TWIN1)} a bbqs:Investigator ; bbqs:name "Sam Twin" .
{_iri(TWIN2)} a bbqs:Investigator ; bbqs:name "Sam Twin" .

{_iri(P1)} a bbqs:Project ; bbqs:name "R34DA000001" ; bbqs:grant_number "R34DA000001" ; bbqs:mechanism "R34" ;
    bbqs:title "Mouse social behavior tracking" ; bbqs:award_amount 100 ; bbqs:studies_human false ;
    bbqs:abstract "We record ultrasonic vocalizations during social play." ;
    bbqs:keywords "social behavior", "computer vision" ;
    bbqs:studies_species {_iri(MOUSE)} ; bbqs:part_of_org {_iri(ORG)} ; bbqs:produced {_iri(PUB1)} ;
    bbqs:funded_datasets {_iri(DS1)} .
{_iri(P2)} a bbqs:Project ; bbqs:name "Zebrafish imaging at scale" ; bbqs:grant_number "R61MH000002" ;
    bbqs:mechanism "R61" ; bbqs:award_amount 250 ; bbqs:studies_species {_iri(ZEBRA)} ; bbqs:produced {_iri(PUB2)} .
{_iri(P3)} a bbqs:Project ; bbqs:name "U01DA000003" ; bbqs:grant_number "U01DA000003" ; bbqs:mechanism "U01" ;
    bbqs:title "Mouse foraging" ; bbqs:studies_species {_iri(MOUSE)} .

<https://brain-bbqs.org/id/role/r1> a bbqs:ProjectRole ; bbqs:held_by {_iri(ADA)} ; bbqs:on_project {_iri(P1)} ;
    bbqs:project_role "contact_pi" ; bbqs:role_source "reporter" .
<https://brain-bbqs.org/id/role/r2> a bbqs:ProjectRole ; bbqs:held_by {_iri(BOB)} ; bbqs:on_project {_iri(P1)} ;
    bbqs:project_role "co_pi" ; bbqs:role_source "curator" .
<https://brain-bbqs.org/id/role/r3> a bbqs:ProjectRole ; bbqs:held_by {_iri(BOB)} ; bbqs:on_project {_iri(P2)} ;
    bbqs:project_role "contact_pi" ; bbqs:role_source "reporter" .
<https://brain-bbqs.org/id/role/r4> a bbqs:ProjectRole ; bbqs:held_by {_iri(CYD)} ; bbqs:on_project {_iri(P2)} ;
    bbqs:project_role "postdoc" ; bbqs:role_source "curator" .
<https://brain-bbqs.org/id/role/r5> a bbqs:ProjectRole ; bbqs:on_project {_iri(P3)} ;
    bbqs:project_role "co_pi" ; bbqs:role_source "reporter" .

{_iri(MOUSE)} a bbqs:Species ; bbqs:name "Mouse" ; bbqs:common_name "House Mouse" ;
    bbqs:aliases "Mus musculus", "mice" ; bbqs:taxonomy_class "Mammalia" .
{_iri(ZEBRA)} a bbqs:Species ; bbqs:name "Zebrafish" ; bbqs:common_name "Zebrafish" .
{_iri(WGD)} a bbqs:WorkingGroup ; bbqs:name "WG-Devices" .
{_iri(WGA)} a bbqs:WorkingGroup ; bbqs:name "WG-Analytics" .
{_iri(ORG)} a bbqs:ResearchOrganization ; bbqs:name "UNIVERSITY OF TESTING" ; bbqs:members {_iri(ADA)}, {_iri(TWIN1)} .
{_iri(PUB1)} a bbqs:Publication ; bbqs:name "A paper about mice" ; bbqs:title "A paper about mice" ;
    bbqs:doi "10.1000/test.1"^^xsd:anyURI ; bbqs:pmid "111" ; bbqs:year 2025 ;
    bbqs:author_orcids <{O1}>, <https://orcid.org/0000-0003-0000-0003> .
{_iri(PUB2)} a bbqs:Publication ; bbqs:name "Fish at scale" ; bbqs:year 2024 ; bbqs:author_orcids <{O4}> .
{_iri(PUB3)} a bbqs:Publication ; bbqs:name "Unattached preprint" ; bbqs:year 2024 ; bbqs:author_orcids <{O4}> .
{_iri(DS1)} a bbqs:Dataset ; bbqs:name "Mouse food sniff" ; bbqs:award_numbers "R34DA000001" .
{_iri(DEV)} a bbqs:Device ; bbqs:name "Scope One" ; bbqs:model_name "Scope One" ;
    bbqs:device_category {_iri(CAT)} ; bbqs:manufacturer {_iri(MAN)} .
{_iri(CAT)} a bbqs:DeviceCategory ; bbqs:name "Microscopes" ; bbqs:label "Microscopes" ; bbqs:category_key "microscope" .
{_iri(MAN)} a bbqs:DeviceManufacturer ; bbqs:name "Lens Co" .
"""


def fixture_kg() -> m.KG:
    return m.KG(m._BudgetedGraph().parse(data=FIXTURE, format="turtle"), {"source": "fixture"})


def ids(rows) -> list[str]:
    return [row["id"] for row in rows]


def small_kg(turtle: str) -> m.KG:
    """A few lines of Turtle as a graph, for a case the fixture does not hold."""
    prefixes = "@prefix bbqs: <https://brain-bbqs.org/schema#> .\n@prefix bid: <https://brain-bbqs.org/id/> .\n"
    return m.KG(m._BudgetedGraph().parse(data=prefixes + turtle, format="turtle"))


def first_arrivals(kg: m.KG, start: m.Node, avoid=()) -> dict:
    """Activation spreading with nothing left out, written without the server's shortcuts: one unit
    leaves `start` for each of its neighbours, and from then on every node, every tick, splits all
    it holds equally among all its neighbours, the one it came from included. Returns node -> (the
    first tick it held anything, how much it held then)."""
    def neighbours(iri):
        return sorted({link.other for link in kg.nodes[iri].links if link.edge not in avoid and link.other != iri})

    holding = {start.iri: Fraction(len(neighbours(start.iri)))}     # so that one unit goes to each neighbour
    arrived = {start.iri: None}
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


class TheView(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kg = fixture_kg()

    def err(self, fn, *args, **kwargs) -> str:
        with self.assertRaises(m.KGError) as caught:
            fn(*args, **kwargs)
        return str(caught.exception)

    # -- what counts as a node and a link --

    def test_counts(self):
        d = self.kg.describe()
        self.assertEqual((d["nodes"], d["links"], d["unlinked_nodes"]), (23, 23, 2))
        people = next(t for t in d["node_types"] if t["type"] == "Investigator")
        self.assertEqual((people["count"], people["unlinked"]), (6, 2))
        self.assertEqual(people["properties"]["name"], 6)
        self.assertEqual(people["properties"]["orcid"], 2)      # filled on 2 of 6: absence is visible

    def test_one_type_in_full_says_what_its_properties_mean_and_hold(self):
        project = self.kg.describe(type="project")
        self.assertEqual((project["type"], project["count"], project["unlinked"]), ("Project", 3, 0))
        self.assertIn("grant_number", project["description"])           # the schema's own definition of a Project
        by_name = {row["property"]: row for row in project["properties"]}
        self.assertEqual(by_name["mechanism"]["values"], {"R34": 1, "R61": 1, "U01": 1})   # few values: a vocabulary
        self.assertEqual(by_name["mechanism"]["filled"], 3)
        self.assertEqual(by_name["grant_number"]["description"], "NIH grant number; encodes mechanism.")
        self.assertEqual(by_name["abstract"]["example"], "We record ultrasonic vocalizations during social play.")
        self.assertEqual((by_name["title"]["filled"], by_name["award_amount"]["filled"]), (2, 2))
        self.assertIn({"edge": "has_role", "direction": "in", "other": "Investigator", "count": 4}, project["links"])
        self.assertIn({"edge": "studies_species", "direction": "out", "other": "Species", "count": 3}, project["links"])
        self.assertIn("ORCID", self.kg.describe(type=m.EXTERNAL)["description"])
        self.assertIn("Investigator", self.err(self.kg.describe, type="Person"))

    def test_without_the_schema_file_only_the_descriptions_are_lost(self):
        m._definitions.cache_clear()
        self.addCleanup(m._definitions.cache_clear)
        with mock.patch.object(m, "SCHEMA_FILE", HERE / "no-such-schema.ttl"):
            project = self.kg.describe(type="Project")
        self.assertNotIn("description", project)
        self.assertEqual(len(project["properties"]), 8)
        self.assertTrue(all("description" not in row for row in project["properties"]))

    def test_roster_records_become_one_link_carrying_the_role(self):
        d = self.kg.describe()
        self.assertNotIn("ProjectRole", [t["type"] for t in d["node_types"]])
        roster = next(e for e in d["edge_types"] if e["edge"] == "has_role")
        self.assertEqual((roster["from"], roster["to"], roster["count"]), ("Investigator", "Project", 4))
        self.assertEqual(roster["carries"]["role"], {"contact_pi": 2, "co_pi": 1, "postdoc": 1})
        on_p1 = self.kg.neighbors(P1, edge="has_role")["nodes"]
        self.assertEqual([(n["id"], n["via"]["role"], n["via"]["role_source"], n["via"]["direction"]) for n in on_p1],
                         [(ADA, "contact_pi", "reporter", "in"), (BOB, "co_pi", "curator", "in")])
        self.assertIn("No node matches", self.err(self.kg.resolve, "https://brain-bbqs.org/id/role/r1"))

    def test_a_roster_record_missing_an_end_is_reported_not_dropped_silently(self):
        self.assertEqual(dict(self.kg.unfolded), {"ProjectRole": 1})
        self.assertTrue(any("1 ProjectRole" in note for note in self.kg.describe()["notes"]))
        self.assertEqual(self.kg.neighbors(P3, edge="has_role")["total"], 0)

    def test_an_identifier_two_nodes_carry_becomes_a_node_and_one_alone_stays_a_property(self):
        outside = sorted(n.iri for n in self.kg.nodes.values() if n.type == m.EXTERNAL)
        self.assertEqual(outside, [O1, O4])
        self.assertEqual(self.kg.node(BOB)["properties"]["orcid"], "https://orcid.org/0000-0002-0000-0002")
        self.assertEqual(self.kg.node(ADA)["properties"]["orcid"], O1)    # still a fact of the node
        shared = self.kg.node("ext:" + O4)
        self.assertEqual([(e["edge"], e["direction"], ids(e["nodes"])) for e in shared["edges"]],
                         [("author_orcids", "in", [PUB2, PUB3])])

    def test_a_link_to_a_node_missing_from_the_export_is_called_that(self):
        people_only = "\n".join(FIXTURE.split("\n\n")[:2])      # six people; their working groups are not described
        kg = m.KG(m._BudgetedGraph().parse(data=people_only, format="turtle"))
        missing = sorted(n.id for n in kg.nodes.values() if n.type == m.UNRESOLVED)
        self.assertEqual(missing, [WGD, WGA])                    # each named by two people, so the tie is kept
        self.assertEqual(ids(kg.neighbors(WGD)["nodes"]), [ADA, BOB])
        self.assertTrue(any("missing from this export" in note for note in kg.describe()["notes"]))
        self.assertNotIn(m.UNRESOLVED, [n.type for n in self.kg.nodes.values()])   # the whole fixture has none

    def test_ids_are_short_and_longer_only_where_two_start_alike(self):
        shown = {n.id for n in self.kg.nodes.values() if n.type != m.EXTERNAL}
        self.assertEqual(len(shown), 21)
        self.assertLessEqual({ADA, P1, WGD}, shown)
        self.assertLessEqual({TWIN1, TWIN2}, shown)
        self.assertNotIn("a1b2c3d4", shown)

    def test_project_labels_read_the_same_whether_name_holds_the_number_or_the_title(self):
        self.assertEqual(self.kg.resolve(P1).label, "R34DA000001 · Mouse social behavior tracking")
        self.assertEqual(self.kg.resolve(P2).label, "R61MH000002 · Zebrafish imaging at scale")

    # -- references --

    def test_a_node_can_be_named_many_ways(self):
        ada = self.kg.resolve(ADA).iri
        for reference in (ADA, "bid:" + ADA, ada, f"<{ada}>", ada.rsplit("/", 1)[-1], "Ada Lovelace", "ada lovelace",
                          "0000-0001-0000-0001", O1):
            self.assertEqual(self.kg.resolve(reference).iri, ada, reference)
        for reference, expected in [("R34DA000001", P1), ("Mus musculus", MOUSE), ("House Mouse", MOUSE),
                                    ("Cyd Charisse", CYD), ("Bob Muller", BOB), ("10.1000/test.1", PUB1),
                                    ("https://doi.org/10.1000/test.1", PUB1), ("microscope", CAT), ("WG-Devices", WGD)]:
            self.assertEqual(self.kg.resolve(reference).id, expected, reference)
        self.assertEqual(self.kg.resolve("ext:" + O1).type, m.EXTERNAL)
        self.assertEqual(self.kg.resolve(O4).type, m.EXTERNAL)     # nobody owns it, so the IRI names the link node

    def test_an_unclear_reference_says_what_to_do_next(self):
        message = self.err(self.kg.resolve, "Sam Twin")
        self.assertIn("names 2 nodes", message)
        self.assertIn(TWIN1, message)
        self.assertIn(TWIN2, message)
        message = self.err(self.kg.resolve, "a1b2c3d4")
        self.assertIn("more than one id", message)
        self.assertIn("search_nodes", self.err(self.kg.resolve, "nobody at all"))
        self.assertIn("No node given", self.err(self.kg.resolve, "  "))

    # -- search --

    def test_search_ranks_names_first_and_shows_where_other_text_matched(self):
        self.assertEqual(self.kg.search("mouse")["results"][0]["id"], MOUSE)          # exact name
        self.assertEqual(ids(self.kg.search("ada")["results"]), [ADA])
        self.assertEqual(ids(self.kg.search("love")["results"]), [ADA])               # start of a word
        self.assertEqual(ids(self.kg.search("muller")["results"]), [BOB])             # accents
        self.assertEqual(ids(self.kg.search("mus musculus")["results"])[0], MOUSE)    # alias
        hit = self.kg.search("vocalizations")["results"][0]
        self.assertEqual(hit["id"], P1)
        self.assertEqual(hit["match"]["property"], "abstract")
        self.assertIn("ultrasonic", hit["match"]["text"])
        by_number = self.kg.search("R34DA000001")["results"]
        self.assertEqual(ids(by_number), [P1, DS1])
        self.assertNotIn("match", by_number[0])                    # the label already shows it
        self.assertEqual(by_number[1]["match"]["property"], "award_numbers")
        self.assertEqual(self.kg.search("0000-0001-0000-0001")["results"][0]["id"], ADA)
        self.assertEqual(self.kg.search("xyzzy")["total"], 0)

    def test_search_lists_by_type_and_exact_property_values(self):
        projects = self.kg.search(type="project")                 # type names are case-insensitive
        self.assertEqual(ids(projects["results"]), [P1, P2, P3])
        self.assertEqual(ids(self.kg.search(where={"mechanism": "r61"})["results"]), [P2])
        self.assertEqual(ids(self.kg.search(type="Publication", where={"year": 2024})["results"]), [PUB2, PUB3])
        self.assertEqual(ids(self.kg.search(type="Project", where={"studies_human": False})["results"]), [P1])
        self.assertEqual(ids(self.kg.search("mouse", type=["Project", "Dataset"])["results"]), [P1, DS1, P3])
        self.assertEqual(ids(self.kg.search("mouse", type="Project, Dataset")["results"]), [P1, DS1, P3])
        page = self.kg.search(type="Investigator", limit=2, offset=2)
        self.assertEqual((page["total"], len(page["results"])), (6, 2))

    def test_search_rejects_what_it_cannot_answer_and_lists_what_it_can(self):
        self.assertIn("Give a query", self.err(self.kg.search))
        self.assertIn("Investigator", self.err(self.kg.search, type="Person"))
        self.assertIn("mechanism", self.err(self.kg.search, type="Project", where={"nope": 1}))
        self.assertIn("whole numbers", self.err(self.kg.search, "x", limit="lots"))

    def test_page_sizes_are_clamped_and_the_reply_still_says_how_many_there_are(self):
        everyone = self.kg.search(type="Investigator", limit=10_000)
        self.assertEqual((everyone["total"], len(everyone["results"])), (6, 6))
        one = self.kg.search(type="Investigator", limit=0)
        self.assertEqual((one["total"], len(one["results"])), (6, 1))
        self.assertEqual(self.kg.neighbors(MOUSE, depth=2, limit=10_000)["total"], 7)
        self.assertEqual(self.kg.search(type="Publication", where={"year": 2024.0})["total"], 2)   # 2024.0 is 2024

    # -- one node --

    def test_get_node_gives_every_fact_and_every_link(self):
        p1 = self.kg.node("R34DA000001")
        self.assertEqual(p1["properties"]["award_amount"], 100)
        self.assertIs(p1["properties"]["studies_human"], False)
        self.assertEqual(p1["properties"]["keywords"], ["computer vision", "social behavior"])
        self.assertEqual(p1["links"], 6)
        self.assertEqual([(e["edge"], e["direction"], e["count"]) for e in p1["edges"]],
                         [("funded_datasets", "out", 1), ("has_role", "in", 2), ("part_of_org", "out", 1),
                          ("produced", "out", 1), ("studies_species", "out", 1)])
        roles = next(e for e in p1["edges"] if e["edge"] == "has_role")["nodes"]
        self.assertEqual([(n["id"], n["role"]) for n in roles], [(ADA, "contact_pi"), (BOB, "co_pi")])
        self.assertEqual(self.kg.node(DEE)["edges"], [])

    def test_get_node_counts_what_it_does_not_list(self):
        members = self.kg.node("WG-Devices", edge_limit=1)["edges"][0]
        self.assertEqual((members["count"], len(members["nodes"]), members["more"]), (2, 1, 1))

    # -- walking --

    def test_neighbors_one_hop_both_ways_and_each_way(self):
        self.assertEqual(ids(self.kg.neighbors(MOUSE)["nodes"]), [P1, P3])
        out = self.kg.neighbors(P1, direction="out")
        self.assertEqual(sorted(ids(out["nodes"])), sorted([DS1, ORG, PUB1, MOUSE]))
        self.assertEqual(ids(self.kg.neighbors(P1, direction="in")["nodes"]), [ADA, BOB])
        self.assertEqual(self.kg.neighbors(DEE)["total"], 0)

    def test_neighbors_type_filters_what_is_returned_not_what_is_walked(self):
        people = self.kg.neighbors("House Mouse", depth=2, type="Investigator")
        self.assertEqual(ids(people["nodes"]), [ADA, BOB])
        self.assertEqual({n["hops"] for n in people["nodes"]}, {2})
        self.assertEqual(people["nodes"][0]["via"], {"edge": "has_role", "direction": "in", "role": "contact_pi",
                                                     "role_source": "reporter", "from": P1})
        self.assertEqual(people["reached_by_type"], {"Project": 2, "Investigator": 2, "Dataset": 1, "Publication": 1,
                                                     "ResearchOrganization": 1})
        self.assertEqual(people["total"], 2)

    def test_neighbors_follow_only_the_edges_asked_for_and_page(self):
        via_roster = self.kg.neighbors(ADA, edge="has_role", depth=3)
        self.assertEqual(ids(via_roster["nodes"]), [P1, BOB, P2])       # ada -> p1 -> bob -> p2; cyd is 4 away
        self.assertEqual([n["hops"] for n in via_roster["nodes"]], [1, 2, 3])
        everything = self.kg.neighbors(MOUSE, depth=2)
        self.assertEqual(everything["total"], 7)
        second_page = self.kg.neighbors(MOUSE, depth=2, limit=3, offset=3)
        self.assertEqual(ids(second_page["nodes"]), ids(everything["nodes"])[3:6])

    def test_neighbors_reach_a_hub_but_do_not_walk_through_it(self):
        with mock.patch.object(m, "HUB_LINKS", 3):         # in this graph only P1 (6 links) and P2 (4) are hubs
            walked = self.kg.neighbors(CYD, depth=2)        # cyd -> WG-Analytics -> bob; cyd -> p2, and no further
            self.assertEqual(sorted(ids(walked["nodes"])), sorted([WGA, P2, BOB]))
            self.assertEqual(ids(walked["hubs_not_walked_through"]), [P2])
            through = self.kg.neighbors(CYD, depth=2, through_hubs=True)
            self.assertEqual(sorted(ids(through["nodes"])), sorted([WGA, P2, BOB, PUB2, ZEBRA]))
            self.assertNotIn("hubs_not_walked_through", through)
            named = self.kg.neighbors(CYD, depth=2, edge="has_role")       # naming the edge asks for it
            self.assertEqual(ids(named["nodes"]), [P2, BOB])
            self.assertEqual(sorted(ids(self.kg.neighbors(P2)["nodes"])), sorted([BOB, CYD, PUB2, ZEBRA]))   # a hub's own
        self.assertNotIn("hubs_not_walked_through", self.kg.neighbors(CYD, depth=2))    # none at the real threshold

    def test_neighbors_reject_bad_arguments(self):
        self.assertIn("has_role", self.err(self.kg.neighbors, ADA, edge="knows"))
        self.assertIn("direction", self.err(self.kg.neighbors, ADA, direction="up"))
        self.assertIn("depth", self.err(self.kg.neighbors, ADA, depth=m.MAX_DEPTH + 1))

    # -- what is related: spreading activation --

    def strengths(self, start, **options) -> dict:
        """What the wave from `start` brings to every node it reaches: id -> (hops, strength, routes)."""
        wave = self.kg._wave(self.kg.resolve(start), **options)
        return {self.kg.nodes[iri].id: (found.hops, str(found.strength), found.routes)
                for iri, found in wave.items() if found.hops}

    def rows(self, *args, **options) -> dict:
        """find_related, boiled down: type -> [(id, hops, strength)], in the order returned."""
        return {group["type"]: [(n["id"], n["hops"], n["strength"]) for n in group["nodes"]]
                for group in self.kg.related(*args, **options)["related"]}

    def test_strength_is_what_the_hand_calculation_gives(self):
        # From Ada, who has 4 neighbours. One unit leaves her for each; every node passes on what
        # it received divided by its number of neighbours; what arrives together adds up; a node
        # is read when it is first reached.
        #   1 link away   WG-Devices, P1, the university and her ORCID iD: 1 each.
        #   2             Bob: 1/2 from WG-Devices (2 neighbours) + 1/6 from P1 (6) = 2/3.
        #                 The paper: 1/6 from P1 + 1/2 from the iD (2 neighbours) = 2/3.
        #                 Sam Twin: 1/3 from the university (3). Mouse and the dataset: 1/6 from P1.
        #   3             Bob (4 neighbours) passes 2/3 / 4 = 1/6 to WG-Analytics and to P2; Mouse (2) passes 1/12 to P3.
        #   4             Cyd: 1/6 / 2 from WG-Analytics + 1/6 / 4 from P2 (4 neighbours) = 1/8.
        #                 Zebrafish and "Fish at scale": 1/24 from P2.
        #   5, 6          the iD two papers share: 1/48; then the unattached preprint: 1/96.
        self.assertEqual(self.strengths(ADA), {
            WGD: (1, "1", 1), P1: (1, "1", 1), ORG: (1, "1", 1), "ext:" + O1: (1, "1", 1),
            BOB: (2, "2/3", 2), PUB1: (2, "2/3", 2), TWIN1: (2, "1/3", 1), MOUSE: (2, "1/6", 1), DS1: (2, "1/6", 1),
            WGA: (3, "1/6", 2), P2: (3, "1/6", 2), P3: (3, "1/12", 1),
            CYD: (4, "1/8", 4), ZEBRA: (4, "1/24", 2), PUB2: (4, "1/24", 2),
            "ext:" + O4: (5, "1/48", 2), PUB3: (6, "1/96", 2)})
        self.assertEqual(self.strengths(DEE), {})                     # no links: nothing to spread along

    def test_strength_is_the_same_from_either_end(self):
        linked = [node for node in self.kg.nodes.values() if node.links]
        for avoid in (set(), {"member_of_group"}):
            waves = {node.iri: self.kg._wave(node, avoid) for node in linked}
            pairs = [(a, b) for a in waves for b in waves[a] if a != b]
            self.assertGreater(len(pairs), 200)
            for a, b in pairs:
                self.assertEqual(waves[a][b], waves[b][a], (a, b, avoid))     # hops, strength, routes, strongest

    def test_the_code_is_the_process_it_is_named_after(self):
        # Spreading with nothing left out (every node, every tick, splits all it holds among all its
        # neighbours, backwards too) delivers to each node, the first time anything reaches it,
        # exactly the strength, on the tick that is its distance.
        for start in (node for node in self.kg.nodes.values() if node.links):
            for avoid in ((), ("member_of_group",), ("has_role", "orcid")):
                wave = self.kg._wave(start, set(avoid))
                self.assertEqual({iri: (found.hops, found.strength) for iri, found in wave.items() if found.hops},
                                 first_arrivals(self.kg, start, avoid), (start.id, avoid))

    def test_two_nodes_are_one_tie_however_many_links_record_it(self):
        # A is a member of G and has also asked to join it: two links, one neighbour. G is linked to
        # itself as well, which leads nowhere. So G has 6 links and 3 neighbours, and passes on 1/3.
        kg = small_kg("""bid:g a bbqs:WorkingGroup ; bbqs:name "G" ; bbqs:part_of bid:g .
                         bid:a a bbqs:Investigator ; bbqs:name "A" ; bbqs:member_of_group bid:g ; bbqs:requested_groups bid:g .
                         bid:b a bbqs:Investigator ; bbqs:name "B" ; bbqs:member_of_group bid:g .
                         bid:c a bbqs:Investigator ; bbqs:name "C" ; bbqs:member_of_group bid:g .""")
        group = kg.related("A", type="WorkingGroup")["related"][0]["nodes"][0]
        self.assertEqual((group["links"], group["hops"], group["strength"]), (6, 1, 1))     # a direct link is 1, not 2
        self.assertIs(type(group["strength"]), int)
        self.assertEqual(group["link"], {"edge": "member_of_group", "direction": "out",
                                         "also": [{"edge": "requested_groups", "direction": "out"}]})
        self.assertNotIn("routes", group)
        avoiding = kg.related("A", type="WorkingGroup", avoid_edges="member_of_group")["related"][0]["nodes"][0]
        self.assertEqual(avoiding["link"], {"edge": "requested_groups", "direction": "out"})   # not the one avoided
        people = kg.related("A", type="Investigator")["related"][0]
        self.assertEqual([(n["label"], n["strength"], n["through"]) for n in people["nodes"]],
                         [(name, 0.3333, [{"id": kg.resolve("G").id, "label": "G", "splits": 3}]) for name in "BC"])
        self.assertEqual(kg.related("G", type="Investigator", limit=2)["related"][0]["tied"],
                         {"hops": 1, "strength": 1, "count": 3, "listed": 2})                # A is one of three equals
        found = kg.paths("A", "B")
        self.assertEqual((found["routes"], found["strength"], len(found["paths"])), (1, 0.3333, 1))
        self.assertEqual(found["paths"][0]["text"], 'Investigator "A" -[member_of_group + requested_groups]-> '
                                                    'WorkingGroup "G" <-[member_of_group]- Investigator "B"')
        for start in kg.nodes.values():
            self.assertEqual({iri: (f.hops, f.strength) for iri, f in kg._wave(start).items() if f.hops},
                             first_arrivals(kg, start), start.id)
        # leaving one of the two links out changes nothing; leaving both out cuts A off
        self.assertEqual(kg.paths("A", "B", avoid_edges="requested_groups")["strength"], 0.3333)
        self.assertIn("Not connected", kg.paths("A", "B", avoid_edges=["requested_groups", "member_of_group"])["note"])

    def test_related_ranks_each_type_on_its_own_nearest_first_then_strongest(self):
        found = self.kg.related(ADA, max_hops=m.MAX_HOPS)
        self.assertEqual(found["start"], [{"id": ADA, "type": "Investigator", "label": "Ada Lovelace", "links": 4}])
        listed = self.rows(ADA, max_hops=m.MAX_HOPS)
        # types in the order of their best node: four hold a direct link, then 2/3, then 1/6 at two links
        self.assertEqual(list(listed), ["External", "Project", "ResearchOrganization", "WorkingGroup",
                                        "Investigator", "Publication", "Dataset", "Species"])
        self.assertEqual(listed["Investigator"], [(BOB, 2, 0.6667), (TWIN1, 2, 0.3333), (CYD, 4, 0.125)])
        self.assertEqual(listed["Project"], [(P1, 1, 1), (P2, 3, 0.1667), (P3, 3, 0.08333)])
        self.assertEqual(listed["Publication"], [(PUB1, 2, 0.6667), (PUB2, 4, 0.04167), (PUB3, 6, 0.01042)])
        self.assertEqual(listed["WorkingGroup"], [(WGD, 1, 1), (WGA, 3, 0.1667)])
        self.assertEqual(listed["Species"], [(MOUSE, 2, 0.1667), (ZEBRA, 4, 0.04167)])
        self.assertEqual({group["type"]: group["within"] for group in found["related"]},
                         {"External": 2, "Project": 3, "ResearchOrganization": 1, "WorkingGroup": 2,
                          "Investigator": 3, "Publication": 3, "Dataset": 1, "Species": 2})
        self.assertFalse(any("beyond" in group for group in found["related"]))
        # never the starting node itself, a node with no links, or one in another piece of the graph
        self.assertFalse({n for rows in listed.values() for n, _, _ in rows} & {ADA, DEE, TWIN2, DEV, CAT, MAN})
        self.assertEqual(list(self.rows(ADA, type=["species", "Dataset"])), ["Dataset", "Species"])
        # a type that is asked for and not reached is listed last, empty, rather than left out
        self.assertEqual([(g["type"], g["within"]) for g in self.kg.related(ADA, type=["Device", "Species"])["related"]],
                         [("Species", 2), ("Device", 0)])

    def test_related_looks_only_so_far_and_counts_what_lies_beyond(self):
        near = self.kg.related(ADA, max_hops=2)
        self.assertEqual({g["type"]: (g["within"], g.get("beyond", 0)) for g in near["related"]},
                         {"External": (1, 1), "Project": (1, 2), "ResearchOrganization": (1, 0), "WorkingGroup": (1, 1),
                          "Investigator": (2, 1), "Publication": (1, 2), "Dataset": (1, 0), "Species": (1, 1)})
        self.assertEqual(self.rows(ADA, max_hops=2)["Investigator"], [(BOB, 2, 0.6667), (TWIN1, 2, 0.3333)])
        by_default = {g["type"]: (g["within"], g.get("beyond", 0)) for g in self.kg.related(ADA)["related"]}
        self.assertEqual((by_default["Publication"], by_default["External"]), ((2, 1), (1, 1)))   # four links, unless asked
        # a type with nothing near enough is still named, with how many lie beyond
        far = self.kg.related(MOUSE, max_hops=1)["related"]
        self.assertEqual([(g["type"], g["within"]) for g in far][0], ("Project", 2))
        self.assertIn({"type": "Investigator", "within": 0, "nodes": [], "beyond": 4}, far)
        self.assertIn("max_hops", self.err(self.kg.related, ADA, max_hops=0))
        self.assertIn("max_hops", self.err(self.kg.related, ADA, max_hops=m.MAX_HOPS + 1))

    def test_related_puts_a_nearer_node_before_a_stronger_one_farther_away(self):
        # s is in a group of ten, so each fellow member is tied by 1/10, two links away. Through
        # her one project there is a chain of nodes with two neighbours each to x (two links,
        # 1/2), then q (1/4), which has three neighbours and leads to f and f2, four links away:
        # 1/12 each. Stronger than 1/10 would be farther all the same: the nearer ones come first.
        members = "".join(f'bid:n{i} a bbqs:Investigator ; bbqs:name "N{i}" ; bbqs:member_of_group bid:g .\n'
                          for i in range(9))
        kg = small_kg(members + """
            bid:g a bbqs:WorkingGroup ; bbqs:name "G" .
            bid:s a bbqs:Investigator ; bbqs:name "S" ; bbqs:member_of_group bid:g ; bbqs:leads bid:p .
            bid:p a bbqs:Project ; bbqs:name "P" . bid:q a bbqs:Project ; bbqs:name "Q" .
            bid:x a bbqs:Investigator ; bbqs:name "X" ; bbqs:leads bid:p, bid:q .
            bid:f a bbqs:Investigator ; bbqs:name "F" ; bbqs:leads bid:q .
            bid:e a bbqs:Investigator ; bbqs:name "E" ; bbqs:leads bid:q .""")

        def people(**options):
            return kg.related("S", type="Investigator", **options)["related"][0]

        self.assertEqual([(n["label"], n["hops"], n["strength"]) for n in people(limit=25)["nodes"]],
                         [("X", 2, 0.5)] + [(f"N{i}", 2, 0.1) for i in range(9)] + [("E", 4, 0.08333), ("F", 4, 0.08333)])
        # a list cut among equals says so; one cut between two levels does not
        self.assertNotIn("tied", people(limit=1))                                # X, then the nine: a real step down
        self.assertEqual(people(limit=3)["tied"], {"hops": 2, "strength": 0.1, "count": 9, "listed": 2})
        self.assertEqual(people(limit=3, offset=3)["tied"], {"hops": 2, "strength": 0.1, "count": 9, "listed": 3})
        self.assertNotIn("tied", people(limit=10))                               # ends where the nine end
        self.assertEqual(people(limit=11)["tied"], {"hops": 4, "strength": 0.08333, "count": 2, "listed": 1})
        self.assertNotIn("tied", people(limit=3, offset=9))   # the last of the nine, then E and F: all listed
        self.assertEqual([n["label"] for n in people(limit=3, offset=-5)["nodes"]], ["X", "N0", "N1"])

    def test_equals_are_listed_by_name_and_that_is_all_their_order_means(self):
        kg = small_kg("""bid:p a bbqs:Project ; bbqs:name "P" .
                         bid:a a bbqs:Investigator ; bbqs:name "Zoe" ; bbqs:leads bid:p .
                         bid:b a bbqs:Investigator ; bbqs:name "Abe" ; bbqs:leads bid:p .""")
        self.assertEqual([n["label"] for n in kg.related("P")["related"][0]["nodes"]], ["Abe", "Zoe"])   # not by id
        self.assertLess(WGD, WGA)                                   # in the fixture too, the ids sort the other way
        self.assertEqual(ids(self.kg.related(BOB, type="WorkingGroup")["related"][0]["nodes"]), [WGA, WGD])

    def test_related_shows_the_strongest_route_and_how_much_of_the_strength_it_brings(self):
        bob, twin, cyd = self.kg.related(ADA, type="Investigator")["related"][0]["nodes"]
        self.assertEqual(bob["through"], [{"id": WGD, "label": "WG-Devices", "splits": 2}])
        self.assertEqual((bob["routes"], bob["share"]), (2, 0.75))          # 1/2 of his 2/3 came through WG-Devices
        self.assertEqual(ids(twin["through"]), [ORG])
        self.assertFalse({"routes", "share"} & set(twin))                   # one route: nothing to share out
        self.assertEqual([(step["id"], step["splits"]) for step in cyd["through"]], [(WGD, 2), (BOB, 4), (WGA, 2)])
        self.assertEqual((cyd["routes"], cyd["share"]), (4, 0.5))           # 1/2 * 1/4 * 1/2 = 1/16 of her 1/8
        project = self.kg.related(ADA, type="Project")["related"][0]["nodes"][0]
        self.assertEqual(project["link"], {"edge": "has_role", "direction": "out", "role": "contact_pi",
                                           "role_source": "reporter"})    # a direct link is its own reason
        self.assertNotIn("through", project)
        self.assertIs(type(project["strength"]), int)                       # exactly 1, and sent as 1
        seen_from_p1 = self.kg.related(P1, type="Investigator")["related"][0]["nodes"][0]
        self.assertEqual((seen_from_p1["id"], seen_from_p1["link"]["direction"]), (ADA, "in"))

    def test_related_to_several_nodes_is_what_every_one_of_them_reaches(self):
        # Ada and Cyd. The wave from Cyd (2 neighbours): WG-Analytics and P2 are direct; Bob gets
        # 1/2 + 1/4 = 3/4; he passes 3/16 to WG-Devices and to P1; and so on. A node is placed by
        # its worst tie: the farthest starting node, then the weakest.
        found = self.kg.related([ADA, CYD], max_hops=m.MAX_HOPS)
        self.assertEqual(ids(found["start"]), [ADA, CYD])
        listed = self.rows([ADA, CYD], max_hops=m.MAX_HOPS)
        self.assertEqual(list(listed), ["Investigator", "Project", "WorkingGroup", "Publication", "Species",
                                        "ResearchOrganization", "Dataset", "External"])
        # Bob is two links from both. Sam Twin is two from Ada (1/3) but five from Cyd (1/96).
        self.assertEqual(listed["Investigator"], [(BOB, 2, 0.6667), (TWIN1, 5, 0.01042)])
        # P1 is Ada's own and three links from Cyd (3/16); P2 the other way round (1/6); P3 is far from both (1/64).
        self.assertEqual(listed["Project"], [(P1, 3, 0.1875), (P2, 3, 0.1667), (P3, 5, 0.01563)])
        self.assertEqual(listed["WorkingGroup"], [(WGD, 3, 0.1875), (WGA, 3, 0.1667)])
        self.assertEqual(listed["Species"], [(ZEBRA, 4, 0.04167), (MOUSE, 4, 0.03125)])
        bob = found["related"][0]["nodes"][0]
        self.assertEqual(bob["per_start"], [{"start": ADA, "hops": 2, "strength": 0.6667, "routes": 2},
                                       {"start": CYD, "hops": 2, "strength": 0.75, "routes": 2}])
        self.assertFalse({"link", "through", "routes", "share"} & set(bob))   # find_paths has the routes, pair by pair
        swapped = self.kg.related([CYD, ADA], max_hops=m.MAX_HOPS)             # the order asked in changes only `ties`
        self.assertEqual([(g["type"], ids(g["nodes"])) for g in swapped["related"]],
                         [(g["type"], ids(g["nodes"])) for g in found["related"]])
        self.assertEqual(self.rows([ADA, CYD, MOUSE], type="Investigator", max_hops=m.MAX_HOPS)["Investigator"],
                         [(BOB, 2, 0.1667), (TWIN1, 5, 0.01042)])
        self.assertEqual(self.rows([ADA, CYD])["Investigator"], [(BOB, 2, 0.6667)])   # Sam Twin is past four links

    def test_with_several_starting_nodes_the_worst_tie_decides_then_the_next_worst(self):
        # P2 and P3. From P3 (one link, to Mouse): P1 gets 1/2 and passes 1/12 to each of its other
        # five neighbours, Ada and Bob among them, three links away. From P2: Bob is direct; Ada is
        # three links away, 1/8 through WG-Devices + 1/24 through P1 = 1/6.
        #   Bob's ties, worst first: (3 links, 1/12), (1 link, 1)
        #   Ada's:                   (3 links, 1/12), (3 links, 1/6)
        # The worst ties are the same, so the next decides, and Bob is nearer. (Taking the farthest
        # distance and the weakest strength, each over all the ties, cannot tell the two apart.)
        found = self.kg.related([P2, P3], type="Investigator", max_hops=m.MAX_HOPS)["related"][0]
        self.assertEqual([(n["id"], n["hops"], n["strength"]) for n in found["nodes"]],
                         [(BOB, 3, 0.08333), (ADA, 3, 0.08333), (TWIN1, 4, 0.01389), (CYD, 5, 0.01563)])
        self.assertEqual(found["nodes"][0]["per_start"], [{"start": P2, "hops": 1, "strength": 1},
                                                     {"start": P3, "hops": 3, "strength": 0.08333}])
        self.assertEqual(found["nodes"][3]["per_start"][0], {"start": P2, "hops": 1, "strength": 1})   # headed by the worse one
        # ...and they are not equals: a list cut between them is not a tie
        self.assertNotIn("tied", self.kg.related([P2, P3], type="Investigator", limit=1)["related"][0])

    def test_related_says_when_a_list_was_cut_among_equals(self):
        # Mouse is studied by P1 and P3, both direct; P2 is three links away.
        first = self.kg.related(MOUSE, type="Project", limit=1)["related"][0]
        self.assertEqual((first["within"], ids(first["nodes"])), (3, [P1]))
        self.assertEqual(first["tied"], {"hops": 1, "strength": 1, "count": 2, "listed": 1})
        self.assertNotIn("tied", self.kg.related(MOUSE, type="Project", limit=2)["related"][0])   # cut between levels
        second = self.kg.related(MOUSE, type="Project", limit=1, offset=1)["related"][0]
        self.assertEqual(ids(second["nodes"]), [P3])
        self.assertNotIn("tied", second)                                    # the tie ends on this page
        self.assertEqual(ids(self.kg.related(MOUSE, type="Project", limit=10_000)["related"][0]["nodes"]), [P1, P3, P2])

    def test_related_can_leave_links_out_and_then_a_node_splits_among_the_rest(self):
        # Without the working groups Bob is tied to Ada through P1 alone (1/6), and has 2 neighbours
        # left to split among instead of 4, so P2 gets 1/6 / 2 = 1/12.
        without = self.strengths(ADA, avoid={"member_of_group"})
        self.assertEqual((without[BOB], without[P2], without[CYD]), ((2, "1/6", 1), (3, "1/12", 1), (4, "1/48", 1)))
        self.assertFalse({WGD, WGA} & set(without))
        reply = self.kg.related(ADA, type="Project", avoid_edges="member_of_group")
        self.assertEqual(reply["avoided"], ["member_of_group"])
        p2 = reply["related"][0]["nodes"][1]
        self.assertEqual((p2["id"], p2["strength"]), (P2, 0.08333))
        self.assertEqual([(step["id"], step["splits"]) for step in p2["through"]], [(P1, 6), (BOB, 2)])
        self.assertNotIn("avoided", self.kg.related(ADA, type="Project"))
        self.assertEqual(self.kg.related(ADA, avoid_edges=["orcid", "member_of_group"])["avoided"],
                         ["member_of_group", "orcid"])

    def test_related_takes_its_starting_nodes_however_they_arrive(self):
        one, pair = self.kg.related(ADA), self.kg.related([ADA, CYD])
        for shape in ([ADA], "Ada Lovelace", f'["{ADA}"]', [ADA, "ada lovelace"], (ADA,), '"Ada Lovelace"',
                      "Ada Lovelace,"):                                     # the same node twice is one node
            self.assertEqual(self.kg.related(shape), one, shape)
        for shape in (f"{ADA}, {CYD}", f'["{ADA}", "{CYD}"]', ["Ada Lovelace", CYD], f"{ADA},,{CYD}",
                      f"['{ADA}', '{CYD}']", f"[{ADA}, {CYD}]", f'"{ADA}", "{CYD}"'):
            self.assertEqual(self.kg.related(shape), pair, shape)
        # a name with a comma in it is one node, not two
        kg = small_kg("""bid:u a bbqs:ResearchOrganization ; bbqs:name "University of Testing, West" ;
                             bbqs:members bid:a . bid:a a bbqs:Investigator ; bbqs:name "A" .""")
        self.assertEqual(kg.related("University of Testing, West")["start"][0]["type"], "ResearchOrganization")

    def test_related_says_what_it_cannot_answer(self):
        self.assertIn("No node matches 'nobody at all'", self.err(self.kg.related, "nobody at all"))
        self.assertIn("No node matches 'nobody, at all'", self.err(self.kg.related, "nobody, at all"))   # no part is a node
        self.assertIn("No node matches '[abc'", self.err(self.kg.related, "[abc"))
        # one part of a list is wrong: the answer is about that part
        self.assertEqual(self.err(self.kg.related, "Ada Lovelace, nobody"),
                         "Read as 2 nodes. No node matches 'nobody'. Find it with search_nodes; it takes partial names.")
        unclear = self.err(self.kg.related, "Sam Twin, Ada Lovelace")
        self.assertTrue(unclear.startswith("Read as 2 nodes. 'Sam Twin' names 2 nodes"), unclear)
        self.assertIn("names 2 nodes", self.err(self.kg.related, "Sam Twin"))
        self.assertIn("names 2 nodes", self.err(self.kg.related, [ADA, "Sam Twin"]))
        self.assertIn("No node given", self.err(self.kg.related, []))
        self.assertIn("Investigator", self.err(self.kg.related, ADA, type="Person"))
        self.assertIn("has_role", self.err(self.kg.related, ADA, avoid_edges="knows"))
        self.assertIn(f"at most {m.MAX_SEEDS}", self.err(self.kg.related, [ADA, BOB, CYD, P1, P2, P3]))
        self.assertEqual(len(self.kg.related([ADA, BOB, CYD, P1, P2])["start"]), m.MAX_SEEDS)
        self.assertEqual(len(self.kg.related([ADA, ADA, BOB, CYD, P1, P2])["start"]), m.MAX_SEEDS)   # one node, named twice
        # the part that fails is named, the first of them
        self.assertIn("No node matches 'nobody'.", self.err(self.kg.related, "nobody, Ada Lovelace, nobody else"))

    def test_an_ambiguous_name_says_what_it_names_however_it_is_written(self):
        for spelling in ('"Sam Twin"', "Sam Twin,", '["Sam Twin"]', "[Sam Twin]"):
            self.assertTrue(self.err(self.kg.related, spelling).startswith("'Sam Twin' names 2 nodes"), spelling)
        for spelling in ("Sam Twin, nobody", "nobody, Sam Twin"):          # beside a part that names nothing
            self.assertTrue(self.err(self.kg.related, spelling).startswith("Read as 2 nodes. 'Sam Twin' names 2 nodes"),
                            spelling)

    def test_every_tool_reads_a_name_in_quotes_or_brackets(self):
        for spelling in ('"Sam Twin"', '["Sam Twin"]', "[Sam Twin]", "'Sam Twin'"):
            for ask in (lambda ref: self.kg.node(ref), lambda ref: self.kg.neighbors(ref),
                        lambda ref: self.kg.paths(ref, ADA), lambda ref: self.kg.paths(ADA, ref)):
                self.assertIn("'Sam Twin' names 2 nodes", self.err(ask, spelling), spelling)
        for spelling in ('"Ada Lovelace"', '["Ada Lovelace"]', "[Ada Lovelace]"):
            self.assertEqual(self.kg.resolve(spelling).id, ADA, spelling)
        self.assertIn("No node matches '[abc'", self.err(self.kg.node, "[abc"))     # the name as written
        kg = small_kg("""bid:s1 a bbqs:Investigator ; bbqs:name "Smith, J" . bid:s2 a bbqs:Investigator ; bbqs:name "Smith, J" .
            bid:k1 a bbqs:Organization ; bbqs:name "Kids" . bid:k2 a bbqs:Organization ; bbqs:name "Kids'" .
            bid:b1 a bbqs:Organization ; bbqs:name "Biomark, Inc." .
            bid:208980e9-0000-0000-0000-000000000001 a bbqs:Dataset ; bbqs:name "E-notation" .""")
        for spelling in ('"Smith, J"', "[Smith, J]", "'Smith, J'", '["Smith, J"]'):      # a comma inside is part of the name
            self.assertIn("'Smith, J' names 2 nodes", self.err(kg.node, spelling), spelling)
        self.assertEqual([kg.resolve(ref).label for ref in ('"Biomark, Inc."', "[Biomark, Inc.]", '"Kids\'"', "[208980e9]")],
                         ["Biomark, Inc.", "Biomark, Inc.", "Kids'", "E-notation"])      # not "Kids"; not a number

    def test_describe_graph_takes_one_type_or_none(self):
        everything = self.kg.describe()
        for none in (None, "", " ", "[]", []):
            self.assertEqual(self.kg.describe(none)["nodes"], everything["nodes"], repr(none))
        self.assertIn("Name one node type at a time", self.err(self.kg.describe, "Species, Project"))
        self.assertIn("Name one node type at a time", self.err(self.kg.describe, ["Species", "Project"]))
        self.assertEqual(self.kg.describe("species")["type"], "Species")
        self.assertIn("names no node type", self.err(self.kg.describe, "["))

    def test_an_argument_that_names_nothing_is_a_mistake_not_no_filter(self):
        everything = self.kg.related(ADA)
        for none in (None, "", " ", "[]", []):
            self.assertEqual(self.kg.related(ADA, type=none), everything, repr(none))
        for wrong in ("[", ",", "[[", '""', "[" * 1000):
            self.assertIn("names no node type", self.err(self.kg.related, ADA, type=wrong))
            self.assertIn("names no edge", self.err(self.kg.related, ADA, avoid_edges=wrong))
            self.assertIn("names no edge", self.err(self.kg.neighbors, ADA, edge=wrong))
            self.assertIn("names no node type", self.err(self.kg.search, "", type=wrong))
        self.assertLess(len(self.err(self.kg.related, ADA, type="[" * 1000)), 400)     # and says so briefly
        self.assertIn("No node matches", self.err(self.kg.related, "[" * 1000))          # not a RecursionError
        self.assertIn("names no edge", self.err(self.kg.paths, ADA, BOB, avoid_edges="[" * 1000))

    def test_with_several_starting_nodes_equals_are_equal_on_every_tie(self):
        # S1 is linked to X, Y and K; S2 to H; H to X, Y and W; K to W. From the two together, X and Y
        # have the same worst tie (2 links from S2, at 1/4) and the same next one (S1, direct); W has
        # that worst tie too, but a weaker next one (2 links from S1, at 1/2). Cut after one, X and Y
        # are the equals: two of them, one listed. Counting by the worst tie alone would say three.
        kg = small_kg("""
            bid:s1 a bbqs:Species ; bbqs:name "S1" ; bbqs:e bid:x, bid:y, bid:k .
            bid:s2 a bbqs:Species ; bbqs:name "S2" ; bbqs:e bid:h .
            bid:h a bbqs:Project ; bbqs:name "H" ; bbqs:e bid:x, bid:y, bid:w .
            bid:k a bbqs:Project ; bbqs:name "K" ; bbqs:e bid:w .
            bid:x a bbqs:Investigator ; bbqs:name "X" . bid:y a bbqs:Investigator ; bbqs:name "Y" .
            bid:w a bbqs:Investigator ; bbqs:name "W" .""")
        group = kg.related(["S1", "S2"], type="Investigator", limit=1)["related"][0]
        self.assertEqual(group["tied"], {"hops": 2, "strength": 0.25, "count": 2, "listed": 1})
        self.assertEqual([row["label"] for row in kg.related(["S1", "S2"], type="Investigator")["related"][0]["nodes"]],
                         ["X", "Y", "W"])

    def test_the_note_on_nothing_within_reach_says_how_far_and_what_was_left_out(self):
        # A leads P and knows Q; P has R. From A and P together, Q and R are each two links from one
        # of them: nothing is within one link of both.
        kg = small_kg("""
            bid:a a bbqs:Project ; bbqs:name "A" ; bbqs:leads bid:p ; bbqs:knows bid:q .
            bid:p a bbqs:Project ; bbqs:name "P" ; bbqs:has bid:r .
            bid:q a bbqs:Investigator ; bbqs:name "Q" . bid:r a bbqs:Dataset ; bbqs:name "R" .""")
        near = kg.related(["A", "P"], max_hops=1)
        self.assertEqual(near["note"], "Nothing is within 1 link of every one of these nodes.")
        self.assertEqual({group["type"]: (group["within"], group.get("beyond")) for group in near["related"]},
                         {"Investigator": (0, 1), "Dataset": (0, 1)})
        self.assertEqual(kg.related(["A", "P"], avoid_edges=["knows", "has"])["note"],
                         "Nothing is within 4 links without has, knows of every one of these nodes.")
        self.assertNotIn("note", kg.related(["A", "P"], max_hops=2))

    def test_a_node_linked_only_to_itself_has_no_links_to_other_nodes(self):
        kg = small_kg('bid:a a bbqs:Thing ; bbqs:name "A" ; bbqs:e bid:a .')
        alone = kg.related("A")
        self.assertEqual(alone["start"][0]["links"], 2)                           # the link, from both ends
        self.assertTrue(alone["note"].startswith("No links to other nodes are recorded for a (Thing: A)"), alone["note"])

    def test_two_nodes_linked_both_ways_show_each_link_the_way_it_points(self):
        kg = small_kg("""
            bid:a a bbqs:Publication ; bbqs:name "A" ; bbqs:cites bid:b .
            bid:b a bbqs:Publication ; bbqs:name "B" ; bbqs:cites bid:a ; bbqs:corrects bid:a .""")
        self.assertEqual(kg.paths("A", "B")["paths"][0]["text"],
                         'Publication "A" -[cites]-> / <-[cites + corrects]- Publication "B"')
        self.assertEqual(kg.paths("B", "A")["paths"][0]["text"],
                         'Publication "B" -[cites + corrects]-> / <-[cites]- Publication "A"')
        self.assertEqual(kg.related("A")["related"][0]["nodes"][0]["link"],
                         {"edge": "cites", "direction": "out",
                          "also": [{"edge": "cites", "direction": "in"}, {"edge": "corrects", "direction": "in"}]})
        # two roster records for one person on one project: both roles are shown, not one
        kg = small_kg("""
            bid:p a bbqs:Investigator ; bbqs:name "P" . bid:j a bbqs:Project ; bbqs:name "J" .
            bid:r1 a bbqs:ProjectRole ; bbqs:held_by bid:p ; bbqs:on_project bid:j ; bbqs:project_role "pi" .
            bid:r2 a bbqs:ProjectRole ; bbqs:held_by bid:p ; bbqs:on_project bid:j ; bbqs:project_role "co_investigator" .""")
        self.assertEqual(kg.related("P")["related"][0]["nodes"][0]["link"],
                         {"edge": "has_role", "direction": "out", "role": "co_investigator",
                          "also": [{"edge": "has_role", "direction": "out", "role": "pi"}]})
        self.assertEqual(kg.paths("P", "J")["paths"][0]["text"],
                         'Investigator "P" -[has_role co_investigator + has_role pi]-> Project "J"')

    def test_what_the_view_leaves_out_is_counted_and_said(self):
        # Shapes the exporter does not write, but a hand-made export could: each is left out of the
        # view, and describe_graph says how many, so a walk that misses one is not a silent miss.
        kg = small_kg("""
            bid:x a bbqs:Investigator ; bbqs:name "X" . bid:y a bbqs:Investigator ; bbqs:name "Y" .
            bid:j a bbqs:Project ; bbqs:name "J" ; bbqs:studies_species [ bbqs:name "zebrafish" ] .
            bid:r1 a bbqs:ProjectRole ; bbqs:held_by bid:x, bid:y ; bbqs:on_project bid:j ; bbqs:project_role "pi" .
            bid:r2 a bbqs:ProjectRole ; bbqs:held_by bid:x ; bbqs:on_project bid:j ; bbqs:project_role "pi", "co_pi" .
            bid:r3 a bbqs:ProjectRole ; bbqs:held_by bid:y ; bbqs:on_project bid:j ; bbqs:project_role "co_pi" .
            bid:d a bbqs:Dataset, bbqs:Dandiset ; bbqs:name "D" .""")
        self.assertEqual((dict(kg.repeated), dict(kg.unfolded), kg.multityped, kg.blank, kg.unused),
                         ({"ProjectRole": 2}, {}, 1, 2, 0))
        self.assertEqual([(l.edge, l.other.rsplit("/", 1)[-1], l.attrs) for l in kg.resolve("J").links],
                         [("has_role", "y", (("role", "co_pi"),))])                 # r3 alone is folded
        self.assertEqual(kg.resolve("D").type, "Dandiset")
        notes = " ".join(kg.describe()["notes"])
        for said in ("give one of held_by, on_project, project_role, role_source more than once: 2 ProjectRole",
                     "Nodes with more than one type: 1.", "Triples with a blank node at one end: 2."):
            self.assertIn(said, notes)
        # a record whose role's source is given twice is one of them; a record typed twice is not a
        # node, so not counted as one; a link to a record, and what a record says besides its rule,
        # are counted as unused
        kg = small_kg("""
            bid:x a bbqs:Investigator ; bbqs:name "X" . bid:j a bbqs:Project ; bbqs:name "J" ; bbqs:roster bid:r2 .
            bid:r1 a bbqs:ProjectRole ; bbqs:held_by bid:x ; bbqs:on_project bid:j ; bbqs:project_role "pi" ;
                bbqs:role_source "reporter", "curator" .
            bid:r2 a bbqs:ProjectRole, bbqs:ZRecord ; bbqs:held_by bid:x ; bbqs:on_project bid:j ; bbqs:project_role "co_pi" ;
                bbqs:start_date "2025-01-01" ; bbqs:approved_by bid:x .""")
        self.assertEqual((dict(kg.repeated), kg.multityped, kg.unused), ({"ProjectRole": 1}, 0, 4))   # r2's ZRecord too
        self.assertEqual([link.attrs for link in kg.resolve("J").links if link.edge == "has_role"], [(("role", "co_pi"),)])
        self.assertIn("Triples about roster records that this view does not use", " ".join(kg.describe()["notes"]))
        self.assertEqual((dict(self.kg.repeated), self.kg.multityped, self.kg.blank), ({}, 0, 0))   # none in the fixture

    def test_every_id_shown_leads_back_whatever_it_looks_like(self):
        kg = small_kg("""
            bid:project-r34da059723 a bbqs:Project ; bbqs:name "P" ; bbqs:e bid:investigator-ann .
            bid:investigator-ann a bbqs:Investigator ; bbqs:name "Ann" .
            bid:ABCDEF12-0000-0000-0000-000000000001 a bbqs:Dataset ; bbqs:name "Upper" .
            bid:abcdef99-0000-0000-0000-000000000002 a bbqs:Dataset ; bbqs:name "Lower" .""")
        self.assertEqual(sorted(node.id for node in kg.nodes.values()), ["ABCDEF12", "abcdef99", "investig", "project-"])
        for node in kg.nodes.values():
            self.assertIs(kg.resolve(node.id), node)
            self.assertIs(kg.resolve("bid:" + node.id), node)
        self.assertEqual((kg.resolve("abcdef12").label, kg.resolve("ABCDEF9").label), ("Upper", "Lower"))   # any case

    def test_equals_are_listed_by_name_ignoring_case_and_a_repeated_start_keeps_its_place(self):
        kg = small_kg("""bid:p a bbqs:Project ; bbqs:name "P" ; bbqs:e bid:x1, bid:x2, bid:x3 .
            bid:x1 a bbqs:Investigator ; bbqs:name "bea" . bid:x2 a bbqs:Investigator ; bbqs:name "Abe" .
            bid:x3 a bbqs:Investigator ; bbqs:name "Cy" .""")
        self.assertEqual([n["label"] for n in kg.related("P")["related"][0]["nodes"]], ["Abe", "bea", "Cy"])
        self.assertEqual(ids(self.kg.related([ADA, CYD, "Ada Lovelace"])["start"]), [ADA, CYD])

    def test_related_explains_an_empty_answer(self):
        dee = f"{DEE} (Investigator: Dee Isolated)"
        near = self.kg.related([ADA, CYD], max_hops=1)             # nothing within one link of both, much beyond
        self.assertEqual(near["note"], "Nothing is within 1 link of every one of these nodes.")
        self.assertTrue(all(group["beyond"] for group in near["related"]))
        alone = self.kg.related(DEE)
        self.assertEqual(alone["related"], [])
        self.assertEqual(alone["note"], f"No links are recorded for {dee}, so nothing is tied to it. "
                                        "A missing link means 'not recorded'.")
        self.assertEqual(self.kg.related([ADA, DEE])["note"], alone["note"])            # names the one without links
        self.assertEqual(self.kg.related([DEE, TWIN2, ADA])["note"],
                         f"No links are recorded for {dee}; {TWIN2} (Investigator: Sam Twin), so nothing is tied to "
                         "them. A missing link means 'not recorded'.")
        cut_off = self.kg.related(DEV, avoid_edges=["manufacturer", "device_category"])
        self.assertIn("No links without device_category, manufacturer are recorded for " + DEV, cut_off["note"])
        apart = self.kg.related([ADA, BOB, DEV])                                        # two pieces of the graph
        self.assertEqual(apart["related"], [])
        self.assertEqual(apart["note"], f"No chain of links joins {ADA} (Investigator: Ada Lovelace) and {DEV} "
                                        "(Device: Scope One), so nothing is tied to all of them.")
        severed = self.kg.related([ADA, ZEBRA], avoid_edges="has_role")["note"]         # joined only through the roster
        self.assertTrue(severed.startswith("No chain of links without has_role joins " + ADA), severed)
        # joined, and nothing else near enough to both
        kg = small_kg('bid:a a bbqs:Investigator ; bbqs:name "A" ; bbqs:leads bid:p . bid:p a bbqs:Project ; bbqs:name "P" .')
        self.assertEqual(kg.related(["A", "P"]), {"start": [kg.brief(kg.resolve("A")), kg.brief(kg.resolve("P"))],
                                                 "related": [], "note": "Nothing is within 4 links of every one of these nodes."})
        self.assertEqual(self.kg.related(DEV, type="Investigator")["related"],
                         [{"type": "Investigator", "within": 0, "nodes": []}])       # asked for and none: said so
        self.assertNotIn("note", self.kg.related(DEV, type="Investigator"))
        self.assertNotIn("note", self.kg.related([ADA, CYD]))

    def test_strength_is_rounded_as_by_hand(self):
        for exact, sent in ((Fraction(1, 64), 0.01563), (Fraction(5, 64), 0.07813), (Fraction(2, 3), 0.6667),
                            (Fraction(1, 96), 0.01042), (Fraction(89, 5), 17.8), (Fraction(1, 3), 0.3333),
                            (Fraction(17, 160), 0.1063)):              # 0.10625 exactly; as a float, just under
            self.assertEqual(m._shown(exact), sent, exact)              # half goes up, as a person rounds
        self.assertEqual((m._shown(Fraction(3)), type(m._shown(Fraction(3)))), (3, int))
        self.assertIs(type(m._shown(Fraction(24999, 25000))), float)   # not exactly 1: not sent as the whole number 1

    # -- paths --

    def test_paths_shortest_first_and_less_connected_first_among_equals(self):
        found = self.kg.paths(ADA, CYD)
        self.assertEqual((found["listed"], found["shortest"]), (4, 4))
        self.assertEqual([p["nodes"] for p in found["paths"]],
                         [[ADA, WGD, BOB, WGA, CYD], [ADA, WGD, BOB, P2, CYD],
                          [ADA, P1, BOB, WGA, CYD], [ADA, P1, BOB, P2, CYD]])
        self.assertEqual(found["paths"][3]["text"],
                         'Investigator "Ada Lovelace" -[has_role contact_pi]-> Project "R34DA000001 · Mouse social '
                         'behavior tracking" <-[has_role co_pi]- Investigator "Bob Müller" -[has_role contact_pi]-> '
                         'Project "R61MH000002 · Zebrafish imaging at scale" <-[has_role postdoc]- '
                         'Investigator "Cyd  Charisse"')
        self.assertNotIn("more", found)

    def test_paths_carry_their_strength_and_the_shortest_add_up_to_the_tie(self):
        found = self.kg.paths(ADA, CYD)
        # what is left after WG-Devices (2 neighbours), Bob (4) and WG-Analytics (2) have each split it: 1/16; and so on
        self.assertEqual([p["strength"] for p in found["paths"]], [0.0625, 0.03125, 0.02083, 0.01042])
        self.assertEqual((found["shortest"], found["routes"], found["strength"]), (4, 4, 0.125))   # 1/16 + 1/32 + 1/48 + 1/96
        cyd = self.kg.related(ADA, type="Investigator")["related"][0]["nodes"][2]
        self.assertEqual((cyd["id"], cyd["hops"], cyd["routes"], cyd["strength"]), (CYD, 4, 4, 0.125))   # one figure, two tools
        self.assertFalse({"more", "partial"} & set(found))
        direct = self.kg.paths(ADA, P1)
        self.assertEqual(([p["strength"] for p in direct["paths"]], direct["routes"], direct["strength"]), ([1], 1, 1))
        self.assertIs(type(direct["strength"]), int)

    def test_paths_can_leave_edges_out(self):
        found = self.kg.paths(ADA, CYD, avoid_edges="member_of_group")
        self.assertEqual([p["nodes"] for p in found["paths"]], [[ADA, P1, BOB, P2, CYD]])
        # Bob has 2 neighbours left to split among, not 4: 1 / (6 * 2 * 4)
        self.assertEqual((found["paths"][0]["strength"], found["routes"], found["strength"]), (0.02083, 1, 0.02083))

    def test_paths_list_the_longer_ones_strongest_first_too(self):
        # Cyd to Sam Twin. Five links through Bob, P1 and the university: 1/(2*4*6*3) by WG-Analytics
        # and 1/(4*4*6*3) by P2. Six links through Bob, WG-Devices, Ada and the university:
        # 1/(2*4*2*4*3) and 1/(4*4*2*4*3).
        found = self.kg.paths(CYD, TWIN1, max_hops=m.MAX_HOPS, limit=25)
        self.assertEqual([(p["hops"], p["strength"]) for p in found["paths"]],
                         [(5, 0.006944), (5, 0.003472), (6, 0.005208), (6, 0.002604)])
        self.assertEqual((found["shortest"], found["routes"], found["strength"]), (5, 2, 0.01042))   # the five-link ones
        self.assertFalse({"more", "partial"} & set(found))
        # Sam Twin to WG-Devices: by the university and Ada, 1/(3*4); the longer way by P1 and Bob, 1/(3*6*4).
        # Neither end is counted, though WG-Devices has two neighbours of its own.
        found = self.kg.paths(TWIN1, WGD)
        self.assertEqual([(p["hops"], p["strength"], p["nodes"]) for p in found["paths"]],
                         [(3, 0.08333, [TWIN1, ORG, ADA, WGD]), (4, 0.01389, [TWIN1, ORG, P1, BOB, WGD])])
        self.assertEqual([(p["hops"], p["strength"]) for p in self.kg.paths(WGD, TWIN1)["paths"]], [(3, 0.08333), (4, 0.01389)])

    def test_paths_say_whether_there_are_more_and_can_be_paged(self):
        # Bob to Sam Twin: one path of three links, one of four.
        first = self.kg.paths(BOB, TWIN1, limit=1)
        self.assertEqual((first["listed"], first["routes"], first["more"]), (1, 1, True))   # the longer one counts as more
        self.assertEqual([p["hops"] for p in self.kg.paths(BOB, TWIN1, max_hops=3)["paths"]], [3])   # not the 4-link one
        self.assertNotIn("more", self.kg.paths(BOB, TWIN1, limit=2))
        second = self.kg.paths(BOB, TWIN1, limit=1, offset=1)
        self.assertEqual(([p["nodes"] for p in second["paths"]], "more" in second), ([[BOB, WGD, ADA, ORG, TWIN1]], False))
        whole = self.kg.paths(ADA, CYD)["paths"]
        pages = [self.kg.paths(ADA, CYD, limit=2, offset=skip) for skip in (0, 2, 4)]
        self.assertEqual([page["paths"] for page in pages], [whole[:2], whole[2:], []])
        self.assertEqual([(page["listed"], page.get("more"), page["routes"]) for page in pages],
                         [(2, True, 4), (2, None, 4), (0, None, 4)])
        self.assertEqual(self.kg.paths(ADA, CYD, limit=2, offset=-3)["paths"], whole[:2])

    def test_paths_say_when_the_search_among_longer_ones_gave_up(self):
        with mock.patch.object(m, "PATH_STEPS", 1):
            cut = self.kg.paths(BOB, TWIN1)
        self.assertEqual(([p["hops"] for p in cut["paths"]], cut["partial"]), ([3], True))   # the shortest is never lost
        self.assertNotIn("more", cut)                                                    # not known, so not claimed
        self.assertNotIn("partial", self.kg.paths(BOB, TWIN1))
        with mock.patch.object(m, "PATH_STEPS", 0):                 # two linked nodes: nothing longer to look for
            linked = self.kg.paths(ADA, P1, max_hops=m.MAX_HOPS, limit=25)
        self.assertEqual((linked["listed"], linked["routes"]), (1, 1))
        self.assertFalse({"more", "partial"} & set(linked))

    def test_the_strongest_shortest_paths_are_found_without_listing_them_all(self):
        # Three layers of six between a and b, every node linked to every node of the next layer: 216
        # shortest paths. A node in layer L, position i, has i dead ends hung on it, so paths differ
        # in strength. The first five must be the five strongest of all 216, in order, whether or
        # not the search for longer paths has a single step to spend.
        lines = ['bid:a a bbqs:Project ; bbqs:name "A" . bid:b a bbqs:Project ; bbqs:name "B" .']
        for layer in range(3):
            for i in range(6):
                node = f"bid:l{layer}n{i}"
                nxt = ", ".join(f"bid:l{layer + 1}n{j}" for j in range(6)) if layer < 2 else "bid:b"
                lines.append(f'{node} a bbqs:Investigator ; bbqs:name "L{layer}N{i}" ; bbqs:next {nxt} .')
                lines += [f'bid:d{layer}{i}{k} a bbqs:Dataset ; bbqs:name "D{layer}{i}{k}" ; bbqs:of {node} .'
                          for k in range(i)]
        lines.append("bid:a bbqs:next " + ", ".join(f"bid:l0n{i}" for i in range(6)) + " .")
        kg = small_kg("\n".join(lines))
        fan = {f"l{layer}n{i}": (7 if layer == 0 else 12) + i for layer in range(3) for i in range(6)}
        fan.update({f"l2n{i}": 7 + i for i in range(6)})
        everything = sorted(((Fraction(1, fan[x] * fan[y] * fan[z]), ["a", x, y, z, "b"])
                             for x in (f"l0n{i}" for i in range(6)) for y in (f"l1n{i}" for i in range(6))
                             for z in (f"l2n{i}" for i in range(6))), key=lambda one: (-one[0], one[1]))
        self.assertEqual(len(everything), 216)
        for steps in (m.PATH_STEPS, 1):
            with mock.patch.object(m, "PATH_STEPS", steps):
                there, back = kg.paths("A", "B", limit=5, offset=3), kg.paths("B", "A", limit=5, offset=3)
            self.assertEqual((there["routes"], there["more"]), (216, True))
            self.assertEqual(there["strength"], m._shown(sum((one[0] for one in everything), Fraction(0))))
            self.assertEqual([p["strength"] for p in there["paths"]], [m._shown(one[0]) for one in everything[3:8]])
            self.assertEqual([[kg.resolve(n).label.lower() for n in p["nodes"]] for p in there["paths"]],
                             [nodes for _, nodes in everything[3:8]])
            self.assertEqual([p["nodes"][::-1] for p in back["paths"]], [p["nodes"] for p in there["paths"]])
            self.assertNotIn("partial", there)                    # the shortest paths never use the step budget
        deep = kg.paths("A", "B", limit=5, offset=200)            # a page far down the list is still in order
        self.assertEqual([[kg.resolve(n).label.lower() for n in p["nodes"]] for p in deep["paths"]],
                         [nodes for _, nodes in everything[200:205]])
        # Without listing them all: count how often the search asks a node for its neighbours. Listing
        # every shortest path, or a bound that is not exact, asks over 600 times; this asks under 216,
        # fewer than one time per shortest path.
        asked, ways = [0], kg._ways
        kg._ways = lambda avoid: (lambda found: (lambda iri: (asked.__setitem__(0, asked[0] + 1), found(iri))[1]))(ways(avoid))
        kg.paths("A", "B", limit=5, offset=3)
        del kg._ways
        self.assertLess(asked[0], 216)
        # A page so deep that finding it would take too long is cut short, and the reply says so.
        with mock.patch.object(m, "SHORTEST_STEPS", 5):
            cut = kg.paths("A", "B", limit=5, offset=100)
            past = kg.paths("A", "B", limit=5, offset=216)           # past every shortest path: more is not known
        self.assertEqual((cut["partial"], cut["more"], cut["routes"]), (True, True, 216))
        self.assertEqual((past["partial"], "more" in past, past["listed"]), (True, False, 0))
        self.assertEqual(len(kg.paths("A", "B", limit=5, offset=100)["paths"]), 5)

    def test_longer_paths_of_equal_strength_come_in_the_order_of_their_nodes(self):
        # A-M-B is the shortest. A-a1-a2-B and A-z1-z2-B are as strong as each other; the one through
        # a1 comes first, whatever the names say ("Zulu" is a1, "Alpha" is z1).
        kg = small_kg("""
            bid:a a bbqs:Project ; bbqs:name "A" ; bbqs:e bid:m, bid:a1, bid:z1 .
            bid:m a bbqs:Investigator ; bbqs:name "M" ; bbqs:e bid:b .
            bid:a1 a bbqs:Investigator ; bbqs:name "Zulu" ; bbqs:e bid:a2 .
            bid:a2 a bbqs:Investigator ; bbqs:name "Zulu2" ; bbqs:e bid:b .
            bid:z1 a bbqs:Investigator ; bbqs:name "Alpha" ; bbqs:e bid:z2 .
            bid:z2 a bbqs:Investigator ; bbqs:name "Alpha2" ; bbqs:e bid:b .
            bid:b a bbqs:Project ; bbqs:name "B" .""")
        found = kg.paths("A", "B")["paths"]
        self.assertEqual([[kg.resolve(n).label for n in p["nodes"]] for p in found],
                         [["A", "M", "B"], ["A", "Zulu", "Zulu2", "B"], ["A", "Alpha", "Alpha2", "B"]])
        self.assertEqual([p["strength"] for p in found], [0.5, 0.25, 0.25])

    def test_a_long_name_on_a_route_is_clipped(self):
        kg = small_kg("""
            bid:a a bbqs:Project ; bbqs:name "A" ; bbqs:e bid:m .
            bid:m a bbqs:Investigator ; bbqs:name "A middle node whose name runs on well past forty characters" ;
                bbqs:e bid:b .
            bid:b a bbqs:Project ; bbqs:name "B" .""")
        step = kg.related("A", type="Project")["related"][0]["nodes"][0]["through"][0]
        self.assertEqual((len(step["label"]), step["label"][-1]), (40, "…"))

    def test_paths_read_the_same_from_either_end(self):
        linked = sorted((node for node in self.kg.nodes.values() if node.links), key=lambda node: node.iri)
        joined = 0
        for a in linked:
            for b in linked:
                if a.iri < b.iri:
                    there = self.kg.paths(a.id, b.id, max_hops=m.MAX_HOPS, limit=2)
                    back = self.kg.paths(b.id, a.id, max_hops=m.MAX_HOPS, limit=2)
                    self.assertEqual((there["source"], there["target"]), (back["target"], back["source"]))
                    self.assertEqual([(p["strength"], p["nodes"]) for p in there["paths"]],
                                     [(p["strength"], p["nodes"][::-1]) for p in back["paths"]], (a.id, b.id))
                    summary = ("listed", "shortest", "routes", "strength", "more", "partial", "note")
                    self.assertEqual([there.get(k) for k in summary], [back.get(k) for k in summary], (a.id, b.id))
                    joined += bool(there["paths"])
        self.assertGreater(joined, 100)
        # Two equally strong routes, the same kind of link all along, named so that the first node
        # sorts one way from a and the other way from b. Cut at one path, both ends must keep the same one.
        kg = small_kg("""bid:a a bbqs:Investigator ; bbqs:name "A" ; bbqs:knows bid:p1, bid:p2 .
                         bid:b a bbqs:Investigator ; bbqs:name "B" ; bbqs:knows bid:q1, bid:q2 .
                         bid:p1 a bbqs:Investigator ; bbqs:name "P1" ; bbqs:knows bid:q2 .
                         bid:p2 a bbqs:Investigator ; bbqs:name "P2" ; bbqs:knows bid:q1 .
                         bid:q1 a bbqs:Investigator ; bbqs:name "Q1" . bid:q2 a bbqs:Investigator ; bbqs:name "Q2" .""")
        there, back = kg.paths("A", "B", limit=1), kg.paths("B", "A", limit=1)
        self.assertEqual((there["routes"], there["strength"], there["more"]), (2, 0.5, True))
        self.assertEqual([kg.resolve(n).label for n in there["paths"][0]["nodes"]], ["A", "P1", "Q2", "B"])
        self.assertEqual(back["paths"][0]["nodes"], there["paths"][0]["nodes"][::-1])
        # ...and find_related shows that same route as the strongest, asked from either end
        from_a = kg.related("A", max_hops=3)["related"][0]["nodes"][-1]
        from_b = kg.related("B", max_hops=3)["related"][0]["nodes"][-1]
        self.assertEqual((from_a["label"], [step["label"] for step in from_a["through"]]), ("B", ["P1", "Q2"]))
        self.assertEqual((from_b["label"], [step["label"] for step in from_b["through"]]), ("A", ["Q2", "P1"]))
        self.assertEqual((from_a["routes"], from_a["share"], from_b["share"]), (2, 0.5, 0.5))
        # Two link kinds, and again two equally strong routes between n4 and n5.
        kg = small_kg("".join(f'bid:n{i} a bbqs:Project ; bbqs:name "N{i}" .\n' for i in range(6)) + """
            bid:n0 bbqs:f bid:n2, bid:n4 ; bbqs:e bid:n5 . bid:n1 bbqs:e bid:n3, bid:n4 ; bbqs:f bid:n5 .
            bid:n2 bbqs:e bid:n4 . bid:n3 bbqs:e bid:n4 .""")
        there, back = kg.paths("N4", "N5", limit=1), kg.paths("N5", "N4", limit=1)
        self.assertEqual((there["routes"], there["more"]), (2, True))
        self.assertEqual([kg.resolve(n).label for n in there["paths"][0]["nodes"]], ["N4", "N0", "N5"])
        self.assertEqual(back["paths"][0]["nodes"], there["paths"][0]["nodes"][::-1])
        # Two nodes that cite each other are one tie and one path, the same from both.
        kg = small_kg("""bid:a a bbqs:Publication ; bbqs:name "A" ; bbqs:cites bid:b .
                         bid:b a bbqs:Publication ; bbqs:name "B" ; bbqs:cites bid:a .""")
        there, back = kg.paths("A", "B"), kg.paths("B", "A")
        self.assertEqual((there["listed"], there["routes"], there["strength"]), (1, 1, 1))
        self.assertEqual((back["listed"], back["paths"][0]["nodes"]), (1, there["paths"][0]["nodes"][::-1]))

    def test_paths_have_no_detours(self):
        # ada-org-p1 is a real chain, but ada is on p1 directly: the longer way round adds nothing.
        for path in self.kg.paths(ADA, CYD, max_hops=m.MAX_HOPS, limit=25)["paths"]:
            self.assertNotIn(ORG, path["nodes"])
            self.assertEqual(path["hops"], 4)

    def test_a_shared_identifier_is_a_path(self):
        found = self.kg.paths(ADA, PUB1)
        self.assertEqual([p["nodes"] for p in found["paths"]], [[ADA, "ext:" + O1, PUB1], [ADA, P1, PUB1]])
        self.assertEqual(self.kg.paths(PUB2, PUB3)["paths"][0]["nodes"], [PUB2, "ext:" + O4, PUB3])

    def test_paths_tell_not_connected_from_too_far(self):
        self.assertIn("Not connected", self.kg.paths(ADA, DEV)["note"])
        self.assertIn("Not connected", self.kg.paths(ADA, DEE)["note"])
        far = self.kg.paths(MOUSE, ZEBRA, max_hops=3)
        self.assertEqual((far["listed"], far["shortest"]), (0, 4))
        self.assertIn("4 hops", far["note"])
        self.assertEqual(self.kg.paths(MOUSE, ZEBRA)["paths"][0]["nodes"], [MOUSE, P1, BOB, P2, ZEBRA])
        self.assertIn("same node", self.kg.paths(ADA, "Ada Lovelace")["note"])
        cut = self.kg.paths(ADA, CYD, avoid_edges=["member_of_group", "has_role"])
        self.assertIn("without has_role, member_of_group", cut["note"])

    def test_paths_say_when_there_are_more_than_were_returned(self):
        some = self.kg.paths(ADA, CYD, limit=2)
        self.assertEqual((some["listed"], some["more"]), (2, True))

    # -- SPARQL --

    def test_sparql_sees_the_graph_as_exported(self):
        roster = self.kg.sparql("""SELECT ?name ?role WHERE { ?p bbqs:grant_number "R34DA000001" .
            ?r a bbqs:ProjectRole ; bbqs:on_project ?p ; bbqs:project_role ?role ; bbqs:held_by ?person .
            ?person bbqs:name ?name } ORDER BY ?name""")
        self.assertEqual(roster, {"columns": ["name", "role"],
                                  "rows": [["Ada Lovelace", "contact_pi"], ["Bob Müller", "co_pi"]]})
        totals = self.kg.sparql("SELECT (SUM(?a) AS ?total) (COUNT(?p) AS ?n) WHERE { ?p bbqs:award_amount ?a }")
        self.assertEqual(totals["rows"], [[350, 2]])
        self.assertEqual(self.kg.sparql("ASK { ?p a bbqs:Project }"), {"answer": True})
        self.assertEqual(self.kg.sparql("ASK { ?p a bbqs:Nothing }"), {"answer": False})

    def test_sparql_speaks_the_same_ids_as_the_other_tools(self):
        rows = self.kg.sparql("SELECT ?project ?species ?kind WHERE { ?project bbqs:studies_species ?species . "
                              "?species a ?kind } ORDER BY ?project")["rows"]
        self.assertEqual(rows[0], ["bid:" + P1, "bid:" + MOUSE, "bbqs:Species"])
        by_short_id = self.kg.sparql(f"SELECT ?n WHERE {{ bid:{P1} bbqs:grant_number ?n }}")
        self.assertEqual(by_short_id["rows"], [["R34DA000001"]])
        full = self.kg.resolve(P1).iri.rsplit("/", 1)[-1]
        self.assertEqual(self.kg.sparql(f"SELECT ?n WHERE {{ bid:{full} bbqs:grant_number ?n }}")["rows"],
                         [["R34DA000001"]])
        self.assertIn("more than one id", self.err(self.kg.sparql, "SELECT ?p WHERE { bid:a1b2c3d4 ?p ?o }"))
        orcids = self.kg.sparql("SELECT ?o WHERE { ?s bbqs:orcid ?o } ORDER BY ?o LIMIT 1")["rows"]
        self.assertEqual(orcids, [[f"<{O1}>"]])

    def test_sparql_caps_rows_and_says_so(self):
        capped = self.kg.sparql("SELECT ?s WHERE { ?s a bbqs:Investigator }", limit=2)
        self.assertEqual((len(capped["rows"]), capped["more"]), (2, True))
        self.assertNotIn("more", self.kg.sparql("SELECT ?s WHERE { ?s a bbqs:Investigator }", limit=6))

    def test_sparql_refuses_everything_that_is_not_a_read_of_this_graph(self):
        refused = {
            "INSERT DATA { <urn:a> <urn:b> <urn:c> }": "Only SPARQL SELECT and ASK",
            "DELETE WHERE { ?s ?p ?o }": "Only SPARQL SELECT and ASK",
            "LOAD <http://example.org/x.ttl>": "Only SPARQL SELECT and ASK",
            "CLEAR ALL": "Only SPARQL SELECT and ASK",
            "CONSTRUCT { ?s a bbqs:X } WHERE { ?s a bbqs:Project }": "only SELECT and ASK",
            "DESCRIBE ?s WHERE { ?s a bbqs:Project }": "only SELECT and ASK",
            "SELECT * WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }": "FROM and SERVICE",
            "SELECT ?s WHERE { ?s a bbqs:Project OPTIONAL { SERVICE SILENT <http://x.example/> { ?s ?p ?o } } }":
                "FROM and SERVICE",
            "SELECT ?s FROM <http://example.org/g.ttl> WHERE { ?s ?p ?o }": "FROM and SERVICE",
            "SELECT ?s FROM NAMED <http://example.org/g.ttl> WHERE { GRAPH ?g { ?s ?p ?o } }": "FROM and SERVICE",
            "SELECT ?s WHERE { ?s ?p }": "Only SPARQL SELECT and ASK",
        }
        for query, reason in refused.items():
            self.assertIn(reason, self.err(self.kg.sparql, query), query)

    def test_sparql_stops_a_runaway_query(self):
        # Run on a thread with a deadline of its own, so a broken budget fails this test instead
        # of hanging the suite: four unjoined patterns over this graph are 118^4 rows.
        outcome = {}

        def runaway():
            try:
                outcome["rows"] = self.kg.sparql(
                    "SELECT (COUNT(*) AS ?n) WHERE { ?a ?b ?c . ?d ?e ?f . ?g ?h ?i . ?j ?k ?l }")
            except m.KGError as refused:
                outcome["refused"] = str(refused)

        with mock.patch.object(m, "SPARQL_SECONDS", 0.3):
            worker = threading.Thread(target=runaway, daemon=True)
            worker.start()
            worker.join(15)
        self.assertFalse(worker.is_alive(), "the query was still running 15 s after a 0.3 s budget")
        self.assertIn("Stopped after 0.3 seconds", outcome.get("refused", ""))
        self.assertEqual(self.kg.sparql("ASK { ?p a bbqs:Project }"), {"answer": True})   # and the budget is released

    # -- arguments as clients actually send them --

    def test_list_arguments_arrive_in_several_shapes(self):
        for shape in (["has_role", "member_of_group"], '["has_role", "member_of_group"]', "has_role, member_of_group",
                      "has_role,member_of_group"):
            self.assertEqual(self.kg.neighbors(ADA, edge=shape)["total"], 2, shape)
        self.assertEqual(m._as_list(None), [])
        self.assertEqual(m._as_list(""), [])
        self.assertEqual(m._as_list("[broken, json"), ["broken", "json"])


class ReadOnly(unittest.TestCase):
    """No tool, given anything, changes the graph it serves."""

    def test_nothing_a_tool_does_changes_a_triple(self):
        kg = fixture_kg()
        before = sorted(kg.graph)
        calls = [
            lambda: kg.describe(), lambda: kg.search("mouse"),
            lambda: kg.search(type="Project", where={"mechanism": "R34"}),
            lambda: kg.node(P1), lambda: kg.neighbors(ADA, depth=m.MAX_DEPTH), lambda: kg.paths(ADA, CYD, limit=25),
            lambda: kg.related([ADA, CYD], limit=25), lambda: kg.related(P1, avoid_edges="has_role"),
            lambda: kg.sparql("SELECT * WHERE { ?s ?p ?o }", limit=m.MAX_ROWS),
            lambda: kg.sparql("INSERT DATA { <urn:a> <urn:b> <urn:c> }"),
            lambda: kg.sparql("DELETE WHERE { ?s ?p ?o }"), lambda: kg.sparql("DROP ALL"),
            lambda: kg.sparql("LOAD <http://example.org/x.ttl>"),
            lambda: kg.sparql("SELECT * WHERE { SERVICE <http://example.org/> { ?s ?p ?o } }"),
        ]
        refused = 0
        for call in calls:
            try:
                call()
            except m.KGError:
                refused += 1
        self.assertEqual(refused, 5)                      # the four writes and the outbound SERVICE
        self.assertEqual(sorted(kg.graph), before)
        self.assertGreater(len(before), 100)              # the fixture really was loaded

    def test_the_only_calls_that_write_to_a_graph_are_the_ones_that_load_it(self):
        # A text check, so a later change cannot add a write path without this test noticing: the
        # rdflib calls that mutate a graph must not appear anywhere but the one load in _read().
        source = SERVER.read_text(encoding="utf8")
        parses = re.findall(r"(\w*Graph\(\))?\.parse\(", source)
        self.assertEqual(parses, ["Graph()", "_BudgetedGraph()"])   # the schema, the graph: each into a graph of its own
        for writer in (r"graph\.update\(", r"graph\.add\(", r"graph\.remove\(", r"graph\.set\(", r"\.serialize\(",
                       r"\.addN\(", r"open\([^)]*[\"'][wa]b?[\"']", r"\.write_text\(", r"\.write_bytes\("):
            self.assertIsNone(re.search(writer, source), writer)


class TheExport(unittest.TestCase):
    """The committed graph: what the consortium's own questions get back through the server."""

    @classmethod
    def setUpClass(cls):
        cls.kg = m.GraphSource(str(EXPORT)).current()
        cls.plain = Graph().parse(str(EXPORT), format="turtle")
        cls.questions = yaml.safe_load((HERE / "competency_questions.yaml").read_text(encoding="utf8"))["questions"]
        cls.baseline = json.loads((HERE / "quality_baseline.json").read_text(encoding="utf8"))

    def test_every_node_of_the_export_is_reachable_by_the_view(self):
        typed = {str(s) for s in self.plain.subjects(m.RDF.type, None)}
        folded = {str(s) for kind in m.FOLDED for s in self.plain.subjects(m.RDF.type, m.URIRef(m.SCHEMA_NS + kind))}
        outside = {n.iri for n in self.kg.nodes.values() if n.type == m.EXTERNAL}
        self.assertEqual(set(self.kg.nodes) - outside, typed - folded)
        self.assertEqual(len(folded), self.kg.edge_counts[("Investigator", "has_role", "Project")]
                         + sum(self.kg.unfolded.values()))
        self.assertTrue(all(iri.startswith(m.ID_NS) for iri in typed))
        self.assertGreater(len(self.kg.nodes), 500)

    def test_every_link_of_the_export_is_a_link_of_the_view(self):
        typed = {str(s) for s in self.plain.subjects(m.RDF.type, None)}
        folded = {str(s) for kind in m.FOLDED for s in self.plain.subjects(m.RDF.type, m.URIRef(m.SCHEMA_NS + kind))}
        expected = sorted((str(s), m._local(str(p)), str(o)) for s, p, o in self.plain
                          if p != m.RDF.type and str(o) in typed and str(s) not in folded)
        got = sorted((n.iri, l.edge, l.other) for n in self.kg.nodes.values() for l in n.links
                     if l.out and l.edge not in {r["edge"] for r in m.FOLDED.values()}
                     and self.kg.nodes[l.other].type != m.EXTERNAL)
        self.assertEqual(got, expected)

    def test_every_answered_competency_question_is_answered_through_the_server(self):
        asked = 0
        for question in self.questions:
            if question["id"] not in self.baseline["answered"]:
                continue
            asked += 1
            direct = self.plain.query(question["sparql"], initNs=m.PREFIXES)
            through = self.kg.sparql(question["sparql"], limit=m.MAX_ROWS)
            self.assertGreater(len(through["rows"]), 0, question["id"])
            self.assertEqual(through["columns"], [str(v) for v in direct.vars], question["id"])
            same = lambda rows: sorted(json.dumps(row, sort_keys=True, default=str) for row in rows)  # noqa: E731
            self.assertEqual(same(through["rows"]), same([self.kg._cell(c) for c in row] for row in direct),
                             question["id"])                       # the same rows, not just as many
        self.assertEqual(asked, len(self.baseline["answered"]))
        self.assertGreaterEqual(asked, 16)

    def _column(self, sparql: str) -> list:
        return sorted(str(row[0]) for row in self.plain.query(sparql, initNs=m.PREFIXES))

    def test_walking_agrees_with_sparql_on_who_holds_a_role(self):            # CQ04
        expected = sorted(f"{row[0]}|{row[1]}" for row in self.plain.query("""SELECT ?name ?role WHERE {
            ?project bbqs:grant_number "R34DA059723" . ?pr a bbqs:ProjectRole ; bbqs:on_project ?project ;
            bbqs:project_role ?role ; bbqs:held_by ?person . ?person bbqs:name ?name }""", initNs=m.PREFIXES))
        walked = self.kg.neighbors("R34DA059723", edge="has_role", limit=200)["nodes"]
        self.assertEqual(sorted(f"{self.kg.resolve(n['id']).props['name'][0]}|{n['via']['role']}" for n in walked),
                         expected)
        self.assertTrue(expected)

    def test_one_call_on_a_project_reaches_its_people_and_its_species(self):   # the smoke check of #434
        around = self.kg.neighbors("R34DA059723", limit=200)
        self.assertGreaterEqual(around["reached_by_type"].get("Investigator", 0), 1)
        self.assertGreaterEqual(around["reached_by_type"].get("Species", 0), 1)

    def test_two_links_from_a_person_is_not_their_whole_working_group(self):
        members = self.kg.neighbors("WG-Analytics", edge="member_of_group", direction="in", limit=200)
        self.assertGreater(members["total"], m.HUB_LINKS)
        someone = next(n["id"] for n in members["nodes"] if n["links"] >= 3)
        near = self.kg.neighbors(someone, depth=2, limit=200)
        self.assertIn("WG-Analytics", [hub["label"] for hub in near["hubs_not_walked_through"]])
        self.assertLess(near["total"], members["total"] // 2)
        self.assertGreater(self.kg.neighbors(someone, depth=2, limit=200, through_hubs=True)["total"], members["total"])

    def test_walking_agrees_with_sparql_on_working_group_members(self):       # CQ08
        expected = self._column('SELECT ?person WHERE { ?wg a bbqs:WorkingGroup ; bbqs:name "WG-Devices" . '
                                '?person bbqs:member_of_group ?wg }')
        walked = self.kg.neighbors("WG-Devices", edge="member_of_group", direction="in", limit=200)
        self.assertEqual(sorted(self.kg.resolve(n["id"]).iri for n in walked["nodes"]), expected)
        self.assertEqual(walked["total"], len(expected))
        self.assertGreater(len(expected), 10)

    def test_walking_agrees_with_sparql_two_hops_out(self):                   # CQ09 + CQ04, chained
        expected = self._column('SELECT DISTINCT ?person WHERE { ?species bbqs:common_name "House Mouse" . '
                                '?project bbqs:studies_species ?species . ?pr bbqs:on_project ?project ; '
                                'bbqs:held_by ?person }')
        walked = self.kg.neighbors("House Mouse", edge=["studies_species", "has_role"], depth=2, type="Investigator",
                                   limit=200)
        self.assertEqual(sorted(self.kg.resolve(n["id"]).iri for n in walked["nodes"]), expected)
        self.assertTrue(expected)

    def test_on_the_export_too_the_code_is_the_process_it_is_named_after(self):
        linked = sorted((node for node in self.kg.nodes.values() if node.links), key=lambda node: node.iri)
        for start in linked[::25]:
            wave = self.kg._wave(start)
            self.assertEqual({iri: (found.hops, found.strength) for iri, found in wave.items() if found.hops},
                             first_arrivals(self.kg, start), start.id)
        self.assertGreater(len(linked[::25]), 15)

    def test_the_paths_between_two_nodes_account_for_the_whole_of_their_tie(self):
        # find_paths lists the shortest paths one at a time and find_related adds them up. The sum
        # is redone here from nothing but the ids on each path and those nodes' neighbours.
        checked = 0
        for start in ("House Mouse", "WG-Devices", "R34DA059723"):
            wave = self.kg._wave(self.kg.resolve(start))
            for group in self.kg.related(start, limit=3, max_hops=m.MAX_HOPS)["related"]:
                for row in group["nodes"]:
                    found = self.kg.paths(start, row["id"], max_hops=row["hops"], limit=25)
                    self.assertEqual((found["shortest"], found["strength"], found["routes"]),
                                     (row["hops"], row["strength"], row.get("routes", 1)), (start, row["id"]))
                    if found["routes"] > 25:
                        self.assertEqual((found["listed"], found["more"]), (25, True))
                        continue                                    # more than one page: the first is not the sum
                    self.assertEqual(found["listed"], found["routes"])
                    total = Fraction(0)
                    for path in found["paths"]:
                        left = Fraction(1)
                        for between in path["nodes"][1:-1]:
                            left /= len(self.kg.resolve(between).near)
                        self.assertEqual(path["strength"], m._shown(left))
                        total += left
                    self.assertEqual(wave[self.kg.resolve(row["id"]).iri].strength, total)
                    checked += 1
        self.assertGreater(checked, 40)

    def test_the_route_find_related_shows_is_the_path_find_paths_lists_first(self):
        compared = several = 0
        for start in sorted((n for n in self.kg.nodes.values() if n.near), key=lambda n: n.iri)[::25]:
            for group in self.kg.related(start.id, limit=4)["related"]:
                for row in group["nodes"]:
                    if row["hops"] == 1:
                        continue
                    first = self.kg.paths(start.id, row["id"], max_hops=row["hops"], limit=1)["paths"][0]
                    self.assertEqual(first["nodes"][1:-1], ids(row["through"]), (start.id, row["id"]))
                    back = self.kg.related(row["id"], type=start.type, limit=25, max_hops=row["hops"])["related"][0]
                    seen_back = next((n for n in back["nodes"] if n["id"] == start.id), None)
                    if seen_back:                                # the same route, read the other way
                        self.assertEqual(ids(seen_back["through"]), ids(row["through"])[::-1])
                    compared += 1
                    several += row.get("routes", 1) > 1
        self.assertGreater(compared, 150)
        self.assertGreater(several, 40)

    def test_strength_finds_a_hidden_link_better_than_distance_alone(self):
        # A measure of whether the ranking is worth having on the real graph, kept so that a change
        # that makes it worse shows. It is not what defends the rule itself: the hand-worked tests do
        # that. Hide one real tie, start at one of its ends, and see where the other end lands among
        # the nodes of its own type that the start is not already tied to. Scored as the chance of
        # being in the first ten when equals fall in any order, which is what a list really shows.
        kg = m.GraphSource(str(EXPORT)).current()         # a graph of its own: ties are taken out and put back
        cases, by_strength, by_distance, pair = 0, 0.0, 0.0, 0
        for node in sorted((n for n in kg.nodes.values() if n.links), key=lambda n: n.iri):
            for other_iri in [iri for iri in node.near if node.iri < iri]:
                pair += 1
                if pair % 3:
                    continue                                        # every third tie: the measure, at a third of the cost
                other = kg.nodes[other_iri]
                links, back = node.near.pop(other_iri), other.near.pop(node.iri)
                for start, hidden in ((node, other), (other, node)):
                    if not start.near:
                        continue                                    # it was the start's only tie: nothing to go on
                    cases += 1
                    wave = kg._wave(start)
                    if hidden.iri not in wave:
                        continue                                    # not found, by either ordering
                    rivals = [found for iri, found in wave.items()
                              if found.hops and iri not in start.near and kg.nodes[iri].type == hidden.type]

                    def in_first_ten(key):
                        mine = key(wave[hidden.iri])
                        ahead, level = sum(key(r) < mine for r in rivals), sum(key(r) == mine for r in rivals)
                        return min(max((10 - ahead) / level, 0.0), 1.0)

                    by_strength += in_first_ten(lambda found: (found.hops, -found.strength))
                    by_distance += in_first_ten(lambda found: found.hops)
                node.near[other_iri], other.near[node.iri] = links, back
        self.assertGreater(cases, 400)
        # 2026-11-05, every third tie: in the first ten 65% of the time by strength, 45% by distance
        # alone. Counting routes and ignoring what each brings scores 1.34 times distance; this 1.44.
        self.assertGreater(by_strength, 1.38 * by_distance, (by_strength / cases, by_distance / cases))
        self.assertGreater(by_strength / cases, 0.5)

    def test_a_working_group_is_not_cut_off_it_just_passes_on_little(self):
        # The fan effect in place of a cut-off: two members of a big working group are tied through it
        # by exactly 1/members. The path is found and listed, and it is faint.
        group = max((node for node in self.kg.nodes.values() if node.type == "WorkingGroup"),
                    key=lambda node: (len(node.near), node.iri))
        members = len(group.near)
        self.assertGreater(members, m.HUB_LINKS)
        a, b = sorted((self.kg.nodes[iri] for iri in group.near), key=lambda n: (len(n.near), n.iri))[:2]
        found = self.kg.paths(a.iri, b.iri, max_hops=2, limit=25)
        through = [path for path in found["paths"] if path["nodes"] == [a.id, group.id, b.id]]
        self.assertEqual([path["strength"] for path in through], [m._shown(Fraction(1, members))])
        self.assertLess(through[0]["strength"], 1 / m.HUB_LINKS)
        self.assertEqual(found["shortest"], 2)
        self.assertGreaterEqual(found["strength"], through[0]["strength"])    # that path, plus any other

    def test_related_lists_are_capped_paged_and_say_how_many_tie(self):
        group = max((node for node in self.kg.nodes.values() if node.type == "WorkingGroup"),
                    key=lambda node: (len(node.near), node.iri))
        members = sum(1 for iri in group.near if self.kg.nodes[iri].type == "Investigator")
        self.assertGreater(members, 60)

        def people(**options):
            return self.kg.related(group.iri, type="Investigator", **options)["related"][0]

        asked_for_all = people(limit=10_000)
        self.assertEqual(len(asked_for_all["nodes"]), 25)   # the most one named type is given at once
        self.assertEqual(asked_for_all["tied"], {"hops": 1, "strength": 1, "count": members, "listed": 25})
        self.assertGreater(asked_for_all["within"], members)   # people outside the group are reached too
        next_page = people(limit=25, offset=25)
        self.assertEqual(len(next_page["nodes"]), 25)
        self.assertFalse(set(ids(asked_for_all["nodes"])) & set(ids(next_page["nodes"])))
        self.assertEqual(next_page["tied"], {"hops": 1, "strength": 1, "count": members, "listed": 25})
        beyond = people(limit=3, offset=members)
        self.assertEqual([n["hops"] for n in beyond["nodes"]], [3, 3, 3])      # past the members: three links away
        strengths = [n["strength"] for n in beyond["nodes"]]
        self.assertEqual(strengths, sorted(strengths, reverse=True))
        # with no type named, every type comes back, so each list is kept to ten
        overview = self.kg.related(group.iri, limit=10_000)["related"]
        self.assertEqual(max(len(g["nodes"]) for g in overview), 10)
        self.assertGreater(len(overview), 4)
        self.assertEqual(len(self.kg.related(group.iri)["related"][0]["nodes"]), 5)       # and to five unless asked

    def test_related_replies_stay_a_size_a_client_can_take(self):
        # What the tool sends, in bytes, for the questions most likely to be asked. Before distances
        # were limited and the routes kept short, five starting nodes came to 78,000.
        def sent(*args, **options):
            return len(json.dumps(self.kg.related(*args, **options), separators=(",", ":"), ensure_ascii=False))

        linked = sorted((node for node in self.kg.nodes.values() if node.links), key=lambda node: node.iri)
        self.assertLess(max(sent(node.iri) for node in linked[::7]), 20_000)
        self.assertLess(sent(["House Mouse", "WG-Devices", "WG-Analytics", "R34DA059723", "Human"]), 20_000)
        self.assertLess(max(sent(node.iri, limit=25, max_hops=m.MAX_HOPS) for node in linked[::25]), 60_000)
        # Naming types lifts the cap from 10 to 25, but only for up to three of them: naming every
        # type came to 72,000 when it lifted the cap for all.
        every, most = list(self.kg.types), [kind for kind, _ in Counter(n.type for n in self.kg.nodes.values()).most_common(3)]
        self.assertLess(max(sent(node.iri, type=every, limit=25, max_hops=m.MAX_HOPS) for node in linked[::25]), 40_000)
        self.assertLess(max(sent(node.iri, type=most, limit=25, max_hops=m.MAX_HOPS) for node in linked[::25]), 45_000)

    def test_every_shown_id_leads_back_to_its_node(self):
        for node in self.kg.nodes.values():
            self.assertIs(self.kg.resolve(node.id), node)
            self.assertIs(self.kg.resolve(node.iri) if node.type != m.EXTERNAL else node, node)
        self.assertEqual(len({n.id for n in self.kg.nodes.values()}), len(self.kg.nodes))

    def test_answers_come_out_in_the_same_order_every_time(self):
        again = m.GraphSource(str(EXPORT)).current()
        for call in (lambda kg: kg.search("behavior", limit=50), lambda kg: kg.neighbors("WG-Analytics", limit=200),
                     lambda kg: kg.paths("House Mouse", "WG-Devices", limit=10), lambda kg: kg.describe()["edge_types"],
                     lambda kg: kg.related(["House Mouse", "WG-Devices"], limit=25),
                     lambda kg: kg.related("WG-Analytics", limit=25)):
            self.assertEqual(json.dumps(call(self.kg)), json.dumps(call(again)))

    def test_the_committed_export_is_dated_by_its_commit_not_by_the_checkout(self):
        self.assertIn("kg/export/bbqs.ttl", self.kg.snapshot["source"])
        def git(*args):
            return subprocess.run(["git", "-C", str(HERE), *args, "--", "export/bbqs.ttl"],
                                  capture_output=True, text=True)

        tracked, committed = git("status", "--porcelain"), git("log", "-1", "--format=%ct").stdout.strip()
        if tracked.returncode == 0 and not tracked.stdout.strip() and committed:
            self.assertRegex(self.kg.snapshot["committed"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            self.assertNotIn("file_modified", self.kg.snapshot)
            self.assertEqual(self.kg.status()["age_days"], int((time.time() - int(committed)) // 86400))
        else:   # re-exported, untracked, or a clone too shallow to hold its commit: the file's own time
            self.assertIn("file_modified", self.kg.snapshot)


class TheSource(unittest.TestCase):
    """Where the graph comes from: it is re-read when it changes, and a failed read never
    replaces a good graph with nothing."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.file = Path(self.dir.name) / "graph.ttl"
        self.file.write_text(FIXTURE, encoding="utf8")

    def test_a_file_is_reread_only_when_it_changed(self):
        source = m.GraphSource(str(self.file), refresh_hours=1)
        first = source.current()
        self.assertEqual(first.snapshot["source"], "graph.ttl")          # the name, not the place on disk
        self.assertIn("file_modified", first.snapshot)
        source._due = 0
        self.assertIs(source.current(), first)                            # unchanged: same graph object
        self.file.write_text(FIXTURE + f'\n{_iri(DEE)} bbqs:skills "juggling" .\n', encoding="utf8")
        os.utime(self.file, ns=(time.time_ns() + 10 ** 9,) * 2)
        self.assertIs(source.current(), first)                            # not due yet
        source._due = 0
        second = source.current()
        self.assertIsNot(second, first)
        self.assertEqual(second.node(DEE)["properties"]["skills"], "juggling")

    def test_refresh_zero_reads_once(self):
        source = m.GraphSource(str(self.file), refresh_hours=0)
        first = source.current()
        self.file.write_text(FIXTURE + f'\n{_iri(DEE)} bbqs:skills "juggling" .\n', encoding="utf8")
        os.utime(self.file, ns=(time.time_ns() + 10 ** 9,) * 2)
        self.assertIs(source.current(), first)

    def test_a_broken_reread_keeps_the_graph_already_loaded_and_says_why(self):
        source = m.GraphSource(str(self.file))
        first = source.current()
        self.file.write_text("this is not turtle {", encoding="utf8")
        os.utime(self.file, ns=(time.time_ns() + 10 ** 9,) * 2)
        source._due = 0
        self.assertIs(source.current(), first)
        self.assertIn("graph.ttl", first.status()["preferred_source_failed"])
        self.assertIn("graph.ttl", first.describe()["snapshot"]["preferred_source_failed"])
        self.assertIs(first.cite()["preferred_source_failed"], True)       # and every answer is flagged
        self.file.write_text(FIXTURE, encoding="utf8")
        os.utime(self.file, ns=(time.time_ns() + 2 * 10 ** 9,) * 2)
        source._due = 0
        healed = source.current()
        self.assertNotIn("preferred_source_failed", healed.status())
        self.assertNotIn("preferred_source_failed", healed.cite())

    def test_a_reread_that_lost_most_of_the_graph_is_not_taken(self):
        # What a half-reachable database produces: a file that parses, with most of the graph gone.
        source = m.GraphSource(str(self.file))
        first = source.current()
        self.file.write_text("\n".join(FIXTURE.split("\n\n")[:2]), encoding="utf8")   # the six people, nothing else
        os.utime(self.file, ns=(time.time_ns() + 10 ** 9,) * 2)
        source._due = 0
        self.assertIs(source.current(), first)
        self.assertIn("8 nodes, under half of the 23 being served", first.status()["preferred_source_failed"])
        self.assertEqual(m.GraphSource(str(self.file)).current().describe()["nodes"], 8)   # fine as a first read

    def test_nothing_to_load_is_an_error_not_an_empty_graph(self):
        for bad in ("@prefix x: <urn:x:> .", "not turtle {"):
            self.file.write_text(bad, encoding="utf8")
            with self.assertRaises(m.KGError) as caught:
                m.GraphSource(str(self.file)).current()
            self.assertIn("No knowledge graph could be loaded", str(caught.exception))
        with self.assertRaises(m.KGError):
            m.GraphSource(str(Path(self.dir.name) / "missing.ttl")).current()

    def test_default_source_is_the_published_copy_then_the_committed_one(self):
        self.assertEqual(m.GraphSource().locations, [m.PUBLISHED_EXPORT, str(m.BUNDLED_EXPORT)])
        self.assertTrue(m.PUBLISHED_EXPORT.startswith("https://brain-bbqs.org/"))   # never a vendor host
        with mock.patch.object(m, "PUBLISHED_EXPORT", "http://127.0.0.1:9/kg/bbqs.ttl"):   # nothing listens there
            source = m.GraphSource()
            kg = source.current()
        self.assertIn("kg/export/bbqs.ttl", kg.snapshot["source"])
        self.assertIn("127.0.0.1:9", kg.status()["preferred_source_failed"])

    def test_a_url_is_fetched_revalidated_and_survives_an_outage(self):
        state = {"body": FIXTURE.encode(), "etag": '"v1"', "status": 200, "conditional": 0, "agent": None}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                state["agent"] = self.headers.get("User-Agent")
                if state["status"] != 200:
                    self.send_error(state["status"])
                elif self.headers.get("If-None-Match") == state["etag"]:
                    state["conditional"] += 1
                    self.send_response(304)
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("ETag", state["etag"])
                    self.send_header("Last-Modified", "Wed, 21 Oct 2026 07:28:00 GMT")
                    self.send_header("Content-Length", str(len(state["body"])))
                    self.end_headers()
                    self.wfile.write(state["body"])

            def log_message(self, *args):
                pass

        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        url = f"http://127.0.0.1:{httpd.server_port}/kg/bbqs.ttl"
        with mock.patch.dict(os.environ, {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"}):
            source = m.GraphSource(url)
            first = source.current()
            self.assertEqual(first.snapshot["source"], url)
            self.assertEqual(first.snapshot["last_modified"], "2026-10-21T07:28:00Z")
            self.assertGreaterEqual(first.status()["age_days"], 0)                  # worked out, not left to the reader
            self.assertEqual(state["agent"], f"bbqs-kg-mcp/{m.__version__}")       # names the tool, nobody else
            source._due = 0
            self.assertIs(source.current(), first)                                  # 304: nothing re-parsed
            self.assertEqual(state["conditional"], 1)
            state["status"] = 503
            source._due = 0
            self.assertIs(source.current(), first)                                  # outage: keep serving
            self.assertIn("HTTP 503", first.status()["preferred_source_failed"])
            state.update(status=200, etag='"v2"', body=(FIXTURE + f'\n{_iri(DEE)} bbqs:skills "juggling" .\n').encode())
            source._due = 0
            second = source.current()
            self.assertIsNot(second, first)
            self.assertNotIn("preferred_source_failed", second.status())
            self.assertEqual(second.node(DEE)["properties"]["skills"], "juggling")
            fallback = m.GraphSource()
            fallback.locations = [f"http://127.0.0.1:{httpd.server_port}/gone", str(self.file)]
            state["status"] = 404
            served = fallback.current()
            self.assertEqual(served.snapshot["source"], "graph.ttl")
            self.assertIn("HTTP 404", served.status()["preferred_source_failed"])
            state["status"] = 200
            fallback._due = 0
            self.assertEqual(fallback.current().snapshot["source"], fallback.locations[0])   # heals when it is back


class OnAPublicUrl(unittest.TestCase):
    """What running it as a web service needs: a source when the repository is not there, the port
    the host gives, and the public name it is reached by."""

    def test_without_the_repository_it_reads_the_export_committed_to_main(self):
        self.assertEqual(m.GraphSource(None, 0).locations, [m.PUBLISHED_EXPORT, str(m.BUNDLED_EXPORT)])
        with mock.patch.object(m, "BUNDLED_EXPORT", Path("/nowhere/export/bbqs.ttl")):
            self.assertEqual(m.GraphSource(None, 0).locations, [m.PUBLISHED_EXPORT, m.GITHUB_EXPORT])
        self.assertEqual(m.GITHUB_EXPORT, "https://raw.githubusercontent.com/brain-bbqs/bbqs-app/main/kg/export/bbqs.ttl")

    def test_the_port_and_the_public_names_come_from_the_host_s_environment(self):
        with mock.patch.dict(os.environ, {"PORT": "9123", "BBQS_KG_ALLOWED_HOSTS": "neuromcp.brain-bbqs.org, x.run.app"}):
            args = m.command_line(["--http"])
            self.assertEqual((args.port, args.allow_host), (9123, ["neuromcp.brain-bbqs.org", "x.run.app"]))
            self.assertEqual(m.command_line(["--allow-host", "a.org"]).allow_host, ["a.org"])   # the flag wins
        with mock.patch.dict(os.environ, {"PORT": "", "BBQS_KG_ALLOWED_HOSTS": ""}):
            self.assertEqual((m.command_line([]).port, m.command_line([]).allow_host, m.command_line([]).host),
                             (8000, [], "127.0.0.1"))
        self.assertIsNone(m.transport_security([]))                  # the SDK's own rule
        settings = m.transport_security(["neuromcp.brain-bbqs.org"])
        self.assertTrue(settings.enable_dns_rebinding_protection)
        self.assertIn("neuromcp.brain-bbqs.org", settings.allowed_hosts)
        self.assertIn("127.0.0.1:*", settings.allowed_hosts)
        self.assertIn("https://neuromcp.brain-bbqs.org", settings.allowed_origins)

    def test_behind_a_proxy_it_answers_its_public_name_and_no_other(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        graph = Path(folder.name) / "graph.ttl"
        graph.write_text(FIXTURE, encoding="utf8")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        log = tempfile.TemporaryFile()
        self.addCleanup(log.close)
        process = subprocess.Popen([sys.executable, str(SERVER), "--source", str(graph), "--http", "--no-sparql",
                                    "--allow-host", "kg.example.org"], stdout=log, stderr=log,
                                   env={**os.environ, "PORT": str(port)})
        self.addCleanup(lambda: (process.terminate(), process.wait(timeout=20)))
        import http.client

        def ask(host, origin=None):
            headers = {"Host": host, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
            if origin:
                headers["Origin"] = origin
            for _ in range(300):
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                    connection.request("POST", "/mcp", json.dumps(_request(1, "tools/list")), headers)
                    return connection.getresponse().status
                except ConnectionRefusedError:
                    if process.poll() is not None:
                        log.seek(0)
                        raise AssertionError(log.read().decode(errors="replace")[-2000:]) from None
                    time.sleep(0.2)
            raise AssertionError("the server did not start")

        self.assertEqual(ask("kg.example.org"), 200)                                    # its public name
        self.assertEqual(ask(f"127.0.0.1:{port}"), 200)                                 # and the local one
        self.assertEqual(ask("evil.example"), 421)                                      # not another name
        self.assertEqual(ask("kg.example.org", origin="https://evil.example"), 403)    # nor a page elsewhere
        self.assertEqual(ask("kg.example.org", origin="https://kg.example.org"), 200)


class Guards(unittest.TestCase):
    """Things that must stay true across files, where no reviewer would think to look."""

    @classmethod
    def setUpClass(cls):
        tbox = Graph().parse(str(HERE / "bbqs.owl.ttl"), format="turtle")
        cls.schema = {str(s)[len(m.SCHEMA_NS):] for s in tbox.subjects() if str(s).startswith(m.SCHEMA_NS)}
        cls.server = m.build_server(m.GraphSource(str(EXPORT)))
        cls.tools = asyncio.run(cls.server.list_tools())

    def test_every_schema_term_the_server_names_is_in_the_schema(self):
        named = set(m.LABEL_PREDICATES) | set(m.IDENTIFIER_PREDICATES) | set(m.PROJECT_LABEL) | {m.CAREER_LABEL}
        for kind, rule in m.FOLDED.items():
            named |= {kind, rule["from"], rule["to"], *rule["attrs"].values()}
        self.assertGreater(len(self.schema), 100)
        self.assertEqual(sorted(named - self.schema), [])

    def test_the_views_own_names_do_not_shadow_schema_terms(self):
        own = {rule["edge"] for rule in m.FOLDED.values()} | {m.EXTERNAL, m.UNRESOLVED, "Untyped"}
        self.assertEqual(sorted(own & self.schema), [])

    def test_every_term_a_description_mentions_exists(self):
        # What a model reads: a slot named there that the schema has since renamed would send it
        # asking for something that is not in the graph.
        texts = [m.INSTRUCTIONS, m.NODE, *m.GraphSource(str(EXPORT)).current().describe()["notes"],
                 *fixture_kg().describe()["notes"]]
        known = set(self.schema) | {rule["edge"] for rule in m.FOLDED.values()} | {name for rule in m.FOLDED.values()
                                                                                  for name in rule["attrs"]}

        def keys(value):                                  # every field name in a reply, however deep
            if isinstance(value, dict):
                return set(value) | {key for inner in value.values() for key in keys(inner)}
            return {key for inner in value for key in keys(inner)} if isinstance(value, list) else set()
        kg = fixture_kg()                                  # and the fields replies really carry
        known |= set().union(*map(keys, (kg.related(ADA), kg.related([ADA, CYD]), kg.paths(ADA, P3),
                                         kg.neighbors(ADA), kg.describe(), kg.node(ADA))))
        for tool in self.tools:
            known |= {tool.name, *tool.input_schema["properties"]}
            texts += [tool.description, *(p.get("description", "") for p in tool.input_schema["properties"].values())]
        mentioned = {word for text in texts for word in re.findall(r"\b[a-z]+(?:_[a-z0-9]+)+\b", text)}
        mentioned |= {word for text in texts for word in re.findall(r"\bbbqs:(\w+)", text)}
        mentioned |= {word for text in texts for word in re.findall(r"\b(?:[A-Z][a-z]+){2,}\b", text)}
        self.assertGreater(len(mentioned), 12)
        self.assertEqual(sorted(mentioned - known), [])

    def test_what_the_descriptions_say_about_the_ranking_is_what_the_server_does(self):
        # The rule as told to a client, against the rule as coded. The worked example in the words
        # of the find_related description and the describe_graph note is built here and run: S is
        # linked to M1 and M2, which have 5 neighbours each; T is on both, U on M1 only.
        hung = "".join(f'bid:x{i} a bbqs:Dataset ; bbqs:name "X{i}" . bid:m{1 if i < 2 else 2} bbqs:funded bid:x{i} .\n'
                       for i in range(5))                              # two more neighbours for M1, three for M2
        kg = small_kg(hung + """bid:s a bbqs:Species ; bbqs:name "S" .
            bid:t a bbqs:Investigator ; bbqs:name "T" . bid:u a bbqs:Investigator ; bbqs:name "U" .
            bid:m1 a bbqs:Project ; bbqs:name "M1" ; bbqs:studies bid:s ; bbqs:staffed_by bid:t, bid:u .
            bid:m2 a bbqs:Project ; bbqs:name "M2" ; bbqs:studies bid:s ; bbqs:staffed_by bid:t .
            bid:m3 a bbqs:Project ; bbqs:name "M3" ; bbqs:staffed_by bid:u .""")
        self.assertEqual([len(kg.resolve(name).near) for name in ("M1", "M2")], [5, 5])
        rows = {n["label"]: (n["hops"], n["strength"]) for group in kg.related("S", max_hops=3)["related"]
                for n in group["nodes"]}
        self.assertEqual((rows["M1"], rows["U"], rows["T"]), ((1, 1), (2, 0.2), (2, 0.4)))
        self.assertEqual([n["label"] for n in kg.related("S", type="Project", max_hops=3)["related"][0]["nodes"]],
                         ["M1", "M2", "M3"])                           # nearest first: M3 is three links away
        tools = {tool.name: tool for tool in self.tools}
        related, paths = tools["find_related"].description, tools["find_paths"].description
        note = next(n for n in kg.describe()["notes"] if n.startswith("find_related and find_paths rank by strength"))
        for said in (" ".join(related.split()), note):
            for phrase in ("splits what it received equally among the nodes it is linked to", "5 neighbours", "0.2",
                           "0.4", "can pass 1"):
                self.assertIn(phrase, said)
        self.assertIn("a direct link has strength 1", " ".join(related.split()))
        self.assertIn("A direct link is 1", note)
        self.assertIn("nearest first and then strongest", " ".join(related.split()))
        self.assertIn("Nearest first, then strongest", note)
        self.assertIn("its worst tie (the farthest starting node, then the weakest)", " ".join(related.split()))
        self.assertIn("strongest first, then longer ones", " ".join(paths.split()))
        self.assertIn("split it equally among the nodes it is linked to", " ".join(paths.split()))
        said, told = " ".join(related.split()), " ".join(paths.split())
        for phrase in ("only what every one of them reaches is returned", "`through`, the strongest route",
                       "then by its next worst, and so on", "`per_start`, its tie to each starting node, in place of",
                       "`link`, holding `also`", "whose order (by name) means nothing", "`count` of them, `listed` on this page",
                       "`within` counts the nodes within max_hops and `beyond` those farther",
                       "`splits`, the neighbours it divided among"):
            self.assertIn(phrase, said)
        for phrase in ("`more` means there are further paths", "`partial` means the search stopped early",
                       "`shortest` is their length and `listed` the number of paths on this page"):
            self.assertIn(phrase, told)
        self.assertIn("how exclusive the nodes in between look", note)
        cells = " ".join(tools["sparql_query"].description.split())          # how a cell is written, as the benchmark relies on
        self.assertIn("a number is a number, a truth value true or false, a date or time ISO text and any other "
                      "literal its text (NaN and infinity as NaN, INF, -INF)", cells)
        self.assertIn("a node of this graph is bid:<id>, and any other IRI prefix:name or <iri>", cells)
        for field in ("`through`", "`share`", "`tied`", "`per_start`", "`link`", "`also`", "`routes`"):
            self.assertIn(field, related)
        for field in ("`routes`", "`strength`", "`more`", "`partial`"):
            self.assertIn(field, paths)
        # every field the descriptions name is one a reply carries
        with mock.patch.object(m, "PATH_STEPS", 0):                    # a search that runs out at once
            gave_up = fixture_kg().paths(ADA, P3)
        replies = (kg.related("S", max_hops=3), kg.related(["S", "U"], max_hops=3), kg.paths("S", "U"),
                   kg.related("S", type="Dataset", limit=1, max_hops=3),  # five datasets equally tied: cut
                   fixture_kg().paths(ADA, P2, limit=1), gave_up,          # ADA to P2: two paths, one shown
                   kg.related("S", avoid_edges="staffed_by", max_hops=1),   # a link type left out
                   fixture_kg().related(DEE), fixture_kg().paths(ADA, DEE))  # nothing to give: a note
        sent = {key for reply in replies for key in re.findall(r'"(\w+)":', json.dumps(reply))}
        named = set(re.findall(r"`(\w+)`", related + paths))
        self.assertEqual(named - sent - {"also"}, set())                  # `also`: only between nodes linked twice
        # ...and every field a reply carries is named, but for the plain ones every reply has
        plain = {"id", "type", "label", "links", "start", "related", "nodes", "source", "target", "paths", "edge",
                 "direction", "role", "role_source", "hops", "strength"}
        self.assertEqual(sent - named - plain, set())
        self.assertIn("find_related", tools["get_neighbors"].description)   # the lister points to the ranker
        for tool in ("find_related", "find_paths", "get_neighbors", "get_node"):
            self.assertIn(tool, m.INSTRUCTIONS)
        # the numbers in the argument descriptions are the numbers applied
        schema = tools["find_related"].input_schema["properties"]
        signature = inspect.signature(m.KG.related).parameters
        self.assertEqual((schema["limit"]["default"], schema["max_hops"]["default"], schema["offset"]["default"]),
                         (signature["limit"].default, signature["max_hops"].default, signature["offset"].default))
        self.assertEqual((schema["limit"]["default"], schema["max_hops"]["default"]), (5, 4))
        self.assertIn("1-25 (1-10 when no type, or more than three, are named)", schema["limit"]["description"])
        self.assertIn(f"1-{m.MAX_HOPS}", schema["max_hops"]["description"])
        self.assertIn(f"up to {m.MAX_SEEDS}", schema["nodes"]["description"])
        path_schema = tools["find_paths"].input_schema["properties"]
        path_signature = inspect.signature(m.KG.paths).parameters
        self.assertEqual({name: path_schema[name]["default"] for name in ("max_hops", "limit", "offset")},
                         {name: path_signature[name].default for name in ("max_hops", "limit", "offset")})
        self.assertEqual(tuple(path_schema[name]["default"] for name in ("max_hops", "limit", "offset")), (6, 5, 0))
        self.assertIn("1-25", path_schema["limit"]["description"])
        self.assertIn(f"1-{m.MAX_HOPS}", path_schema["max_hops"]["description"])
        self.assertIn(f"1-{m.MAX_DEPTH}", tools["get_neighbors"].input_schema["properties"]["depth"]["description"])
        # ...and the caps are the ones applied: 25 with up to three types named, 10 with more or none
        big = fixture_kg()
        many = sorted({n.type for n in big.nodes.values() if n.type != "Investigator"})[:4]
        for kinds, cap in ((None, 10), (["Investigator"], 25), (many[:3], 25), (many, 10)):
            with mock.patch.object(m, "_page", wraps=m._page) as paged:
                big.related(ADA, type=kinds, limit=25)
            self.assertEqual(paged.call_args_list[0].args[:2], (25, cap), kinds)

    METHODS = {"describe_graph": "describe", "search_nodes": "search", "get_node": "node", "get_neighbors": "neighbors",
               "find_related": "related", "find_paths": "paths", "sparql_query": "sparql"}

    def test_every_default_a_tool_states_is_the_one_its_method_applies(self):
        for tool in self.tools:
            method = inspect.signature(getattr(m.KG, self.METHODS[tool.name])).parameters
            argued = list(tool.input_schema["properties"].items())
            taken = [p for name, p in method.items() if name != "self"][:len(argued)]
            self.assertEqual(len(taken), len(argued), tool.name)
            for (name, schema), parameter in zip(argued, taken):     # passed on in this order
                if "default" in schema and parameter.default is not inspect.Parameter.empty:
                    self.assertEqual(schema["default"], parameter.default, (tool.name, name))

    def test_every_argument_reaches_the_graph(self):
        # Each tool called with its arguments set away from their defaults, against the method it calls,
        # on the very graph the server holds. Each argument set is also shown to matter: resetting it
        # alone changes the answer. Between them the calls set every argument of every tool. (Naming
        # `edge` already walks through hubs, so get_neighbors needs two calls; find_paths two as well,
        # because max_hops only shows on a page that reaches past the shortest paths.)
        source = m.GraphSource(str(EXPORT), 0)
        server, kg = m.build_server(source), source.current()
        calls = [
            ("search_nodes", kg.search, {"query": "behavior", "type": ["Investigator", "Publication"], "where": None,
                                         "limit": 2, "offset": 1}),
            ("search_nodes", kg.search, {"query": "", "type": None, "where": {"mechanism": "R34"}, "limit": 2, "offset": 1}),
            ("get_node", kg.node, {"node": "WG-Analytics", "edge_limit": 3}),
            ("get_neighbors", kg.neighbors, {"node": "R34DA059723", "edge": ["has_role", "studies_species"], "direction": "out",
                                             "type": None, "depth": 1, "limit": 50, "offset": 0, "through_hubs": False}),
            ("get_neighbors", kg.neighbors, {"node": "00618660", "edge": None, "direction": "both", "type": "Investigator",
                                             "depth": 2, "limit": 2, "offset": 1, "through_hubs": True}),
            ("find_related", kg.related, {"nodes": "House Mouse", "type": "Investigator", "limit": 2, "offset": 1,
                                          "avoid_edges": "member_of_group", "max_hops": 3}),
            ("find_paths", kg.paths, {"source_node": "R34DA059723", "target_node": "WG-Analytics", "max_hops": 3, "limit": 5,
                                      "avoid_edges": "members", "offset": 0}),
            ("find_paths", kg.paths, {"source_node": "R34DA059723", "target_node": "WG-Analytics", "max_hops": 6, "limit": 2,
                                      "avoid_edges": None, "offset": 1}),
            ("sparql_query", kg.sparql, {"query": "SELECT ?s WHERE { ?s a bbqs:Investigator } ORDER BY ?s", "limit": 2}),
            ("describe_graph", kg.describe, {"type": "Investigator"}),
        ]
        defaults = {tool.name: {name: p.get("default") for name, p in tool.input_schema["properties"].items()}
                    for tool in self.tools}
        named = ("node", "nodes", "query", "source_node", "target_node")

        def plain(reply):
            return json.loads(json.dumps({k: v for k, v in reply.items() if k != "snapshot"}, default=str))

        exercised = set()
        for tool, method, arguments in calls:
            self.assertEqual(list(arguments), list(defaults[tool]), tool)        # every argument, in the tool's order
            result = asyncio.run(server.call_tool(tool, arguments))
            text = "".join(block.text for block in result.content)
            self.assertFalse(result.is_error, (tool, text))
            answer = plain(method(*arguments.values()))
            self.assertEqual(plain(json.loads(text)), answer, tool)
            for name, value in arguments.items():
                if name in named or value == defaults[tool][name]:
                    continue
                try:
                    without = plain(method(*{**arguments, name: defaults[tool][name]}.values()))
                except m.KGError:
                    without = "refused"                            # without it the question cannot be asked
                self.assertNotEqual(without, answer, (tool, name))
                exercised.add((tool, name))
        self.assertEqual({(tool, name) for tool, values in defaults.items() for name in values if name not in named}
                         - exercised, set())

    def test_every_tool_is_declared_read_only(self):
        self.assertEqual(sorted(t.name for t in self.tools),
                         ["describe_graph", "find_paths", "find_related", "get_neighbors", "get_node", "search_nodes",
                          "sparql_query"])
        for tool in self.tools:
            self.assertTrue(tool.annotations.read_only_hint, tool.name)
            self.assertFalse(tool.annotations.destructive_hint, tool.name)
            self.assertFalse(tool.annotations.open_world_hint, tool.name)
            self.assertGreater(len(tool.description), 60, tool.name)
        bare = m.build_server(m.GraphSource(str(EXPORT)), sparql=False)
        offered = asyncio.run(bare.list_tools())
        self.assertNotIn("sparql_query", [t.name for t in offered])
        # ...and nothing a client reads sends it there
        told = [bare.instructions, *(t.description for t in offered),
                *m.GraphSource(str(EXPORT)).current().describe(sparql=False)["notes"]]
        self.assertEqual([text[:80] for text in told if re.search(r"sparql", text, re.I)], [])
        self.assertIn("search_nodes gives the total", bare.instructions)
        self.assertEqual(self.server.instructions, m.INSTRUCTIONS)
        self.assertIn("writing SPARQL", next(t.description for t in self.tools if t.name == "describe_graph"))

    def test_the_pins_agree_everywhere_they_are_written(self):
        header = re.search(r"^# dependencies = (\[.*\])$", SERVER.read_text(encoding="utf8"), re.M)
        inline = set(json.loads(header.group(1)))
        pins = lambda name: {line.strip() for line in (HERE / name).read_text(encoding="utf8").splitlines()  # noqa: E731
                             if re.match(r"^[A-Za-z0-9_.-]+==", line.strip())}
        self.assertEqual(inline, pins("requirements-mcp.txt"))
        self.assertEqual({p for p in inline if p.startswith("rdflib==")},
                         {p for p in pins("requirements.txt") if p.startswith("rdflib==")})
        self.assertEqual({p.split("==")[0] for p in inline}, {"mcp", "rdflib"})
        header = re.search(r"^# dependencies = (\[.*\])$", (HERE / "bench_mcp_server.py").read_text(encoding="utf8"), re.M)
        self.assertEqual(set(json.loads(header.group(1))),             # the benchmark: the server's two, and the YAML reader
                         inline | {p for p in pins("requirements.txt") if p.startswith("PyYAML==")})


# ---- the protocol, as a client sees it ------------------------------------------------------------

def _request(number: int, method: str, params: dict | None = None) -> dict:
    return {"jsonrpc": "2.0", "id": number, "method": method, "params": params or {}}


INITIALIZE = {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "kg-tests", "version": "0"}}


class Stdio:
    """A raw JSON-RPC client on the server's stdin/stdout: no SDK on this side, so what passes
    here is what any MCP client would see."""

    def __init__(self, *args: str):
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen([sys.executable, str(SERVER), *args], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True, encoding="utf-8")
        self.lines: queue.Queue = queue.Queue()
        threading.Thread(target=lambda: [self.lines.put(line) for line in self.process.stdout], daemon=True).start()
        self.number = 0

    def send(self, message: dict):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def ask(self, method: str, params: dict | None = None) -> dict:
        self.number += 1
        self.send(_request(self.number, method, params))
        while True:
            try:
                reply = json.loads(self.lines.get(timeout=60))
            except queue.Empty:
                self.log.seek(0)
                said = self.log.read().decode(errors="replace")[-2000:]
                raise AssertionError(f"no reply to {method}; server said: {said}")
            if reply.get("id") == self.number:
                return reply

    def call(self, tool: str, **arguments):
        result = self.ask("tools/call", {"name": tool, "arguments": arguments})["result"]
        text = "".join(block["text"] for block in result["content"] if block["type"] == "text")
        return bool(result.get("isError")), text

    def close(self) -> str:
        self.process.stdin.close()
        self.process.wait(timeout=20)
        self.process.stdout.close()
        self.log.seek(0)
        said = self.log.read().decode(errors="replace")
        self.log.close()
        return said


class OverStdio(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.fixture = Path(cls.dir.name) / "graph.ttl"
        cls.fixture.write_text(FIXTURE, encoding="utf8")
        cls.client = Stdio("--source", str(cls.fixture))
        cls.hello = cls.client.ask("initialize", INITIALIZE)["result"]
        cls.client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    @classmethod
    def tearDownClass(cls):
        said = cls.client.close()
        cls.dir.cleanup()
        assert cls.client.process.returncode == 0, said[-2000:]
        assert "23 nodes, 23 links" in said, said[-2000:]     # the startup line went to stderr, not the protocol

    def test_it_introduces_itself(self):
        self.assertEqual(self.hello["serverInfo"]["name"], "bbqs-kg")
        self.assertEqual(self.hello["serverInfo"]["version"], m.__version__)
        self.assertIn("describe_graph first", self.hello["instructions"])
        self.assertIn("tools", self.hello["capabilities"])

    def test_it_lists_seven_read_only_tools_with_schemas(self):
        tools = self.client.ask("tools/list")["result"]["tools"]
        self.assertEqual(sorted(t["name"] for t in tools),
                         ["describe_graph", "find_paths", "find_related", "get_neighbors", "get_node", "search_nodes",
                          "sparql_query"])
        for tool in tools:
            self.assertIs(tool["annotations"]["readOnlyHint"], True, tool["name"])
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertNotIn("outputSchema", tool)             # answers are text; nothing is sent twice
        paths = next(t for t in tools if t["name"] == "find_paths")["inputSchema"]
        self.assertEqual(sorted(paths["required"]), ["source_node", "target_node"])
        self.assertIn("description", paths["properties"]["avoid_edges"])
        related = next(t for t in tools if t["name"] == "find_related")["inputSchema"]
        self.assertEqual(related["required"], ["nodes"])
        self.assertEqual(sorted(related["properties"]), ["avoid_edges", "limit", "max_hops", "nodes", "offset", "type"])
        self.assertIn("offset", paths["properties"])

    def test_every_tool_answers_in_compact_json(self):
        failed, text = self.client.call("describe_graph")
        self.assertFalse(failed)
        self.assertNotIn("\n", text)
        self.assertNotIn('": ', text)
        described = json.loads(text)
        self.assertEqual((described["nodes"], described["snapshot"]["source"]), (23, "graph.ttl"))

        _, text = self.client.call("search_nodes", query="mouse", limit=1)
        self.assertEqual(json.loads(text)["results"][0]["id"], MOUSE)
        _, text = self.client.call("get_node", node="R34DA000001")
        self.assertEqual(json.loads(text)["properties"]["mechanism"], "R34")
        _, text = self.client.call("get_neighbors", node="House Mouse", depth=2, type="Investigator")
        self.assertEqual(ids(json.loads(text)["nodes"]), [ADA, BOB])
        _, text = self.client.call("find_paths", source_node="Ada Lovelace", target_node="Fish at scale",
                                   avoid_edges=["member_of_group"])
        self.assertEqual(json.loads(text)["paths"][0]["nodes"], [ADA, P1, BOB, P2, PUB2])
        _, text = self.client.call("find_related", nodes=["Ada Lovelace", "Cyd Charisse"], type="Investigator")
        self.assertIn('"hops":2,"strength":0.6667,"per_start":[{"start":"11111111","hops":2,"strength":0.6667,"routes":2},', text)
        people = json.loads(text)["related"][0]
        self.assertEqual(([(n["id"], n["strength"]) for n in people["nodes"]], people["beyond"]), ([(BOB, 0.6667)], 1))
        _, text = self.client.call("find_related", nodes=["Ada Lovelace", "Cyd Charisse"], type="Investigator", max_hops=5)
        self.assertEqual(ids(json.loads(text)["related"][0]["nodes"]), [BOB, TWIN1])
        _, text = self.client.call("find_related", nodes="Ada Lovelace", type="Project", limit=1)
        self.assertIn('"hops":1,"strength":1,"link":{"edge":"has_role"', text)       # a whole number goes out as one
        _, text = self.client.call("find_related", nodes="House Mouse", type="Investigator", limit=1)
        self.assertEqual(json.loads(text)["related"][0]["tied"],
                         {"hops": 2, "strength": 0.1667, "count": 2, "listed": 1})
        _, text = self.client.call("sparql_query", query="SELECT (COUNT(?p) AS ?n) WHERE { ?p a bbqs:Project }")
        counted = json.loads(text)
        self.assertEqual((counted["columns"], counted["rows"]), (["n"], [[3]]))
        _, text = self.client.call("describe_graph", type="Species")
        self.assertEqual(json.loads(text)["properties"][0], {"property": "common_name", "filled": 2, "values":
                                                             {"House Mouse": 1, "Zebrafish": 1}})
        self.assertIn("Müller", self.client.call("search_nodes", query="muller")[1])     # not \\u-escaped

    def test_every_answer_says_which_graph_it_came_from_and_is_otherwise_untouched(self):
        # What the client receives is what the graph layer answered, plus the stamp: nothing renamed,
        # dropped or overwritten on the way out. (The stamp was once called `source` and replaced
        # find_paths' own `source`, the node the path starts from.)
        kg = fixture_kg()
        calls = [("search_nodes", {"query": "mouse"}, kg.search("mouse")),
                 ("get_node", {"node": ADA}, kg.node(ADA)),
                 ("get_neighbors", {"node": ADA, "depth": 2}, kg.neighbors(ADA, depth=2)),
                 ("find_paths", {"source_node": ADA, "target_node": CYD}, kg.paths(ADA, CYD)),
                 ("find_related", {"nodes": ADA}, kg.related(ADA)),
                 ("find_related", {"nodes": [ADA, CYD], "type": "Project", "avoid_edges": "member_of_group"},
                  kg.related([ADA, CYD], type="Project", avoid_edges="member_of_group")),
                 ("sparql_query", {"query": "SELECT ?s WHERE { ?s a bbqs:Species }"},
                  kg.sparql("SELECT ?s WHERE { ?s a bbqs:Species }")),
                 ("sparql_query", {"query": "ASK { ?s ?p ?o }"}, {"answer": True})]
        for tool, arguments, expected in calls:
            answer = json.loads(self.client.call(tool, **arguments)[1])
            came_from = answer.pop("snapshot")
            self.assertEqual(answer, json.loads(json.dumps(expected)), tool)
            self.assertEqual(came_from["graph"], "graph.ttl", tool)
            self.assertRegex(came_from["dated"], r"^\d{4}-\d\d-\d\d$", tool)
            self.assertEqual(came_from["age_days"], 0, tool)
            self.assertNotIn("preferred_source_failed", came_from, tool)
        described = json.loads(self.client.call("describe_graph")[1])
        self.assertEqual(described["snapshot"]["source"], "graph.ttl")
        described["snapshot"].pop("loaded_at")
        expected = kg.describe()
        expected["snapshot"] = {k: v for k, v in described["snapshot"].items()}
        self.assertEqual(described, json.loads(json.dumps(expected)))
        self.assertEqual(json.loads(self.client.call("describe_graph", type="Project")[1]),
                         json.loads(json.dumps(kg.describe(type="Project"))))

    def test_arguments_arrive_however_the_client_serialised_them(self):
        _, as_string = self.client.call("search_nodes", type="Project", where='{"mechanism": "R61"}')
        _, as_object = self.client.call("search_nodes", type=["Project"], where={"mechanism": "R61"})
        self.assertEqual(ids(json.loads(as_string)["results"]), [P2])
        self.assertEqual(json.loads(as_string), json.loads(as_object))
        _, comma = self.client.call("get_neighbors", node=ADA, edge="has_role, member_of_group")
        self.assertEqual(json.loads(comma)["total"], 2)
        _, as_list = self.client.call("find_related", nodes=[ADA, CYD], type=["Investigator"])
        for shape in (f"{ADA}, {CYD}", json.dumps([ADA, CYD]), f"['{ADA}', '{CYD}']"):
            _, as_text = self.client.call("find_related", nodes=shape, type="Investigator")
            self.assertEqual(json.loads(as_text), json.loads(as_list), shape)
        # the next page is asked for over the wire too, in both tools
        kg = fixture_kg()
        _, paged = self.client.call("find_related", nodes="House Mouse", type="Project", limit=1, offset=1, max_hops=8)
        self.assertEqual(ids(json.loads(paged)["related"][0]["nodes"]), [P3])
        self.assertEqual({k: v for k, v in json.loads(paged).items() if k != "snapshot"},
                         json.loads(json.dumps(kg.related(MOUSE, type="Project", limit=1, offset=1, max_hops=8))))
        _, paged = self.client.call("find_paths", source_node=ADA, target_node=CYD, limit=2, offset=2)
        self.assertEqual([p["nodes"] for p in json.loads(paged)["paths"]], [[ADA, P1, BOB, WGA, CYD], [ADA, P1, BOB, P2, CYD]])

    def test_an_argument_the_tool_does_not_take_is_refused_not_dropped(self):
        for tool in self.client.ask("tools/list")["result"]["tools"]:
            self.assertIs(tool["inputSchema"].get("additionalProperties"), False, tool["name"])
        for tool, arguments in (("find_related", {"nodes": ADA, "max_hop": 1}), ("find_paths", {"source_node": ADA,
                                "target_node": BOB, "depth": 2}), ("get_node", {"node": ADA, "limit": 3})):
            failed, text = self.client.call(tool, **arguments)
            self.assertTrue(failed, tool)
            self.assertIn("Extra inputs are not permitted", text)
            self.assertIn(next(name for name in arguments if name not in ("nodes", "source_node", "target_node", "node")),
                          text)
        failed, _ = self.client.call("find_related", nodes=ADA, max_hops=1)    # spelt right, it answers
        self.assertFalse(failed)

    def test_a_mistake_comes_back_as_an_error_the_model_can_act_on(self):
        failed, text = self.client.call("get_node", node="nobody at all")
        self.assertTrue(failed)
        self.assertIn("No node matches 'nobody at all'", text)
        self.assertIn("search_nodes", text)
        failed, text = self.client.call("sparql_query", query="DELETE WHERE { ?s ?p ?o }")
        self.assertTrue(failed)
        self.assertIn("Only SPARQL SELECT and ASK", text)
        failed, text = self.client.call("get_neighbors", node=ADA, direction="sideways")
        self.assertTrue(failed)
        self.assertIn("direction", text)
        failed, text = self.client.call("find_paths", source_node=ADA)
        self.assertTrue(failed)
        self.assertIn("target_node", text)
        failed, text = self.client.call("find_related", nodes=[ADA, "nobody at all"])
        self.assertTrue(failed)
        self.assertIn("No node matches 'nobody at all'", text)
        failed, text = self.client.call("find_related", nodes="Ada Lovelace, Sam Twin")
        self.assertTrue(failed)
        self.assertIn("Read as 2 nodes. 'Sam Twin' names 2 nodes", text)
        failed, text = self.client.call("find_related", nodes=ADA, max_hops=99)
        self.assertTrue(failed)
        self.assertIn("max_hops must be between 1 and 8", text)
        _, text = self.client.call("describe_graph")
        self.assertEqual(json.loads(text)["links"], 23)        # and it is still serving the same graph

    def test_there_is_nothing_to_call_that_writes(self):
        for name in ("add_node", "update_node", "delete_node", "kg_query", "onboard_member"):
            reply = self.client.ask("tools/call", {"name": name, "arguments": {}})
            refused = "error" in reply or reply["result"].get("isError")
            self.assertTrue(refused, name)


class OverHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        fixture = Path(cls.dir.name) / "graph.ttl"
        fixture.write_text(FIXTURE, encoding="utf8")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            cls.port = probe.getsockname()[1]
        cls.log = tempfile.TemporaryFile()
        cls.process = subprocess.Popen([sys.executable, str(SERVER), "--source", str(fixture), "--http", "--port",
                                        str(cls.port), "--no-sparql"], stdout=cls.log, stderr=cls.log)
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))    # straight to localhost
        deadline = time.monotonic() + 60
        while True:
            try:
                cls.health = json.load(cls.opener.open(f"http://127.0.0.1:{cls.port}/health", timeout=5))
                break
            except (urllib.error.URLError, ConnectionError):
                if cls.process.poll() is not None or time.monotonic() > deadline:
                    cls.log.seek(0)
                    raise AssertionError("HTTP server did not start: " + cls.log.read().decode(errors="replace")[-2000:])
                time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=20)
        cls.log.close()
        cls.dir.cleanup()

    def post(self, message: dict) -> dict:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/mcp", data=json.dumps(message).encode(), method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        with self.opener.open(request, timeout=30) as response:
            self.assertEqual(response.headers.get_content_type(), "application/json")
            return json.load(response)

    def test_health_says_what_is_being_served(self):
        self.assertEqual((self.health["name"], self.health["nodes"], self.health["mcp_endpoint"]),
                         ("bbqs-kg", 23, "/mcp"))
        self.assertEqual(self.health["snapshot"]["source"], "graph.ttl")

    def test_a_client_can_initialize_list_and_call_over_plain_posts(self):
        hello = self.post(_request(1, "initialize", INITIALIZE))["result"]
        self.assertEqual(hello["serverInfo"]["name"], "bbqs-kg")
        tools = self.post(_request(2, "tools/list"))["result"]["tools"]
        self.assertEqual(sorted(t["name"] for t in tools),
                         ["describe_graph", "find_paths", "find_related", "get_neighbors", "get_node",
                          "search_nodes"])                                               # --no-sparql
        reply = self.post(_request(3, "tools/call", {"name": "find_paths", "arguments": {
            "source_node": "House Mouse", "target_node": "Zebrafish"}}))["result"]
        self.assertEqual(json.loads(reply["content"][0]["text"])["paths"][0]["nodes"], [MOUSE, P1, BOB, P2, ZEBRA])
        reply = self.post(_request(4, "tools/call", {"name": "find_related", "arguments": {
            "nodes": "House Mouse", "type": "Species"}}))["result"]
        self.assertEqual([(n["id"], n["hops"]) for n in json.loads(reply["content"][0]["text"])["related"][0]["nodes"]],
                         [(ZEBRA, 4)])
        refused = self.post(_request(5, "tools/call", {"name": "sparql_query", "arguments": {"query": "ASK {}"}}))
        self.assertTrue("error" in refused or refused["result"].get("isError"))


# A whole graph in miniature in which EVERY competency question has an answer, the three the public
# export cannot answer included (a job with its institution, a provenance record, a device category
# on a project), so that each question's walk through the graph tools is checked against rows.
PREFIXES = """
@prefix bbqs: <https://brain-bbqs.org/schema#> .
@prefix bid: <https://brain-bbqs.org/id/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
"""

# A consortium in miniature, complete enough that every one of the 42 questions has rows.
MINIATURE = PREFIXES + """
bid:p1 a bbqs:Project ; bbqs:name "R34DA059723" ; bbqs:grant_number "R34DA059723" ; bbqs:mechanism "R34" ;
    bbqs:award_amount 100 ; bbqs:title "Mouse project" ; bbqs:studies_species bid:mouse ; bbqs:part_of_org bid:org1 ;
    bbqs:produced bid:pub1, bid:ds2, bid:tool1, bid:model1 ; bbqs:funded_datasets bid:ds1 ;
    bbqs:uses_device_category bid:cat1 .
bid:p2 a bbqs:Project ; bbqs:name "U01DA000002" ; bbqs:grant_number "U01DA000002" ; bbqs:mechanism "U01" ;
    bbqs:award_amount 250 ; bbqs:study_scope "All Species" ; bbqs:studies_species_name "zebra finch" ;
    bbqs:funded_datasets bid:ds3 .
bid:p3 a bbqs:Project ; bbqs:name "R34DA000003" ; bbqs:grant_number "R34DA000003" ; bbqs:mechanism "R34" ;
    bbqs:award_amount 50 ; bbqs:studies_species bid:rat ; bbqs:produced bid:ds4 .
bid:r1 a bbqs:ProjectRole ; bbqs:held_by bid:ann ; bbqs:on_project bid:p1 ; bbqs:project_role "contact_pi" .
bid:r2 a bbqs:ProjectRole ; bbqs:held_by bid:bo ; bbqs:on_project bid:p1 ; bbqs:project_role "co_pi" .
bid:r3 a bbqs:ProjectRole ; bbqs:held_by bid:ann ; bbqs:on_project bid:p3 ; bbqs:project_role "co_pi" .
bid:ann a bbqs:Investigator ; bbqs:name "Ann A" ; bbqs:orcid <https://orcid.org/0000-0001-0000-0001> ;
    bbqs:member_of_group bid:wgd .
bid:bo a bbqs:Investigator ; bbqs:name "Bo B" ; bbqs:member_of_group bid:wgd .
bid:cy a bbqs:Investigator ; bbqs:name "Cy C" ; bbqs:member_of_group bid:wga .
bid:org1 a bbqs:ResearchOrganization ; bbqs:name "TEST UNIVERSITY" ; bbqs:members bid:ann, bid:bo .
bid:org2 a bbqs:ResearchOrganization ; bbqs:name "EMPTY INSTITUTE" .
bid:wgd a bbqs:WorkingGroup ; bbqs:name "WG-Devices" .
bid:wga a bbqs:WorkingGroup ; bbqs:name "WG-Analysis" .
bid:mouse a bbqs:Species ; bbqs:name "Mus musculus" ; bbqs:common_name "House Mouse" ; bbqs:taxonomy_class "Mammalia" .
bid:rat a bbqs:Species ; bbqs:name "Rattus norvegicus" ; bbqs:common_name "Brown Rat" ; bbqs:taxonomy_class "Mammalia" .
bid:pub1 a bbqs:Publication ; bbqs:name "Paper 2025" ; bbqs:title "A paper" .
bid:ds1 a bbqs:Dataset ; bbqs:name "Dataset one" .
bid:ds2 a bbqs:Dataset ; bbqs:name "Dataset two" .
bid:ds3 a bbqs:Dataset ; bbqs:name "Dataset three" .
bid:ds4 a bbqs:Dataset ; bbqs:name "Dataset four" .
bid:cat1 a bbqs:DeviceCategory ; bbqs:name "Microscopes" ; bbqs:label "Microscopes" .
bid:dev1 a bbqs:Device ; bbqs:name "Scope One" ; bbqs:model_name "Scope One" ; bbqs:manufacturer bid:man1 ;
    bbqs:device_category bid:cat1 .
bid:dev2 a bbqs:Device ; bbqs:name "Scope Two" ; bbqs:model_name "Scope Two" ; bbqs:manufacturer bid:man1 .
bid:man1 a bbqs:DeviceManufacturer ; bbqs:name "Lens Co" .
bid:tool1 a bbqs:SoftwareTool ; bbqs:name "Tracker" ; bbqs:repo_url "https://github.com/example/tracker"^^xsd:anyURI .
bid:model1 a bbqs:MLModel ; bbqs:name "Pose net" ; bbqs:evaluated_by bid:bench1 .
bid:bench1 a bbqs:Benchmark ; bbqs:name "Pose bench" ; bbqs:evaluates bid:model1 .
bid:fo1 a bbqs:FundingOpportunity ; bbqs:name "Open call" ; bbqs:expiration_date "2027-01-15"^^xsd:date .
bid:fo2 a bbqs:FundingOpportunity ; bbqs:name "Closed call" ; bbqs:expiration_date "2026-01-15"^^xsd:date .
bid:job1 a bbqs:Job ; bbqs:name "Postdoc" ; bbqs:job_institution "TEST UNIVERSITY" ; bbqs:job_type "postdoc" ;
    bbqs:posted_by bid:ann .
bid:job2 a bbqs:Job ; bbqs:name "Technician" ; bbqs:job_institution "TEST UNIVERSITY" ; bbqs:job_type "staff" ;
    bbqs:posted_by bid:bo .
bid:src1 a bbqs:SourceClass ; bbqs:name "RePORTER" ; bbqs:grade 2 .
bid:src2 a bbqs:SourceClass ; bbqs:name "Self-report" ; bbqs:grade 4 .
bid:prov1 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "p1" ; bbqs:prov_entity_table "grants" ;
    bbqs:prov_entity_column "title" ; bbqs:prov_value_text "Mouse project" ; bbqs:prov_source_class bid:src1 .
bid:prov2 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "p1" ; bbqs:prov_entity_column "mechanism" ;
    bbqs:prov_value_text "R34" ; bbqs:prov_source_class bid:src1 .
bid:prov3 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "ds4" ; bbqs:prov_entity_table "datasets" ;
    bbqs:prov_entity_column "name" ; bbqs:prov_value_text "Dataset four" ; bbqs:prov_source_class bid:src2 .
"""
# How many rows each question has on it, worked out by hand from the graph above. For instance CQ23
# (who is in each group, and on which projects): Ann on two projects and Bo on one in WG-Devices,
# and Cy, on none, in WG-Analysis: 4. CQ31 (benchmarks per model): the one tie is recorded from both
# ends, so 2. CQ40 (values from a source graded below 3): two records from the grade-2 source, with
# and without a table; the third record's source is graded 4: 2.
MINIATURE_ROWS = {"CQ01": 3, "CQ02": 2, "CQ03": 1, "CQ04": 2, "CQ05": 1, "CQ06": 2, "CQ07": 1, "CQ08": 2, "CQ09": 1,
                  "CQ10": 2, "CQ11": 1, "CQ12": 1, "CQ13": 4, "CQ14": 1, "CQ15": 2, "CQ16": 1, "CQ17": 1, "CQ18": 2,
                  "CQ19": 1, "CQ20": 1, "CQ21": 2, "CQ22": 2, "CQ23": 4, "CQ24": 1, "CQ25": 2, "CQ26": 2, "CQ27": 1,
                  "CQ28": 3, "CQ29": 2, "CQ30": 1, "CQ31": 2, "CQ32": 2, "CQ33": 1, "CQ34": 1, "CQ35": 1, "CQ36": 2,
                  "CQ37": 2, "CQ38": 1, "CQ39": 1, "CQ40": 2, "CQ41": 3, "CQ42": 1}

# Shapes an export could take and today's does not, each of which once gave a walk the wrong rows
# (found by asking all the questions of several hundred random graphs):
#   - ids that links point at and nothing describes: gone1, gone3, gone4, gone5, nobody2, nocat (one
#     node points at each, so it is only a value) and gone2, nobody1, nosource (several do, so the
#     server also makes a node of it, and it must not be counted twice)
#   - a provenance record that names no source (v5), so says nothing of where d2 came from
#   - the same two nodes linked twice: a dataset q1 both funded and produced; Ann on q1 in two roles
#   - a property given twice (Ann's name, q2's grant number, a job's title, a source's grade), or
#     not at all (Cy's name, Bo's role, q3's grant number: it only carries q1's as its name)
#   - two things answering to one name: two species called "House Mouse" (and one "house mouse",
#     which is not the same text), two groups called WG-Devices, two species called "Mus spretus"
#     that one project studies, two jobs called Technician at one institution
#   - a project that carries R34DA059723 only as its name (q3), with a person on it; so Bo is on
#     two projects of which one has no grant number
#   - award amounts with cents: SPARQL adds them as decimals (300.30) and a walk as floats
#     (300.29999999999995), so they agree only to 12 significant digits
#   - two links between a project and its organization, the one asked for sorting second (q1)
#   - one person on two projects that share a grant number (Ann on q2 and q6), a person on a
#     project with a paper and no grant number (Bo on q3), and a role written in capitals (MPI)
#   - an ORCID iD that is itself described (so a node, not a value), and a device category whose
#     address is not one of this graph's ids (bbqs:Microscope)
#   - a repository and an institution that are nodes of the graph, not text (tool9, j5)
#   - dates on the first and last day of CQ39's window, on the day either side, and on CQ17's day
AWKWARD = PREFIXES + """
bid:q1 a bbqs:Project ; bbqs:grant_number "R34DA059723" ; bbqs:title "First" ; bbqs:mechanism "R34" ;
    bbqs:award_amount 100.10 ; bbqs:hosted_at bid:o1 ; bbqs:part_of_org bid:o1 ;
    bbqs:funded_datasets bid:d1, bid:gone1, bid:gone2 ; bbqs:produced bid:d1 ; bbqs:studies_species bid:m1, bid:m2 .
bid:q2 a bbqs:Project ; bbqs:grant_number "U01DA000002", "U01DA000002-S1" ; bbqs:funded_datasets bid:gone2 ;
    bbqs:mechanism "R34" ;
    bbqs:produced bid:gone3 ; bbqs:studies_species bid:gone4 ; bbqs:studies_species_name "marmoset" .
bid:q3 a bbqs:Project ; bbqs:name "R34DA059723" ; bbqs:produced bid:net, bid:d2, bid:pub9 .
bid:q6 a bbqs:Project ; bbqs:grant_number "U01DA000002" .
bid:pub9 a bbqs:Publication ; bbqs:name "Q3 paper" .
bid:q4 a bbqs:Project ; bbqs:grant_number "R61DA000005" ; bbqs:studies_species bid:m3, bid:m4 ;
    bbqs:mechanism "R34" ; bbqs:award_amount 200.20 .
bid:d1 a bbqs:Dataset ; bbqs:name "D one" .
bid:d2 a bbqs:Dataset ; bbqs:name "D two" .
bid:m1 a bbqs:Species ; bbqs:name "Mus musculus" ; bbqs:common_name "House Mouse" ; bbqs:aliases "Mus musculus", "mouse" .
bid:m2 a bbqs:Species ; bbqs:name "Mus musculus domesticus" ; bbqs:common_name "House Mouse" .
bid:m3 a bbqs:Species ; bbqs:name "Mus spretus" ; bbqs:common_name "house mouse" .
bid:m4 a bbqs:Species ; bbqs:name "Mus spretus" .
bid:ann a bbqs:Investigator ; bbqs:name "Ann A", "A. Ann" ; bbqs:member_of_group bid:w1 .
bid:bo a bbqs:Investigator ; bbqs:name "Bo B" ; bbqs:member_of_group bid:w2 ;
    bbqs:orcid <https://orcid.org/0000-0002-0000-0002> .
<https://orcid.org/0000-0002-0000-0002> bbqs:name "Bo's iD" .
bid:cy a bbqs:Investigator ; bbqs:member_of_group bid:w1 .
bid:s1 a bbqs:ProjectRole ; bbqs:held_by bid:ann ; bbqs:on_project bid:q1 ; bbqs:project_role "contact_pi" .
bid:s2 a bbqs:ProjectRole ; bbqs:held_by bid:ann ; bbqs:on_project bid:q1 ; bbqs:project_role "key_personnel" .
bid:s3 a bbqs:ProjectRole ; bbqs:held_by bid:bo ; bbqs:on_project bid:q1 .
bid:s4 a bbqs:ProjectRole ; bbqs:held_by bid:ann ; bbqs:on_project bid:q2 ; bbqs:project_role "co_pi" .
bid:s5 a bbqs:ProjectRole ; bbqs:held_by bid:bo ; bbqs:on_project bid:q3 ; bbqs:project_role "co_pi" .
bid:s6 a bbqs:ProjectRole ; bbqs:held_by bid:ann ; bbqs:on_project bid:q6 ; bbqs:project_role "co_pi" .
bid:s7 a bbqs:ProjectRole ; bbqs:held_by bid:bo ; bbqs:on_project bid:q2 ; bbqs:project_role "MPI" .
bid:di a bbqs:Investigator ; bbqs:name "Di D" .
bid:s8 a bbqs:ProjectRole ; bbqs:held_by bid:di ; bbqs:on_project bid:q3 ; bbqs:project_role "co_pi" .
bid:s9 a bbqs:ProjectRole ; bbqs:held_by bid:di ; bbqs:on_project bid:q4 ; bbqs:project_role "co_pi" .
bid:o1 a bbqs:ResearchOrganization ; bbqs:name "ONE" ; bbqs:members bid:ann, bid:nobody1 .
bid:o2 a bbqs:ResearchOrganization ; bbqs:name "TWO" ; bbqs:members bid:nobody1 .
bid:o3 a bbqs:ResearchOrganization ; bbqs:name "THREE" .
bid:o4 a bbqs:ResearchOrganization ; bbqs:name "FOUR" ; bbqs:members bid:gone5 .
bid:w1 a bbqs:WorkingGroup ; bbqs:name "WG-Devices" .
bid:w2 a bbqs:WorkingGroup ; bbqs:name "WG-Devices" .
bid:w3 a bbqs:WorkingGroup ; bbqs:name "WG-Empty" .
bid:dev a bbqs:Device ; bbqs:model_name "Scope" ; bbqs:manufacturer bid:man ; bbqs:device_category bid:nocat .
bid:dev2 a bbqs:Device ; bbqs:model_name "Scope 2" ; bbqs:manufacturer bid:man ; bbqs:device_category bbqs:Microscope .
bbqs:Microscope a bbqs:DeviceCategory ; bbqs:label "Microscopes" .
bid:man a bbqs:DeviceManufacturer ; bbqs:name "Lens Co" .
bid:net a bbqs:MLModel ; bbqs:name "Pose net" ; bbqs:evaluated_by bid:bench .
bid:bench a bbqs:Benchmark ; bbqs:name "Pose bench" ; bbqs:evaluates bid:net .
bid:j1 a bbqs:Job ; bbqs:name "Postdoc", "Postdoctoral fellow" ; bbqs:job_institution "ONE" ; bbqs:job_type "postdoc" ;
    bbqs:posted_by "Lab manager" .
bid:j2 a bbqs:Job ; bbqs:name "Technician" ; bbqs:job_institution "ONE" ; bbqs:job_type "staff" ;
    bbqs:posted_by bid:nobody2 .
bid:j3 a bbqs:Job ; bbqs:name "Engineer" ; bbqs:job_type "staff" ; bbqs:posted_by bid:nobody1 .
bid:j4 a bbqs:Job ; bbqs:name "Technician" ; bbqs:job_institution "ONE" .
bid:j5 a bbqs:Job ; bbqs:name "Analyst" ; bbqs:job_institution bid:o1 .
bid:tool9 a bbqs:SoftwareTool ; bbqs:name "Kit" ; bbqs:repo_url bid:o3 .
bid:f1 a bbqs:FundingOpportunity ; bbqs:name "First day" ; bbqs:expiration_date "2026-10-14"^^xsd:date .
bid:f2 a bbqs:FundingOpportunity ; bbqs:name "Last day" ; bbqs:expiration_date "2027-04-14"^^xsd:date .
bid:f3 a bbqs:FundingOpportunity ; bbqs:name "Day before" ; bbqs:expiration_date "2026-10-13"^^xsd:date .
bid:f4 a bbqs:FundingOpportunity ; bbqs:name "Day after" ; bbqs:expiration_date "2027-04-15"^^xsd:date .
bid:f5 a bbqs:FundingOpportunity ; bbqs:name "CQ17's day" ; bbqs:expiration_date "2026-09-29"^^xsd:date .
bid:c1 a bbqs:SourceClass ; bbqs:grade 3 .
bid:c2 a bbqs:SourceClass ; bbqs:grade 1, 2 .
bid:v1 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "q1" ; bbqs:prov_entity_column "title" ;
    bbqs:prov_value_text "First", "The first" ; bbqs:prov_source_class bid:nosource .
bid:v2 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "q1" ; bbqs:prov_entity_column "title" ;
    bbqs:prov_value_text "1st" ; bbqs:prov_source_class bid:nosource, bid:c2 .
bid:v3 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "d1" ; bbqs:prov_entity_table "datasets" ;
    bbqs:prov_source_class bid:c1 .
bid:v4 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "q3" ; bbqs:prov_entity_column "title" ;
    bbqs:prov_value_text "Not it" ; bbqs:prov_source_class bid:c2 .
bid:v5 a bbqs:ProvenanceRecord ; bbqs:prov_entity_id "d2" ; bbqs:prov_entity_column "name" ; bbqs:prov_value_text "D two" .
"""
# Rows per question, by hand; a question not named has none. Some of the working:
#   CQ04   q1 alone has the grant number (q3 only has it as a name, so Bo's role there does not
#          count). Ann's two records on q1, each under her two names; Bo's record has no role: 4.
#   CQ03   q1 is part of ONE (and also hosted at it): 1.
#   CQ05   Ann on q1, q2 and q6, under two names; Bo on q1, q2 and q3; Di on q3 and q4: 4.
#          (Di is on one numbered project only, so not in CQ20.)
#   CQ11   q6 names no species: 1 (q3 has no grant number).
#   CQ13   the dataset q1 both funded and produced: 2.
#   CQ16   Kit, whose repository is a node: 1.
#   CQ18   one job under two titles, two called Technician, and one at the node ONE rather than the
#          text "ONE": 5. CQ35 then groups the text and the node apart: 2.
#   CQ02   q1 and q4 are R34 with an amount (q2 has none): 100.10 + 200.20 = 300.3.
#   CQ07   Bo's iD, a node of its own: 1. CQ21 then has Ann, under her two names, and Di: 3.
#   CQ15   the scope whose category nothing describes, and Scope 2, filed under bbqs:Microscope: 2.
#   CQ19   v1 gives two values from a source nothing describes: 2. v2 gives one value from that
#          source and from one graded twice: 3. v4 is about q3: 0. So 5.
#   CQ20   Ann (two names) and Bo are each on several numbered projects; Ann's q2 and q6 share a
#          number, which is named once: 3.
#   CQ22   Ann's organization, under two names, and Bo's, through q1: 3.
#   CQ23   Ann's records give 5 grant numbers (q1 twice, q2's two, q6's), under two names; Bo's give
#          3 (q1, and q2's two; q3 has none): 13.
#   CQ24   Ann holds three kinds of role, Bo two (co_pi and MPI): 3.
#   CQ25   m1 fits by its name, its common name and an alias, m2 by its common name: q1, 4 times.
#   CQ26   three names; "Mus spretus" is two species, both studied by q4, which is one project: 3.
#   CQ35   ONE advertises four titles (j1 under two, and the two Technicians): 1 row, counting 4.
#   CQ30   d1 has a sourced record; d2's record names no source: 1.
#   CQ32   ONE has Ann and somebody not exported, TWO that somebody, THREE nobody, FOUR somebody
#          else not exported: 4 rows.
#   CQ37   one job under two titles, posted by a name; one by an id nothing describes; one by an id
#          the server made a node of: 4.
#   CQ38   q2's one output was not exported, but it has one; q3 has no grant number; q4 and q6: 2.
#   CQ41   q1: three datasets, two of them not exported, each with Ann (contact_pi) under two names:
#          6. q2: one dataset, under two grant numbers, with Ann (co_pi) under two names and Bo (MPI): 6.
#          So 12.
AWKWARD_ROWS = {"CQ01": 5, "CQ02": 1, "CQ03": 1, "CQ04": 4, "CQ05": 4, "CQ06": 2, "CQ07": 1, "CQ08": 3, "CQ09": 2, "CQ11": 1, "CQ13": 2,
                "CQ15": 2, "CQ16": 1, "CQ17": 4,
                "CQ18": 5, "CQ19": 5, "CQ20": 3, "CQ21": 3, "CQ22": 3, "CQ23": 13, "CQ24": 3, "CQ25": 4, "CQ26": 3,
                "CQ28": 4, "CQ30": 1, "CQ31": 2, "CQ32": 4, "CQ33": 1, "CQ34": 1, "CQ35": 2, "CQ36": 2, "CQ37": 4, "CQ38": 2,
                "CQ39": 2, "CQ40": 2, "CQ41": 12, "CQ42": 1}


class TheBenchmark(unittest.TestCase):
    """bench_mcp_server.py: the competency questions, asked over MCP as SPARQL and without it."""

    def graph(self, turtle: str) -> str:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "graph.ttl"
        path.write_text(turtle, encoding="utf8")
        return str(path)

    def client(self, source: str) -> bench.Client:
        client = bench.Client(source)
        self.addCleanup(client.close)
        return client

    def ask(self, source: str) -> dict:
        return bench.ask_questions(self.client(source), m.GraphSource(source, 0).current(), source, fresh=False)

    @staticmethod
    def differing(asked: dict) -> list:
        return [(q["id"], q["sparql_agrees"], q["tools_agree"]) for q in asked["questions"]
                if not (q["sparql_agrees"] and q["tools_agree"])]

    def test_the_questions_are_the_19_adopted_and_the_23_proposed(self):
        questions, prologue = bench.load_questions()
        self.assertEqual([q["id"] for q in questions], [f"CQ{n:02d}" for n in range(1, 43)])
        self.assertEqual([q["set"] for q in questions], ["adopted"] * 19 + ["proposed"] * 23)
        self.assertEqual(set(bench.WALKS), {q["id"] for q in questions})      # no question without a walk, nor a walk without one
        self.assertEqual({q["access"] for q in questions}, {"anon", "full"})
        for q in questions:                                                    # each parses, with the prefixes the files give
            Graph().query(prologue + q["sparql"])
        # the adopted file is the one quality.py scores, and adding the second did not touch it
        self.assertEqual([path.name for path in bench.QUESTION_FILES.values()],
                         ["competency_questions.yaml", "competency_questions_extended.yaml"])
        self.assertIn('DEFAULT_CQS = HERE / "competency_questions.yaml"', (HERE / "quality.py").read_text(encoding="utf8"))

    def test_every_question_gets_the_same_rows_three_ways_on_the_export(self):
        asked = self.ask(str(EXPORT))
        self.assertEqual(self.differing(asked), [])        # as SPARQL, and through the graph tools, as the file itself
        self.assertEqual((asked["asked"], asked["adopted"]), (42, 19))
        baseline = json.loads((HERE / "quality_baseline.json").read_text(encoding="utf8"))
        adopted = [q for q in asked["questions"] if q["set"] == "adopted"]
        self.assertEqual(sorted(q["id"] for q in adopted if q["rows"]), sorted(baseline["answered"]))   # as the KG gate counts
        self.assertEqual(asked["answered_adopted"], len(baseline["answered"]))
        silent = asked["asked"] - asked["answered"]
        self.assertEqual((asked["sparql_agree"], asked["tools_agree"], asked["silent_agree"], asked["all_agree"]),
                         (asked["answered"], asked["answered"], silent, True))
        # every question has one status, and the counts add up
        self.assertEqual(asked["need_the_full_export"] + asked["none_in_this_export"] + asked["not_modelled"]
                         + asked["could_not_be_asked"], silent)
        full = {q["id"] for q in bench.load_questions()[0] if q["access"] == "full"}
        self.assertLessEqual({q["id"] for q in asked["questions"] if q["status"] == "needs the full export"}, full)
        self.assertEqual(next(q["status"] for q in asked["questions"] if q["id"] == "CQ14"), "not modelled")

    def test_the_readme_says_which_questions_have_no_rows_on_the_committed_export(self):
        # kg/README.md ("Benchmark") names the questions with no rows today and why. When a new export
        # changes which, this fails: say so there, and rerun `bench_mcp_server.py --update README.md`.
        asked = self.ask(str(EXPORT))
        status: dict = {}
        for q in asked["questions"]:
            status.setdefault(q["status"], []).append(q["id"])
        self.assertEqual(status, {
            "answered": [f"CQ{n:02d}" for n in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 20, 21, 22, 23, 25, 26,
                                                28, 29, 32, 33, 34, 38, 41)],
            "needs the full export": ["CQ18", "CQ19", "CQ30", "CQ35", "CQ36", "CQ37", "CQ40"],
            "not modelled": ["CQ14"],
            "none in this export": ["CQ24", "CQ27", "CQ31", "CQ39", "CQ42"]})
        readme = (HERE / "README.md").read_text(encoding="utf8")
        for name in status["needs the full export"] + status["none in this export"] + status["not modelled"]:
            self.assertIn(name, readme)
        self.assertGreater(asked["answered"] - asked["answered_adopted"], 10)  # the proposed ones are not all silent here

    def test_every_question_can_be_walked_when_it_has_an_answer(self):
        # On the public export 13 of the questions return nothing either way, which checks nothing.
        # Here all 42 have rows, so every walk through the graph tools is held against real ones.
        asked = self.ask(self.graph(MINIATURE))
        self.assertEqual({q["id"]: q["rows"] for q in asked["questions"]}, MINIATURE_ROWS)
        self.assertNotIn(0, MINIATURE_ROWS.values())
        self.assertEqual(self.differing(asked), [])
        status = {q["id"]: q["status"] for q in asked["questions"]}
        self.assertEqual(set(status.values()), {"answered"})   # CQ14 too: it uses a link the schema lacks, and has rows
        self.assertEqual((asked["answered"], asked["answered_adopted"], asked["silent_agree"]), (42, 19, 0))
        # CQ14 has rows here, so it is not among the questions with none, whatever its status
        self.assertEqual((asked["not_modelled"], asked["need_the_full_export"], asked["none_in_this_export"]), (0, 0, 0))

    def test_shapes_an_export_could_take_and_todays_does_not(self):
        asked = self.ask(self.graph(AWKWARD))
        self.assertEqual({q["id"]: q["rows"] for q in asked["questions"] if q["rows"]}, AWKWARD_ROWS)
        self.assertEqual(self.differing(asked), [])
        # the rows themselves, for the walks that have to tell a node from a value
        client = self.client(self.graph(AWKWARD))
        self.assertEqual(sorted(bench.WALKS["CQ37"][0](client)),
                         [["Engineer", "bid:nobody1"], ["Postdoc", "Lab manager"], ["Postdoctoral fellow", "Lab manager"],
                          ["Technician", "https://brain-bbqs.org/id/nobody2"]])
        self.assertEqual(sorted(bench.WALKS["CQ15"][0](client)), [["Lens Co", "Scope", "https://brain-bbqs.org/id/nocat"],
                                                                  ["Lens Co", "Scope 2", "bbqs:Microscope"]])
        self.assertEqual(bench.WALKS["CQ07"][0](client), [["Bo B", "<https://orcid.org/0000-0002-0000-0002>"]])
        [[mechanism, projects, total]] = bench.WALKS["CQ02"][0](client)
        self.assertEqual((mechanism, projects, total), ("R34", 2, 100.1 + 200.2))         # 300.29999999999995
        self.assertEqual(sorted(bench.WALKS["CQ32"][0](client)), [["FOUR", 1], ["ONE", 2], ["THREE", 0], ["TWO", 1]])
        self.assertEqual(bench.WALKS["CQ30"][0](client), [["bid:d2", "D two"]])
        self.assertEqual(sorted(bench.WALKS["CQ19"][0](client), key=str),
                         sorted([["First", "bid:nosource", None], ["The first", "bid:nosource", None],
                                 ["1st", "bid:nosource", None], ["1st", "bid:c2", 1], ["1st", "bid:c2", 2]], key=str))
        self.assertEqual(bench.WALKS["CQ13"][0](client), [["R34DA059723", "D one"]] * 2)
        self.assertEqual(sorted(bench.WALKS["CQ26"][0](client)), [["Mus musculus", 1], ["Mus musculus domesticus", 1],
                                                                  ["Mus spretus", 1]])
        self.assertEqual(sorted(row[:2] for row in bench.WALKS["CQ35"][0](client)), [["ONE", 4], ["bid:o1", 1]])
        every = "R34DA059723, U01DA000002, U01DA000002-S1"                 # q2 under two, q6 under one of them
        self.assertEqual(sorted(bench.WALKS["CQ20"][0](client)), [["A. Ann", every], ["Ann A", every], ["Bo B", every]])

    def test_a_graph_with_next_to_nothing_in_it_is_asked_everything_all_the_same(self):
        # no species, no R34DA059723, no working group: nothing for a walk to start from
        asked = self.ask(self.graph(PREFIXES + 'bid:only a bbqs:Project ; bbqs:name "Alone" .\n'))
        self.assertEqual((asked["asked"], asked["answered"], asked["silent_agree"], asked["all_agree"]), (42, 0, 42, True))

    def test_the_one_thing_a_walk_cannot_see_is_a_roster_record_with_an_end_missing(self):
        # Cy is given a role on a project nothing describes. SPARQL reads the half-record, so WG-Analysis
        # now has a member with a role (CQ42); the server makes no link of it, and says so in describe_graph.
        source = self.graph(MINIATURE + 'bid:r9 a bbqs:ProjectRole ; bbqs:held_by bid:cy ; bbqs:on_project bid:nowhere ; '
                                        'bbqs:project_role "co_pi" .\n')
        asked = self.ask(source)
        self.assertEqual(self.differing(asked), [("CQ42", True, False)])
        self.assertEqual((asked["all_agree"], asked["tools_agree"], asked["silent_agree"]), (False, 41, 0))
        kg = m.GraphSource(source, 0).current()
        self.assertEqual(dict(kg.unfolded), {"ProjectRole": 1})
        self.assertTrue(any("1 ProjectRole" in note for note in kg.describe()["notes"]))

    def test_the_reference_is_written_out_by_the_benchmark_not_by_the_server(self):
        # The reference is the export queried directly. Its cells are written by the benchmark's own
        # rules, so a fault in how the server writes a value would show as a difference. Here the two
        # writers are held against each other on every value of the export, and on odd ones.
        kg = m.GraphSource(str(EXPORT), 0).current()
        ids = {iri: node.id for iri, node in kg.nodes.items() if iri.startswith(m.ID_NS)}
        checked = 0
        for s, p, o in kg.graph:
            for term in (s, o):
                self.assertEqual(bench.reference(term, ids), kg._cell(term), term)
                checked += 1
        self.assertGreater(checked, 10_000)
        with self.assertLogs("rdflib.term", level="WARNING"):          # rdflib says so of the ill-typed one
            odd = Graph().parse(data="""@prefix bbqs: <https://brain-bbqs.org/schema#> .
            @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
            <https://brain-bbqs.org/id/a> bbqs:v "12.50"^^xsd:decimal, "7"^^xsd:decimal, "0.1"^^xsd:double, true,
                "2026-01-02"^^xsd:date, "2026-01-02T03:04:05"^^xsd:dateTime, "a sentence"^^xsd:integer, "en"@en,
                <urn:x>, bbqs:Microscope .""", format="turtle")
        small = m.KG(odd)
        small_ids = {iri: node.id for iri, node in small.nodes.items() if iri.startswith(m.ID_NS)}
        for _, _, term in odd:
            self.assertEqual(bench.reference(term, small_ids), small._cell(term), term)
        self.assertEqual(sorted((bench.reference(term, small_ids) for _, _, term in odd), key=str),
                         sorted([12.5, 7, 0.1, True, "2026-01-02", "2026-01-02T03:04:05", "a sentence", "en", "<urn:x>",
                                 "bbqs:Microscope"], key=str))

    def test_the_reference_does_not_lean_on_the_server_to_write_a_value(self):
        broken = small_kg('bid:a a bbqs:Thing ; bbqs:name "A" .')
        ids = {iri: node.id for iri, node in broken.nodes.items()}
        values = Graph().parse(data="""@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
            <urn:s> <urn:p> "12.50"^^xsd:decimal, "2026-01-02"^^xsd:date, "NaN"^^xsd:double, "deadbeef"^^xsd:hexBinary,
                "true"^^xsd:boolean, <https://brain-bbqs.org/id/a>, <urn:x> .""", format="turtle")
        written = {str(term): bench.reference(term, ids) for _, _, term in values}
        with mock.patch.object(m, "_plain", lambda value: "X"), mock.patch.object(m.KG, "_cell", lambda self, term: "X"):
            self.assertEqual({str(term): bench.reference(term, ids) for _, _, term in values}, written)   # not the server's
        nan = next(text for text in written if text.lower() == "nan")
        self.assertEqual(written, {"12.50": 12.5, "2026-01-02": "2026-01-02", nan: "NaN", "deadbeef": "deadbeef", "true": True,
                                   m.ID_NS + "a": "bid:a", "urn:x": "<urn:x>"})      # NaN as text: JSON has no number for it
        self.assertEqual({str(term): broken._cell(term) for _, _, term in values}, written)   # and the server writes the same

    def test_values_written_as_iris_or_blank_nodes_agree_both_ways(self):
        source = self.graph(PREFIXES + """
            bid:t1 a bbqs:SoftwareTool ; bbqs:name "T1" ; bbqs:repo_url <urn:isbn:1> .
            bid:t2 a bbqs:SoftwareTool ; bbqs:name "T2" ; bbqs:repo_url bbqs:Foo .
            bid:t3 a bbqs:SoftwareTool ; bbqs:name "T3" ; bbqs:repo_url <mailto:a@b.org> .
            bid:ann a bbqs:Investigator ; bbqs:name "Ann" ;
                bbqs:orcid <https://orcid.org/0000-0001-0000-0001>, "https://orcid.org/0000-0001-0000-0001" .
            bid:bea a bbqs:Investigator ; bbqs:name "Bea" ; bbqs:orcid <https://orcid.org/0000-0001-0000-0001> .
        """)
        rows = {q["id"]: q for q in self.ask(source)["questions"]}
        for name, count in (("CQ16", 3), ("CQ07", 3)):
            self.assertEqual((rows[name]["rows"], rows[name]["sparql_agrees"], rows[name]["tools_agree"]), (count, True, True))
        # a blank node: SPARQL agrees with the file (the labels are made up per reading); a walk
        # cannot see it, which is documented, and reported
        blank = {q["id"]: q for q in self.ask(self.graph(PREFIXES + 'bid:t4 a bbqs:SoftwareTool ; bbqs:name "T4" ; '
                                                                     'bbqs:repo_url [ bbqs:url "x" ] .\n'))["questions"]}
        self.assertEqual((blank["CQ16"]["rows"], blank["CQ16"]["sparql_agrees"], blank["CQ16"]["tools_agree"]), (1, True, False))

    def test_a_question_the_tools_cannot_walk_in_full_fails_alone(self):
        # A working group of 501: more members than get_node lists at once. The questions that need
        # every member link say so and fail; the rest are asked as usual.
        people = "".join(f'bid:i{n:03d} a bbqs:Investigator ; bbqs:name "I{n:03d}" ; bbqs:member_of_group bid:wgd .\n'
                         for n in range(501))
        asked = self.ask(self.graph(PREFIXES + 'bid:wgd a bbqs:WorkingGroup ; bbqs:name "WG-Devices" .\n' + people))
        wrong = {q["id"]: q.get("error", "") for q in asked["questions"] if not (q["sparql_agrees"] and q["tools_agree"])}
        self.assertEqual(sorted(wrong), ["CQ23", "CQ42"])                  # the two that read every member link
        for name in wrong:
            self.assertIn("more member_of_group links than get_node lists at once (500)", wrong[name])
        rows = {q["id"]: q["rows"] for q in asked["questions"]}
        self.assertEqual((rows["CQ08"], rows["CQ21"], rows["CQ23"]), (501, 501, 501))   # paged through, all of them
        self.assertFalse(asked["all_agree"])

    def test_a_question_the_file_itself_cannot_answer_is_said_not_crashed_on(self):
        source = self.graph(PREFIXES + 'bid:p a bbqs:Project ; bbqs:grant_number "R01X" ; bbqs:mechanism "R01" ; '
                                       'bbqs:award_amount "not yet awarded" .\n')
        asked = self.ask(source)
        cq02 = next(q for q in asked["questions"] if q["id"] == "CQ02")
        self.assertEqual((cq02["status"], cq02["sparql_agrees"], cq02["tools_agree"], asked["could_not_be_asked"]),
                         ("could not be asked", False, False, 1))
        self.assertIn("the export queried directly", cq02["error"])
        block = bench.markdown({"server": "0", "nodes": 1, "links": 0, "snapshot": {"source": "x"}, "questions": asked})
        self.assertIn("| 1 could not be asked: the export queried directly refused it | **not compared** |", block)
        self.assertIn("*(could not be asked)* | — | — | — |", block)              # not "0 rows", not "differs": not compared
        report = bench.report({"server": "0", "nodes": 1, "links": 0, "snapshot": {"source": "x"}, "questions": asked})
        self.assertIn("; 1 could not be asked: NOT ALL AGREE", report)
        self.assertIsNone(cq02["rows"])                                            # neither "answered" nor "no rows"
        self.assertEqual(asked["asked"] - asked["answered"] - asked["could_not_be_asked"], asked["silent_agree"])
        self.assertEqual([q["id"] for q in asked["questions"] if not (q["sparql_agrees"] and q["tools_agree"])], ["CQ02"])

    def test_with_a_full_export_no_rows_is_none_not_needs_the_full_export(self):
        source = self.graph(PREFIXES + 'bid:only a bbqs:Project ; bbqs:name "Alone" .\n')
        full = bench.ask_questions(self.client(source), m.GraphSource(source, 0).current(), source, fresh=False, access="full")
        anon = self.ask(source)
        self.assertEqual((anon["need_the_full_export"], full["need_the_full_export"]), (7, 0))
        self.assertEqual(full["none_in_this_export"], anon["none_in_this_export"] + 7)
        self.assertEqual({q["status"] for q in full["questions"]
                          if q["id"] in ("CQ18", "CQ19", "CQ30", "CQ35", "CQ36", "CQ37", "CQ40")}, {"none in this export"})

    def test_the_ranking_measure_on_a_graph_worked_by_hand(self):
        # S is linked to A01..A11, X and Q; Q to X. Of its 14 ties, the 11 to an A leave nothing to find
        # it by (11 cases, all missed). S-X: from S, X is two links away through Q, first after the
        # eleven direct people; from X, S is first after Q (2 found). S-Q: each finds the other through
        # X (2 found). Q-X: from X, Q is found after S; from Q, X is one of twelve people two links
        # away through S, all equal, and comes after ten of them by name (1 found). 5 of 17.
        star = "".join(f'bid:a{n:02d} a bbqs:Investigator ; bbqs:name "A{n:02d}" .\n' for n in range(1, 12))
        kg = small_kg(star + 'bid:s a bbqs:Project ; bbqs:name "S" ; bbqs:e '
                      + ", ".join(f"bid:a{n:02d}" for n in range(1, 12)) + """, bid:x, bid:q .
            bid:q a bbqs:Project ; bbqs:name "Q" ; bbqs:e bid:x .
            bid:x a bbqs:Investigator ; bbqs:name "X" .""")
        before = {iri: (list(node.links), dict(node.near)) for iri, node in kg.nodes.items()}
        measured = bench.measure_ranking(kg=kg)
        self.assertEqual({iri: (list(node.links), dict(node.near)) for iri, node in kg.nodes.items()}, before)  # put back
        self.assertEqual(measured, {"cases": 17, "in_first_ten": dict.fromkeys(bench.WAYS, 29.4),
                                    "starts_checked_against_the_slow_version": 14, "starts_exactly_equal": 14,
                                    "lists_of_people": 14, "lists_of_people_cut_among_equals": 14})
        # the one case that tells "after the start's direct ties" from "the first ten": S looking for X
        s, x = kg.resolve("S"), kg.resolve("X")
        s.near.pop(x.iri), x.near.pop(s.iri)
        self.assertEqual(bench.look_for(kg, s, x), dict.fromkeys(bench.WAYS, True))
        with mock.patch.object(bench, "look_for", lambda kg, start, hidden: {
                name: hidden.id in [row["id"] for row in ask(kg, start.id, hidden.type, 0)] for name, ask in bench.WAYS.items()}):
            self.assertEqual(bench.look_for(kg, s, x), dict.fromkeys(bench.WAYS, False))   # counting them in, it is not

    def test_the_speed_figures_are_the_median_and_the_95th_percentile(self):
        self.assertEqual(bench.spread([float(n) for n in range(20, 0, -1)], [5, 1, 3]),
                         {"calls": 20, "median_ms": 10.5, "p95_ms": 20.0, "median_bytes": 3, "largest_bytes": 5})
        self.assertEqual(bench.spread([7.0], [9])["p95_ms"], 7.0)

    def test_the_whole_block_and_the_report_say_what_was_measured(self):
        results = {"server": "0.0.0", "nodes": 3, "links": 2, "snapshot": {"source": "x.ttl", "dated": "2026-01-01"},
                   "ranking": {"cases": 1383, "in_first_ten": {"find_related": 62.4, "find_related, up to 8 links": 64.8,
                                                               "get_neighbors": 45.4, "get_neighbors, through hubs": 47.3},
                               "starts_checked_against_the_slow_version": 515, "starts_exactly_equal": 514,
                               "lists_of_people": 421, "lists_of_people_cut_among_equals": 274},
                   "speed": {"tools": {name: {"calls": 9, "median_ms": 9.6, "p95_ms": 15.6, "median_bytes": 7643,
                                              "largest_bytes": 12238} for name in ("find_related", "find_paths")},
                             "ready_seconds": 1.5, "machine": "Box, Python 3"}}
        block = bench.markdown(results).splitlines()
        self.assertIn("| Hide a real tie: the hidden end is among the first ten `find_related` lists after the start's direct "
                      "ties (1,383 cases) | **62%** (65% looking up to 8 links) |", block)
        self.assertIn("| The same for `get_neighbors`, which lists by distance alone | 45% (47% walking through hubs) |", block)
        self.assertIn("| Strengths equal to a slow second version of the rule, exactly | **514 of 515** starting nodes |", block)
        self.assertIn("| A `find_related` call (median; 95th percentile) | 10 ms; 16 ms |", block)
        self.assertIn("| A `find_paths` call | 10 ms; 16 ms |", block)
        self.assertIn("| A `find_related` reply (median; largest of the 9 timed) | 7.6 kB; 12.2 kB |", block)
        report = bench.report(results)
        for said in ("RANKING  1383 cases", f"{'find_related':30s} {62.4:5.1f}%", f"{'get_neighbors, through hubs':30s} {47.3:5.1f}%",
                     "514 of 515 starting nodes", "cut among equals: 274 of 421", "ready 1.5 s after starting",
                     f"{'find_paths':26s} {9:4d} calls   median {9.6:6.1f} ms   95th {15.6:6.1f} ms"):
            self.assertIn(said, report)

    def test_run_from_the_command_line_it_rewrites_the_block_and_nothing_else(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        readme, out, source = Path(folder.name) / "README.md", Path(folder.name) / "out.json", self.graph(MINIATURE)
        readme.write_text(f"before\n{bench.START}\nold\n{bench.END}\nafter\n", encoding="utf8")
        with mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            code = bench.main(["--source", source, "--update", str(readme), "--json", str(out)])
        self.assertEqual(code, 0)
        text = readme.read_text(encoding="utf8")
        self.assertTrue(text.startswith(f"before\n{bench.START}\n") and text.endswith(f"{bench.END}\nafter\n"), text[:200])
        self.assertNotIn("\nold\n", text)
        written = json.loads(out.read_text(encoding="utf8"))
        self.assertEqual(sorted(written), ["links", "nodes", "questions", "ranking", "server", "snapshot", "speed"])
        self.assertEqual(written["ranking"]["starts_exactly_equal"], written["ranking"]["starts_checked_against_the_slow_version"])
        self.assertEqual(bench.markdown(written), text[len("before\n"):-len("\nafter\n")])
        with mock.patch.dict(bench.WALKS, {"CQ09": (lambda client: [], "nothing")}), \
                mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            self.assertEqual(bench.main(["--source", source, "--only", "questions"]), 1)   # a walk that disagrees fails it
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            bench.main(["--source", source, "--only", "questions", "--update", str(readme)])  # --update needs every part

    def test_a_walk_that_went_wrong_would_be_noticed(self):
        with mock.patch.dict(bench.WALKS, {"CQ09": (lambda client: [], "nothing")}):
            asked = self.ask(self.graph(MINIATURE))
        wrong = [q["id"] for q in asked["questions"] if not q["tools_agree"]]
        self.assertEqual((wrong, asked["all_agree"], asked["tools_agree"]), (["CQ09"], False, asked["answered"] - 1))

    def test_what_the_client_makes_of_what_the_tools_return(self):
        client = self.client(self.graph(AWKWARD))
        # an id nothing describes is a value; when two nodes point at it the server makes a node of it too
        self.assertEqual(client.values("o1", "members"), ["https://brain-bbqs.org/id/nobody1"])
        self.assertEqual(sorted(row["type"] for row in client.linked("o1", "members", "out")), ["Investigator", "Unresolved"])
        self.assertEqual(sorted(bench.cell(entry) for entry in client.pointed("o1", "members")), ["bid:ann", "bid:nobody1"])
        self.assertEqual([bench.cell(entry) for entry in client.pointed("j2", "posted_by")], ["https://brain-bbqs.org/id/nobody2"])
        self.assertEqual([bench.cell(entry) for entry in client.pointed("j1", "posted_by")], ["Lab manager"])
        self.assertEqual((client.has("q2", "produced"), client.has("q4", "produced")), (True, False))
        # one entry per link from get_node, one per node from find_related
        self.assertEqual([row["role"] for row in client.linked("q1", "has_role", "in") if row["id"] == "ann"],
                         ["contact_pi", "key_personnel"])
        self.assertEqual(sorted(ids(client.tied("q1", "Investigator", {"has_role"}))), ["ann", "bo"])
        # search_nodes takes "house mouse" for "House Mouse"; a question does not
        self.assertEqual(len(client.listed(type="Species", where={"common_name": "House Mouse"})), 3)
        self.assertEqual(sorted(ids(client.where("Species", common_name="House Mouse"))), ["m1", "m2"])
        # nothing of the kind is an empty answer; any other refusal stops the run
        self.assertEqual((client.all_of("Nonesuch"), client.where("Species", nonesuch="x"), client.tied("q1", "Nonesuch", {"x"})),
                         ([], [], []))
        with self.assertRaises(SystemExit):
            client.listed(type="Species", where={"common_name": "House Mouse"}, query=5)
        with self.assertRaises(SystemExit):
            client.tied("nobody-of-that-name", "Species", {"x"})

    def test_how_two_answers_are_compared(self):
        same = bench.same
        self.assertEqual(same([["b", 2], ["a", 1]]), same([["a", 1], ["b", 2]]))             # the order of rows is not part of it
        self.assertNotEqual(same([["a"], ["a"]]), same([["a"]]))                              # how many times a row comes is
        self.assertEqual(same([[2.0, None]]), same([[2, None]]))
        self.assertNotEqual(same([["2"]]), same([[2]]))
        self.assertEqual(same([["<https://orcid.org/0000-0001>"]]), same([["https://orcid.org/0000-0001"]]))
        self.assertNotEqual(same([["<not an address>"]]), same([["not an address"]]))
        self.assertEqual(same([["n", "b, a"]], {1: ", "}), same([["n", "a, b"]], {1: ", "}))  # a joined cell, in any order
        self.assertNotEqual(same([["n", "b, a"]]), same([["n", "a, b"]]))                     # any other cell, as it is
        self.assertNotEqual(same([["n", "a, a"]], {1: ", "}), same([["n", "a"]], {1: ", "}))
        # which cells are joined is read from the question, so a new one cannot be forgotten
        questions, _ = bench.load_questions()
        self.assertEqual({q["id"]: bench.joined_cells(q["sparql"]) for q in questions if "GROUP_CONCAT" in q["sparql"]},
                         {"CQ20": {1: ", "}, "CQ24": {1: ", "}, "CQ29": {2: ", "}, "CQ35": {2: "; "}})
        self.assertEqual(bench.joined_cells("SELECT ?a (COUNT(?b) AS ?n) (GROUP_CONCAT(?c) AS ?all) { ?a ?b ?c }"), {2: " "})
        self.assertEqual([bench.bid(node) for node in ("abc123", "ext:https://orcid.org/0000-0001", "https://example.org/x",
                                                       m.SCHEMA_NS + "Microscope", m.SCHEMA_NS + "two words", "urn:x")],
                         ["bid:abc123", "<https://orcid.org/0000-0001>", "<https://example.org/x>", "bbqs:Microscope",
                          f"<{m.SCHEMA_NS}two words>", "<urn:x>"])          # as the server writes each in a cell
        self.assertEqual(same([[300.29999999999995]]), same([[300.3]]))     # the order a sum was taken in
        self.assertEqual(same([[0.6000000000000001]]), same([[0.6]]))
        self.assertNotEqual(same([[0.1]]), same([[0.2]]))
        self.assertNotEqual(same([[300.3]]), same([[300.30001]]))
        self.assertEqual(same([[3.0]]), same([[3]]))
        self.assertEqual(same([[1234567890123]]), same([[1234567890123.0]]))   # whole or not, to 12 digits
        self.assertEqual(same([["_:n1a2b"]]), same([["_:f9e8d"]]))              # blank labels are made up per reading
        self.assertEqual(same([["<urn:isbn:1>"], ["bbqs:Foo"]]), same([["urn:isbn:1"], [m.SCHEMA_NS + "Foo"]]))
        self.assertNotEqual(same([["bid:abc"]]), same([[m.ID_NS + "abc"]]))      # a node of this graph stays a node

    def test_the_results_block_is_written_between_its_markers_and_nowhere_else(self):
        def row(name, kind, status, rows, **more):
            return {"id": name, "set": kind, "question": f"{name}?", "status": status, "rows": rows, "sparql_agrees": True,
                    "tools_agree": True, "how": "walk", **more}
        results = {"server": "0.0.0", "nodes": 3, "links": 2, "snapshot": {"source": "x.ttl", "dated": "2026-01-01"},
                   "questions": {"asked": 4, "adopted": 2, "answered": 2, "answered_adopted": 1, "need_the_full_export": 1,
                                 "none_in_this_export": 1, "not_modelled": 0, "sparql_agree": 2, "tools_agree": 2,
                                 "silent_agree": 2, "all_agree": True, "questions": [
                                     row("CQ01", "adopted", "answered", 4), row("CQ02", "adopted", "needs the full export", 0),
                                     row("CQ03", "proposed", "answered", 7), row("CQ04", "proposed", "none in this export", 0)]}}
        block = bench.markdown(results)
        self.assertTrue(block.startswith(bench.START) and block.endswith(bench.END))
        self.assertIn("| Competency questions that return rows on this export | **2 of 4**: 1 of the 2 the KG is scored on, "
                      "1 of the 2 proposed in #441 |", block)
        self.assertIn("| The other 2 (1 need the full export, 1 find none in this export): no rows either way | **2 of 2** |", block)
        lines = block.splitlines()
        at = {name: next(i for i, line in enumerate(lines) if line.startswith(f"| {name} |")) for name in ("CQ02", "CQ03")}
        self.assertEqual(lines[at["CQ02"]], "| CQ02 | CQ02? *(needs the full export)* | 0 | none | none | walk |")
        self.assertEqual(lines[at["CQ03"]], "| CQ03 | CQ03? | 7 | same | same | walk |")
        self.assertIn("Proposed in [#441]", lines[at["CQ03"] - 1])             # the proposed ones under their own heading
        self.assertEqual(sum("Proposed in [#441]" in line for line in lines), 1)
        # a difference is said, in the summary and in the row
        results["questions"].update(tools_agree=1, all_agree=False)
        results["questions"]["questions"][2]["tools_agree"] = False
        differs = bench.markdown(results)
        self.assertIn("same rows again | **1 of 2** |", differs)
        self.assertIn("| CQ03 | CQ03? | 7 | same | **differs** | walk |", differs)
        self.assertIn("NOT ALL AGREE", bench.report({**results, "questions": {**results["questions"], "questions": [
            {**q, "sparql_ms": 1.0, "tools_ms": 1.0, "tool_calls": 1} for q in results["questions"]["questions"]]}}))
        readme = (HERE.parent / "README.md").read_text(encoding="utf8")
        self.assertEqual((readme.count(bench.START), readme.count(bench.END)), (1, 1))     # the main README has the block
        self.assertLess(readme.index(bench.START), readme.index(bench.END))
        for q in bench.load_questions()[0]:                                                # and it lists the questions as they stand
            self.assertEqual(readme.count(f"| {q['id']} | {q['question']}"), 1, q["id"])


class TheCommandLine(unittest.TestCase):
    def run_server(self, *args: str):
        return subprocess.run([sys.executable, str(SERVER), *args], capture_output=True, text=True, timeout=60)

    def test_check_prints_what_the_graph_holds(self):
        done = self.run_server("--check", "--source", str(EXPORT))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertRegex(done.stdout, r"bbqs-kg [\d.]+: \d+ nodes, \d+ links, \d+ triples from kg/export/bbqs\.ttl")
        self.assertIn("Investigator -has_role-> Project", done.stdout)

    def test_a_source_that_cannot_be_read_stops_it_with_the_reason(self):
        done = self.run_server("--check", "--source", "definitely-not-here.ttl")
        self.assertEqual(done.returncode, 2)
        self.assertIn("No knowledge graph could be loaded", done.stderr)
        self.assertIn("definitely-not-here.ttl", done.stderr)
        self.assertEqual(done.stdout, "")

    def test_answers_do_not_depend_on_how_this_process_happens_to_hash(self):
        # Sets and dicts of strings order differently from one process to the next. Nothing a tool
        # returns may follow that order: the same question, asked of three processes, reads the same.
        asks = ("import json, sys; sys.path.insert(0, sys.argv[1]); import mcp_server as m; "
                "kg = m.GraphSource(sys.argv[2], 0).current(); "
                "print(json.dumps([kg.related(['House Mouse', 'WG-Devices'], limit=25), kg.related('WG-Analytics'), "
                "kg.paths('House Mouse', 'WG-Devices', limit=25), kg.neighbors('R34DA059723', depth=2), "
                "kg.search('behavior', limit=50)], sort_keys=True))")
        said = set()
        for seed in ("0", "1", "4242"):
            done = subprocess.run([sys.executable, "-c", asks, str(HERE), str(EXPORT)], capture_output=True, text=True,
                                  timeout=60, env={**os.environ, "PYTHONHASHSEED": seed})
            self.assertEqual(done.returncode, 0, done.stderr)
            said.add(done.stdout)
        self.assertEqual(len(said), 1)
        self.assertGreater(len(said.pop()), 10_000)

    def test_the_source_can_come_from_the_environment(self):
        done = subprocess.run([sys.executable, str(SERVER), "--check"], capture_output=True, text=True, timeout=60,
                              env={**os.environ, "BBQS_KG_SOURCE": str(EXPORT)})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("not served from the preferred source", done.stdout)


if __name__ == "__main__":
    import faulthandler
    faulthandler.dump_traceback_later(900, exit=True)   # a loop that never ends fails the run, saying where
    unittest.main(verbosity=1)
