#!/usr/bin/env python3
"""Tests for kg/mcp_server.py.

    python kg/test_mcp_server.py        # needs kg/requirements.txt and kg/requirements-mcp.txt

Four layers, each catching what the others cannot:

  the view      -- a small hand-built graph whose every answer was worked out by hand: folding the
                   roster, shared identifiers, references, search, neighbours, paths, SPARQL.
  the export    -- the committed graph: every competency question the baseline says is answered
                   comes back through sparql_query, and the walking tools agree with SPARQL.
  the guards    -- cross-file invariants: schema terms the server names exist in the TBox, the
                   pinned dependencies agree, and no tool can change the graph.
  the protocol  -- the server as a client sees it: a real process, raw JSON-RPC over stdio and
                   over streamable HTTP. Nothing here is skipped when a dependency is missing.
"""
import asyncio
import http.server
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
from pathlib import Path
from unittest import mock

import yaml
from rdflib import Graph

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
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

    # -- paths --

    def test_paths_shortest_first_and_less_connected_first_among_equals(self):
        found = self.kg.paths(ADA, CYD)
        self.assertEqual((found["found"], found["shortest"]), (4, 4))
        self.assertEqual([p["nodes"] for p in found["paths"]],
                         [[ADA, WGD, BOB, WGA, CYD], [ADA, WGD, BOB, P2, CYD],
                          [ADA, P1, BOB, WGA, CYD], [ADA, P1, BOB, P2, CYD]])
        self.assertEqual(found["paths"][3]["text"],
                         'Investigator "Ada Lovelace" -[has_role contact_pi]-> Project "R34DA000001 · Mouse social '
                         'behavior tracking" <-[has_role co_pi]- Investigator "Bob Müller" -[has_role contact_pi]-> '
                         'Project "R61MH000002 · Zebrafish imaging at scale" <-[has_role postdoc]- '
                         'Investigator "Cyd  Charisse"')
        self.assertNotIn("more", found)

    def test_paths_can_leave_edges_out(self):
        found = self.kg.paths(ADA, CYD, avoid_edges="member_of_group")
        self.assertEqual([p["nodes"] for p in found["paths"]], [[ADA, P1, BOB, P2, CYD]])

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
        self.assertEqual((far["found"], far["shortest"]), (0, 4))
        self.assertIn("4 hops", far["note"])
        self.assertEqual(self.kg.paths(MOUSE, ZEBRA)["paths"][0]["nodes"], [MOUSE, P1, BOB, P2, ZEBRA])
        self.assertIn("same node", self.kg.paths(ADA, "Ada Lovelace")["note"])
        cut = self.kg.paths(ADA, CYD, avoid_edges=["member_of_group", "has_role"])
        self.assertIn("without has_role, member_of_group", cut["note"])

    def test_paths_say_when_there_are_more_than_were_returned(self):
        some = self.kg.paths(ADA, CYD, limit=2)
        self.assertEqual((some["found"], some["more"]), (2, True))

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

    def test_every_shown_id_leads_back_to_its_node(self):
        for node in self.kg.nodes.values():
            self.assertIs(self.kg.resolve(node.id), node)
            self.assertIs(self.kg.resolve(node.iri) if node.type != m.EXTERNAL else node, node)
        self.assertEqual(len({n.id for n in self.kg.nodes.values()}), len(self.kg.nodes))

    def test_answers_come_out_in_the_same_order_every_time(self):
        again = m.GraphSource(str(EXPORT)).current()
        for call in (lambda kg: kg.search("behavior", limit=50), lambda kg: kg.neighbors("WG-Analytics", limit=200),
                     lambda kg: kg.paths("House Mouse", "WG-Devices", limit=10), lambda kg: kg.describe()["edge_types"]):
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
        for tool in self.tools:
            known |= {tool.name, *tool.input_schema["properties"]}
            texts += [tool.description, *(p.get("description", "") for p in tool.input_schema["properties"].values())]
        mentioned = {word for text in texts for word in re.findall(r"\b[a-z]+(?:_[a-z0-9]+)+\b", text)}
        mentioned |= {word for text in texts for word in re.findall(r"\bbbqs:(\w+)", text)}
        mentioned |= {word for text in texts for word in re.findall(r"\b(?:[A-Z][a-z]+){2,}\b", text)}
        self.assertGreater(len(mentioned), 12)
        self.assertEqual(sorted(mentioned - known), [])

    def test_every_tool_is_declared_read_only(self):
        self.assertEqual(sorted(t.name for t in self.tools),
                         ["describe_graph", "find_paths", "get_neighbors", "get_node", "search_nodes", "sparql_query"])
        for tool in self.tools:
            self.assertTrue(tool.annotations.read_only_hint, tool.name)
            self.assertFalse(tool.annotations.destructive_hint, tool.name)
            self.assertFalse(tool.annotations.open_world_hint, tool.name)
            self.assertGreater(len(tool.description), 60, tool.name)
        offered = asyncio.run(m.build_server(m.GraphSource(str(EXPORT)), sparql=False).list_tools())
        self.assertNotIn("sparql_query", [t.name for t in offered])

    def test_the_pins_agree_everywhere_they_are_written(self):
        header = re.search(r"^# dependencies = (\[.*\])$", SERVER.read_text(encoding="utf8"), re.M)
        inline = set(json.loads(header.group(1)))
        pins = lambda name: {line.strip() for line in (HERE / name).read_text(encoding="utf8").splitlines()  # noqa: E731
                             if re.match(r"^[A-Za-z0-9_.-]+==", line.strip())}
        self.assertEqual(inline, pins("requirements-mcp.txt"))
        self.assertEqual({p for p in inline if p.startswith("rdflib==")},
                         {p for p in pins("requirements.txt") if p.startswith("rdflib==")})
        self.assertEqual({p.split("==")[0] for p in inline}, {"mcp", "rdflib"})


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

    def test_it_lists_six_read_only_tools_with_schemas(self):
        tools = self.client.ask("tools/list")["result"]["tools"]
        self.assertEqual(sorted(t["name"] for t in tools),
                         ["describe_graph", "find_paths", "get_neighbors", "get_node", "search_nodes", "sparql_query"])
        for tool in tools:
            self.assertIs(tool["annotations"]["readOnlyHint"], True, tool["name"])
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertNotIn("outputSchema", tool)             # answers are text; nothing is sent twice
        paths = next(t for t in tools if t["name"] == "find_paths")["inputSchema"]
        self.assertEqual(sorted(paths["required"]), ["source_node", "target_node"])
        self.assertIn("description", paths["properties"]["avoid_edges"])

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
                         ["describe_graph", "find_paths", "get_neighbors", "get_node", "search_nodes"])   # --no-sparql
        reply = self.post(_request(3, "tools/call", {"name": "find_paths", "arguments": {
            "source_node": "House Mouse", "target_node": "Zebrafish"}}))["result"]
        self.assertEqual(json.loads(reply["content"][0]["text"])["paths"][0]["nodes"], [MOUSE, P1, BOB, P2, ZEBRA])
        refused = self.post(_request(4, "tools/call", {"name": "sparql_query", "arguments": {"query": "ASK {}"}}))
        self.assertTrue("error" in refused or refused["result"].get("isError"))


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

    def test_the_source_can_come_from_the_environment(self):
        done = subprocess.run([sys.executable, str(SERVER), "--check"], capture_output=True, text=True, timeout=60,
                              env={**os.environ, "BBQS_KG_SOURCE": str(EXPORT)})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("not served from the preferred source", done.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
