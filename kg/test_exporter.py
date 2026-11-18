#!/usr/bin/env python3
"""Tests for the exporter (kg/bbqs_kg.py), run against a stand-in for Supabase's REST API.

    python kg/test_exporter.py        # needs only kg/requirements.txt (rdflib, PyYAML)

Nothing leaves the machine: urllib.request.urlopen is replaced by a PostgREST in miniature that
serves the rows each test gives it, and answers for a missing or refused table the way PostgREST
does. What is checked is the graph export() writes: jobs from the public_jobs view and who posted
them from public_job_posters, the link-don't-copy rule for a job's institution, that nothing
private is written whatever a view hands over, and that a view that is missing or refused is
skipped with a note instead of failing the export. The stand-in serves the objects anon reads column
by column (20261117190000) as PostgREST does: select=* or a private column is refused, so the
exporter must name public columns (PUBLIC_COLUMNS). The competency questions about jobs (CQ18,
CQ35, CQ36, CQ37) are then asked of that graph, so a question and the exporter cannot drift apart.
The curated links in resource_links (a published paper's revision_of its preprint among them) are
written only between two nodes and only for a predicate the schema has, an ORCID is written in
its one form whatever case its X has, and kg/roundtrip.py counts those links as links.
"""
import contextlib
import io
import json
import os
import re
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock

import yaml
from rdflib import Literal, URIRef
from rdflib.namespace import RDF, XSD

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bbqs_kg import BBQS, BID, PUBLIC_COLUMNS, BBQSKnowledgeGraph  # noqa: E402
from roundtrip import RoundTrip  # noqa: E402

# The columns anon may not read, as the migration that hides them lists them (its one list).
HIDE_MIGRATION = HERE.parent / "supabase" / "migrations" / "20261117190000_hide_private_columns_from_anon.sql"


def private_from_anon() -> dict:
    """object -> the columns 20261117190000 takes from anon, read from its kg_private_from_anon rows."""
    sql = HIDE_MIGRATION.read_text(encoding="utf8")
    block = sql[sql.index("INSERT INTO kg_private_from_anon"):]
    block = block[:block.index(";")]
    private = {}
    for obj, col in re.findall(r"\(\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'", block):
        private.setdefault(obj, set()).add(col)
    return private


PRIVATE_FROM_ANON = private_from_anon()


def uid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


# Spine rows (resources.id) and the detail rows' own ids.
ORG_A, ORG_B = uid(1), uid(2)                       # organizations' spine rows
ORG_A_ID, ORG_B_ID, ORG_NOWHERE_ID = uid(11), uid(12), uid(13)   # organizations.id (the last has no row)
PAT, OLU = uid(21), uid(22)                         # investigators' spine rows
PAT_ID, OLU_ID = uid(31), uid(32)                   # investigators.id
JOB_SPINE_ORG = uid(41)    # its spine row names organization A; its jobs row names A too, in other words
JOB_ROW_ORG = uid(42)      # no organization on the spine row; the jobs row names organization B
JOB_TEXT = uid(43)         # no organization anywhere: the institution is kept as written
JOB_UNKNOWN_ORG = uid(44)  # the jobs row names an organization id no organizations row has
JOB_NO_NAME = uid(45)      # no organization, and an institution that is only spaces
JOB_BARE = uid(46)         # a job with a spine row and no public_jobs row
NOT_A_JOB = uid(51)        # a public_jobs row pointing at a spine row that is not a job
AUTH_UID = "a5a5a5a5-0000-4000-8000-0000000000aa"   # jobs.posted_by, an auth user id: never in the graph
SECRET_EMAIL, SECRET_NAME = "pat.poster@example.invalid", "Pat Poster (contact)"

RESOURCES = [
    {"id": ORG_A, "resource_type": "organization", "name": "UNIVERSITY OF A"},
    {"id": ORG_B, "resource_type": "organization", "name": "B INSTITUTE"},
    {"id": PAT, "resource_type": "investigator", "name": "Pat Poster"},
    {"id": OLU, "resource_type": "investigator", "name": "Olu Other"},
    {"id": JOB_SPINE_ORG, "resource_type": "job", "name": "Postdoc in vision", "organization_id": ORG_A_ID},
    {"id": JOB_ROW_ORG, "resource_type": "job", "name": "Data engineer"},
    {"id": JOB_TEXT, "resource_type": "job", "name": "Lab technician"},
    {"id": JOB_UNKNOWN_ORG, "resource_type": "job", "name": "Research scientist"},
    {"id": JOB_NO_NAME, "resource_type": "job", "name": "PhD student"},
    {"id": JOB_BARE, "resource_type": "job", "name": "Intern"},
    {"id": NOT_A_JOB, "resource_type": "announcement", "name": "Retreat"},
]
ORGANIZATIONS = [{"id": ORG_A_ID, "resource_id": ORG_A, "url": "https://a.example.org"},
                 {"id": ORG_B_ID, "resource_id": ORG_B}]
INVESTIGATORS_PUBLIC = [{"id": PAT_ID, "resource_id": PAT, "name": "Pat Poster"},
                        {"id": OLU_ID, "resource_id": OLU, "name": "Olu Other"}]


def job_row(resource_id, institution, organization_id=None, **more):
    """A public_jobs row, carrying the private columns a careless view might leak as well: the
    exporter must take only the columns it means to."""
    return {"id": "10000000" + resource_id[8:], "resource_id": resource_id, "title": "(the spine has the name)",
            "institution": institution, "organization_id": organization_id, "department": None, "location": None,
            "job_type": "postdoc", "description": "(the spine has the description)", "application_url": None,
            "expires_at": None, "is_active": True, "created_at": "2026-11-01T00:00:00+00:00",
            "updated_at": "2026-11-02T00:00:00+00:00",
            "contact_name": SECRET_NAME, "contact_email": SECRET_EMAIL, "posted_by": AUTH_UID, **more}


PUBLIC_JOBS = [
    job_row(JOB_SPINE_ORG, "Univ. of A", ORG_A_ID, department="Psychology", location="Boston, MA",
            application_url="https://jobs.a.example.org/123", expires_at="2026-12-31T23:59:59+00:00"),
    job_row(JOB_ROW_ORG, "B Inst.", ORG_B_ID, job_type="engineer", is_active=False),
    job_row(JOB_TEXT, "Lab of Nowhere", job_type="engineer", expires_at="next spring"),
    job_row(JOB_UNKNOWN_ORG, "Elsewhere University", ORG_NOWHERE_ID, job_type="research_scientist"),
    job_row(JOB_NO_NAME, "   ", job_type="phd", is_active=None),
    job_row(NOT_A_JOB, "Somewhere", ORG_A_ID, job_type="faculty"),
    job_row(uid(99), "Gone", ORG_A_ID, job_type="faculty"),          # a resource_id no resources row has
]
PUBLIC_JOB_POSTERS = [
    {"job_resource_id": JOB_SPINE_ORG, "poster_resource_id": PAT},
    {"job_resource_id": JOB_TEXT, "poster_resource_id": ORG_A},     # not a person: no link
    {"job_resource_id": NOT_A_JOB, "poster_resource_id": OLU},      # not a job: no link
    {"job_resource_id": uid(99), "poster_resource_id": PAT},        # no such node: no link
]
TABLES = {"resources": RESOURCES, "organizations": ORGANIZATIONS, "investigators_public": INVESTIGATORS_PUBLIC,
          "public_jobs": PUBLIC_JOBS, "public_job_posters": PUBLIC_JOB_POSTERS}

# resource_links: each row names two spine rows (resources.id) and a predicate.
MODEL, DATASET, PUBLISHED, PREPRINT, BENCHMARK, SOFTWARE, LEGACY_PROJECT = (uid(n) for n in range(61, 68))
DELETED = uid(97)                    # a resources row that is gone (resource_links cascades, but a stale read may not)
LINK_RESOURCES = RESOURCES + [
    {"id": MODEL, "resource_type": "ml_model", "name": "Pose model"},
    {"id": DATASET, "resource_type": "dataset", "name": "Pose dataset"},
    {"id": PUBLISHED, "resource_type": "publication", "name": "Mapping behavior across species"},
    {"id": PREPRINT, "resource_type": "publication", "name": "Mapping behavior across species"},
    {"id": BENCHMARK, "resource_type": "benchmark", "name": "Pose leaderboard"},
    {"id": SOFTWARE, "resource_type": "software", "name": "Pose tracker"},
    {"id": LEGACY_PROJECT, "resource_type": "project", "name": "A legacy project row (never a node)"},
]
RESOURCE_LINKS = [
    {"subject_id": PUBLISHED, "predicate": "revision_of", "object_id": PREPRINT},
    {"subject_id": MODEL, "predicate": "trained_on", "object_id": DATASET},
    {"subject_id": BENCHMARK, "predicate": "evaluates", "object_id": SOFTWARE},
    {"subject_id": BENCHMARK, "predicate": "uses_software", "object_id": SOFTWARE},     # no such slot
    {"subject_id": BENCHMARK, "predicate": "evaluates", "object_id": DELETED},           # no node at that end
    {"subject_id": LEGACY_PROJECT, "predicate": "produced", "object_id": DATASET},       # a type the spine skips
]
LOWER_X = "0000-0002-1825-009x"      # an ORCID iD whose check character is X, written in lower case
LINK_TABLES = {**TABLES, "resources": LINK_RESOURCES, "resource_links": RESOURCE_LINKS,
               "investigators_public": [{**INVESTIGATORS_PUBLIC[0], "orcid": f"https://orcid.org/{LOWER_X}"},
                                        INVESTIGATORS_PUBLIC[1]],
               "publications": [{"id": uid(71), "resource_id": PUBLISHED, "title": "Mapping behavior across species",
                                 "author_orcids": [LOWER_X], "pmid": "200001"},
                                {"id": uid(72), "resource_id": PREPRINT, "title": "Mapping behavior across species",
                                 "journal": "bioRxiv", "pmid": "200002"}]}


class FakePostgrest:
    """GET <url>/rest/v1/<table>?select=... -> the rows given for that table, [] for any other.
    A table in `missing` answers as PostgREST does for one that does not exist (`code` 42P01, or
    PGRST205 from a newer PostgREST), one in `refused` as for one anon may not read (401, 42501).
    An object in `private` is read column by column, as anon reads it once 20261117190000 is
    applied: select=*, or a select naming one of its private columns, is refused (401, 42501).
    A column in `absent` does not exist in this database: a select naming it is refused the way
    PostgREST refuses it (400, 42703, "column <table>.<column> does not exist"), first one first."""

    def __init__(self, tables, missing=(), refused=(), missing_code="42P01", private=None, absent=None):
        self.tables, self.missing, self.refused, self.missing_code = tables, set(missing), set(refused), missing_code
        self.private = PRIVATE_FROM_ANON if private is None else private
        self.absent = absent or {}
        self.asked = []
        self.selects = {}          # table -> the select= it was asked for

    def __call__(self, request, timeout=None):
        url = urllib.parse.urlparse(request.full_url)
        table = url.path.rsplit("/", 1)[-1]
        select = urllib.parse.parse_qs(url.query).get("select", ["*"])[0]
        self.asked.append(table)
        self.selects.setdefault(table, []).append(select)
        if table in self.missing:
            raise self._error(request.full_url, 404, self.missing_code, f"relation \"public.{table}\" does not exist")
        if table in self.refused:
            raise self._error(request.full_url, 401, "42501", f"permission denied for view {table}")
        if table in self.absent:
            gone = [c.strip() for c in select.split(",") if c.strip() in self.absent[table]]
            if gone:
                raise self._error(request.full_url, 400, "42703", f"column {table}.{gone[0]} does not exist")
        if table in self.private:
            named = {c.strip() for c in select.split(",")}
            if "*" in named or named & self.private[table]:
                raise self._error(request.full_url, 401, "42501", f"permission denied for table {table}")
        return io.BytesIO(json.dumps(self.tables.get(table, [])).encode())

    @staticmethod
    def _error(url, status, code, message):
        body = json.dumps({"code": code, "message": message, "details": None, "hint": None}).encode()
        return urllib.error.HTTPError(url, status, message, {"Content-Type": "application/json"}, io.BytesIO(body))


def export(**rest):
    """Run export() against the stand-in. Returns (the exporter, its graph, what it printed)."""
    fake = FakePostgrest(rest.pop("tables", TABLES), **rest)
    kg = BBQSKnowledgeGraph(url="https://stand-in.invalid", key="anon-key")
    out, err = io.StringIO(), io.StringIO()
    with tempfile.TemporaryDirectory() as folder, mock.patch("urllib.request.urlopen", fake), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        written = kg.export(Path(folder) / "bbqs.ttl")
        assert written.exists() and written.stat().st_size > 0
    return kg, kg.graph, out.getvalue() + err.getvalue(), fake


def objects(graph, subject: str, slot: str) -> set:
    return set(graph.objects(BID[subject], BBQS[slot]))


class AColumnThisDatabaseLacks(unittest.TestCase):
    """A PUBLIC_COLUMNS entry the live database does not have (42703) costs that one column, not the
    whole object. On 2026-11-18 investigators_public answered 42703 to the column list, and the export
    lost every person's ORCID, roles, working groups, research areas and skills."""

    # one person with every fact the view carries, so losing the view would show
    TABLES = {**TABLES, "investigators_public": [{**INVESTIGATORS_PUBLIC[0], "orcid": "0000-0002-1825-0097",
                                                  "role": "Principal Investigator", "research_areas": ["vision"],
                                                  "skills": ["python"]}, *INVESTIGATORS_PUBLIC[1:]]}
    SLOTS = ("orcid", "consortium_role", "research_areas", "skills")

    @classmethod
    def setUpClass(cls):
        cls.full = export(tables=cls.TABLES)[1]

    def count(self, graph, slot):
        return len(list(graph.triples((None, BBQS[slot], None))))

    def test_the_object_is_still_exported_without_that_column(self):
        kg, g, said, fake = export(tables=self.TABLES, absent={"investigators_public": {"onboarded"}})
        self.assertNotIn("investigators_public", kg.unreadable)
        self.assertEqual(kg.missing_columns, {"investigators_public": ["onboarded"]})
        self.assertIn("column onboarded does not exist in this database", said)
        asked = [sel.split(",") for sel in fake.selects["investigators_public"]]
        # asked for once, refused once, and then neither in the retry nor in any later read of the view
        self.assertEqual(sum("onboarded" in sel for sel in asked), 1, asked)
        for slot in self.SLOTS:
            self.assertGreater(self.count(self.full, slot), 0, slot)
            self.assertEqual(self.count(g, slot), self.count(self.full, slot), slot)

    def test_several_missing_columns_are_dropped_one_by_one(self):
        kg, g, said, fake = export(tables=self.TABLES, absent={"investigators_public": {"onboarded", "scholar_id"}})
        self.assertEqual(sorted(kg.missing_columns["investigators_public"]), ["onboarded", "scholar_id"])
        self.assertNotIn("investigators_public", kg.unreadable)
        self.assertEqual(self.count(g, "orcid"), self.count(self.full, "orcid"))

    def test_any_other_refusal_still_gives_no_rows(self):
        kg, g, said, fake = export(tables=self.TABLES, refused={"investigators_public"})
        self.assertEqual(kg.unreadable.get("investigators_public"), "HTTP 401 42501")
        self.assertEqual(kg.missing_columns, {})


class JobDetails(unittest.TestCase):
    """public_jobs: what the board shows anyone goes onto the Job node."""

    @classmethod
    def setUpClass(cls):
        cls.kg, cls.g, cls.said, cls.fake = export()

    def test_the_view_is_read(self):
        self.assertIn("public_jobs", self.fake.asked)
        self.assertNotIn("jobs", self.fake.asked)            # the table itself, contact fields and all: never

    def test_each_row_goes_onto_its_job_node_with_its_types(self):
        n = JOB_SPINE_ORG
        self.assertEqual(objects(self.g, n, "job_type"), {Literal("postdoc")})
        self.assertEqual(objects(self.g, n, "department"), {Literal("Psychology")})
        self.assertEqual(objects(self.g, n, "location"), {Literal("Boston, MA")})
        self.assertEqual(objects(self.g, n, "application_url"),
                         {Literal("https://jobs.a.example.org/123", datatype=XSD.anyURI)})
        self.assertEqual(objects(self.g, n, "expires_at"),
                         {Literal("2026-12-31T23:59:59+00:00", datatype=XSD.dateTime)})
        self.assertEqual(objects(self.g, n, "is_active"), {Literal(True)})
        self.assertEqual(objects(self.g, JOB_ROW_ORG, "is_active"), {Literal(False)})
        self.assertEqual(objects(self.g, JOB_UNKNOWN_ORG, "job_type"), {Literal("research_scientist")})

    def test_a_value_that_is_not_there_or_not_a_timestamp_is_not_written(self):
        self.assertEqual(objects(self.g, JOB_TEXT, "expires_at"), set())          # "next spring"
        self.assertEqual(objects(self.g, JOB_NO_NAME, "is_active"), set())        # null
        self.assertEqual(objects(self.g, JOB_ROW_ORG, "department"), set())
        self.assertIn("1 expires_at not a timestamp", self.said)

    def test_the_spine_keeps_the_name_and_description_and_they_are_not_copied(self):
        self.assertEqual(objects(self.g, JOB_SPINE_ORG, "name"), {Literal("Postdoc in vision")})
        for slot in ("title", "description", "description_text"):
            self.assertEqual({o for o in self.g.objects(None, BBQS[slot]) if "(the spine has" in str(o)}, set(), slot)

    def test_a_row_with_no_job_node_writes_nothing(self):
        self.assertEqual(set(self.g.predicate_objects(BID[uid(99)])), set())      # no node is made for it
        self.assertEqual(objects(self.g, NOT_A_JOB, "job_type"), set())          # an announcement stays one
        self.assertEqual(set(self.g.objects(BID[NOT_A_JOB], RDF.type)), {BBQS.Announcement})
        self.assertIn("2 with no Job node (skipped)", self.said)

    def test_a_job_with_no_row_keeps_what_the_spine_says(self):
        self.assertEqual({p for p, _ in self.g.predicate_objects(BID[JOB_BARE])}, {RDF.type, BBQS.name})


class TheInstitution(unittest.TestCase):
    """Link, don't copy (kg/README.md): the institution is the part_of_org link, and the text as
    written only when no organization node resolves for the job."""

    @classmethod
    def setUpClass(cls):
        cls.kg, cls.g, cls.said, _ = export()

    def test_an_organization_on_the_spine_row_is_the_link_and_the_text_is_not_kept(self):
        self.assertEqual(objects(self.g, JOB_SPINE_ORG, "part_of_org"), {BID[ORG_A]})
        self.assertEqual(objects(self.g, JOB_SPINE_ORG, "job_institution"), set())   # "Univ. of A" is not copied

    def test_an_organization_on_the_job_row_alone_is_the_link_too(self):
        self.assertEqual(objects(self.g, JOB_ROW_ORG, "part_of_org"), {BID[ORG_B]})
        self.assertEqual(objects(self.g, JOB_ROW_ORG, "job_institution"), set())

    def test_with_no_organization_to_link_the_institution_is_kept_as_written(self):
        self.assertEqual(objects(self.g, JOB_TEXT, "part_of_org"), set())
        self.assertEqual(objects(self.g, JOB_TEXT, "job_institution"), {Literal("Lab of Nowhere")})
        self.assertEqual(objects(self.g, JOB_UNKNOWN_ORG, "part_of_org"), set())   # an id no organization has
        self.assertEqual(objects(self.g, JOB_UNKNOWN_ORG, "job_institution"), {Literal("Elsewhere University")})
        self.assertIn("institution kept as text for 2 jobs", self.said)

    def test_an_institution_that_says_nothing_is_not_written(self):
        self.assertEqual(objects(self.g, JOB_NO_NAME, "job_institution"), set())

    def test_the_order_of_the_rows_does_not_matter(self):
        # Two rows on one job, the one with no organization first: the link still wins.
        rows = [job_row(JOB_TEXT, "Lab of Nowhere"), job_row(JOB_TEXT, "B Inst.", ORG_B_ID)]
        _, g, _, _ = export(tables={**TABLES, "public_jobs": rows})
        self.assertEqual(objects(g, JOB_TEXT, "part_of_org"), {BID[ORG_B]})
        self.assertEqual(objects(g, JOB_TEXT, "job_institution"), set())


class WhoPostedIt(unittest.TestCase):
    """public_job_posters: who posted each job, as a link to their Investigator node."""

    @classmethod
    def setUpClass(cls):
        cls.kg, cls.g, cls.said, _ = export()

    def test_the_poster_is_a_link_to_the_investigator_node(self):
        self.assertEqual(set(self.g.subject_objects(BBQS.posted_by)), {(BID[JOB_SPINE_ORG], BID[PAT])})
        self.assertIn("posted_by links (public_job_posters): 1", self.said)

    def test_a_pair_whose_ends_are_not_a_job_and_a_person_is_not_written(self):
        self.assertEqual(objects(self.g, JOB_TEXT, "posted_by"), set())       # the "poster" is an organization
        self.assertEqual(objects(self.g, NOT_A_JOB, "posted_by"), set())
        self.assertEqual(set(self.g.predicate_objects(BID[uid(99)])), set())


class NothingPrivate(unittest.TestCase):
    """Whatever a view hands over, the contact fields and the auth user id never reach the graph."""

    @classmethod
    def setUpClass(cls):
        cls.kg, cls.g, cls.said, _ = export()

    def test_no_contact_slot_and_no_poster_but_the_link(self):
        for slot in ("contact_name", "contact_email"):
            self.assertEqual(set(self.g.subject_objects(BBQS[slot])), set(), slot)
        self.assertTrue(all(isinstance(o, URIRef) and str(o).startswith(str(BID))
                            for o in self.g.objects(None, BBQS.posted_by)))

    def test_no_private_value_anywhere(self):
        for term in {t for triple in self.g for t in triple}:
            for secret in (SECRET_EMAIL, SECRET_NAME, AUTH_UID):
                self.assertNotIn(secret, str(term))
        self.assertNotIn(SECRET_EMAIL, self.g.serialize(format="turtle"))


class OnlyTheColumnsAnonMayRead(unittest.TestCase):
    """20261117190000 takes auth user ids, e-mail addresses and review notes away from anon column by
    column, so PostgREST refuses anon select=* on those objects. The exporter names the public columns
    (PUBLIC_COLUMNS) instead, and never a private one."""

    @classmethod
    def setUpClass(cls):
        cls.kg, cls.g, cls.said, cls.fake = export()

    def test_the_migration_lists_what_it_hides(self):
        self.assertTrue({"user_id", "pending_role"} <= PRIVATE_FROM_ANON["investigators_public"])
        self.assertTrue({"last_edited_by", "questionnaire_submitted_by"} <= PRIVATE_FROM_ANON["projects"])
        self.assertTrue({"raw", "hidden_reason", "hidden_by"} <= PRIVATE_FROM_ANON["dandisets"])

    def test_no_object_read_column_by_column_is_refused(self):
        self.assertEqual({t: why for t, why in self.kg.unreadable.items() if t in PRIVATE_FROM_ANON}, {})

    def test_each_is_asked_for_by_name_and_never_for_a_private_column(self):
        asked = {t: s for t, s in self.fake.selects.items() if t in PRIVATE_FROM_ANON}
        self.assertTrue({"resources", "projects", "investigators_public", "dandisets"} <= set(asked), asked)
        for table, selects in asked.items():
            for select in selects:
                named = {c.strip() for c in select.split(",")}
                self.assertNotIn("*", named, table)
                self.assertEqual(named & PRIVATE_FROM_ANON[table], set(), table)

    def test_the_public_column_lists_hold_no_private_column(self):
        for table, columns in PUBLIC_COLUMNS.items():
            self.assertIn(table, PRIVATE_FROM_ANON, f"{table} is not read column by column, so it needs no list")
            self.assertEqual(set(columns.split(",")) & PRIVATE_FROM_ANON[table], set(), table)

    def test_asking_for_everything_would_lose_them(self):
        # The exporter as it was, select=* everywhere: refused on each one, and the graph loses its spine.
        with mock.patch.dict("bbqs_kg.PUBLIC_COLUMNS", clear=True):
            kg, g, _, _ = export()
        for table in ("resources", "investigators_public"):
            self.assertEqual(kg.unreadable.get(table), "HTTP 401 42501", table)
        self.assertEqual(set(g.subjects(RDF.type, BBQS.Job)), set())


class AViewThatIsNotThere(unittest.TestCase):
    """A view whose migration is not applied, or that anon may not read, is skipped with a note."""

    def check_skipped(self, said, kg, table, reason):
        self.assertEqual(kg.unreadable[table], reason)
        self.assertIn(f"{table} not readable ({reason})", said)

    def test_public_jobs_missing(self):
        kg, g, said, _ = export(missing={"public_jobs"})
        self.check_skipped(said, kg, "public_jobs", "HTTP 404 42P01")
        self.assertEqual(set(g.subject_objects(BBQS.job_type)), set())
        self.assertEqual(set(g.subject_objects(BBQS.job_institution)), set())
        # what the spine says stays: every job, its name, and the organization on its spine row
        self.assertEqual(len(set(g.subjects(RDF.type, BBQS.Job))), 6)
        self.assertEqual(objects(g, JOB_SPINE_ORG, "part_of_org"), {BID[ORG_A]})
        self.assertEqual(set(g.subject_objects(BBQS.posted_by)), {(BID[JOB_SPINE_ORG], BID[PAT])})

    def test_public_job_posters_missing_as_a_newer_postgrest_says_it(self):
        kg, g, said, _ = export(missing={"public_job_posters"}, missing_code="PGRST205")
        self.check_skipped(said, kg, "public_job_posters", "HTTP 404 PGRST205")
        self.assertEqual(set(g.subject_objects(BBQS.posted_by)), set())
        self.assertEqual(objects(g, JOB_SPINE_ORG, "job_type"), {Literal("postdoc")})

    def test_both_refused(self):
        kg, g, said, _ = export(refused={"public_jobs", "public_job_posters"})
        for table in ("public_jobs", "public_job_posters"):
            self.check_skipped(said, kg, table, "HTTP 401 42501")
        self.assertEqual(set(g.subject_objects(BBQS.posted_by)) | set(g.subject_objects(BBQS.job_type)), set())


class ResourceLinks(unittest.TestCase):
    """resource_links (20261116150000; revision_of from 20261117181500): a curated link between two
    nodes, written for a predicate the schema has (RESOURCE_LINK_SLOTS) and only between two nodes."""

    @classmethod
    def setUpClass(cls):
        cls.kg, cls.g, cls.said, cls.fake = export(tables=LINK_TABLES)

    def test_revision_of_and_trained_on_rows_become_links(self):
        self.assertIn("resource_links", self.fake.asked)
        self.assertEqual(objects(self.g, PUBLISHED, "revision_of"), {BID[PREPRINT]})    # the published paper -> its preprint
        self.assertEqual(objects(self.g, PREPRINT, "revision_of"), set())
        self.assertEqual(objects(self.g, MODEL, "trained_on"), {BID[DATASET]})
        self.assertEqual(objects(self.g, BENCHMARK, "evaluates"), {BID[SOFTWARE]})
        self.assertIn("resource_links: 3 written, 3 skipped", self.said)

    def test_an_unknown_predicate_is_skipped(self):
        self.assertEqual(set(self.g.subject_objects(BBQS.uses_software)), set())

    def test_a_row_whose_end_is_not_a_node_is_skipped(self):
        self.assertNotIn((BID[BENCHMARK], BBQS.evaluates, BID[DELETED]), self.g)        # no dangling link
        self.assertEqual(set(self.g.predicate_objects(BID[LEGACY_PROJECT])), set())     # nor a node for a skipped type
        self.assertEqual(set(self.g.subjects(BBQS.produced, BID[DATASET])), set())

    def test_a_missing_table_is_noted_and_the_export_completes(self):
        kg, g, said, _ = export(tables=LINK_TABLES, missing={"resource_links"}, missing_code="PGRST205")
        self.assertEqual(kg.unreadable["resource_links"], "HTTP 404 PGRST205")
        self.assertIn("resource_links not readable (HTTP 404 PGRST205)", said)
        self.assertIn("resource_links: 0 written, 0 skipped", said)
        self.assertEqual(set(g.subject_objects(BBQS.revision_of)) | set(g.subject_objects(BBQS.trained_on)), set())
        self.assertEqual(len(set(g.subjects(RDF.type, BBQS.Job))), 6)                   # the rest is there
        self.assertEqual(objects(g, JOB_SPINE_ORG, "part_of_org"), {BID[ORG_A]})

    def test_an_orcid_with_a_lower_case_x_is_written_with_x_upper_case(self):
        one = URIRef("https://orcid.org/0000-0002-1825-009X")
        self.assertEqual(objects(self.g, PAT, "orcid"), {one})                          # investigators_public.orcid
        self.assertEqual(objects(self.g, PUBLISHED, "author_orcids"), {one})            # publications.author_orcids

    def test_the_round_trip_counts_the_links_as_links(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "bbqs.ttl"
            self.g.serialize(destination=str(path), format="turtle")
            env = {"SUPABASE_URL": "https://stand-in.invalid", "SUPABASE_KEY": "anon-key"}
            with mock.patch("urllib.request.urlopen", FakePostgrest(LINK_TABLES)), mock.patch.dict(os.environ, env), \
                    contextlib.redirect_stderr(io.StringIO()):
                table = RoundTrip(path).table("resource_links")
        self.assertEqual((table["rows"], table["links"], table["carried"]), (6, 6, 3))
        self.assertNotIn("cells", table)                     # links are not fact cells, and add none to the total


class TheQuestionsReadWhatTheExporterWrites(unittest.TestCase):
    """CQ18, CQ35, CQ36 and CQ37 (competency_questions.yaml), asked of what export() writes."""

    @classmethod
    def setUpClass(cls):
        spec = yaml.safe_load((HERE / "competency_questions.yaml").read_text(encoding="utf8"))
        cls.prologue = "".join(f"PREFIX {k}: <{v}>\n" for k, v in spec["prefixes"].items())
        cls.questions = {q["id"]: q for q in spec["questions"]}
        cls.g = export()[1]

    def rows(self, name):
        return sorted(tuple(None if v is None else v.toPython() for v in row)
                      for row in self.g.query(self.prologue + self.questions[name]["sparql"]))

    def test_the_four_need_only_what_anon_may_read(self):
        self.assertEqual({name: self.questions[name]["access"] for name in ("CQ18", "CQ35", "CQ36", "CQ37")},
                         dict.fromkeys(("CQ18", "CQ35", "CQ36", "CQ37"), "anon"))

    def test_cq18_names_the_linked_organization_or_else_the_institution_as_written(self):
        self.assertEqual(self.rows("CQ18"), [("Data engineer", "B INSTITUTE"), ("Lab technician", "Lab of Nowhere"),
                                             ("Postdoc in vision", "UNIVERSITY OF A"),
                                             ("Research scientist", "Elsewhere University")])

    def test_cq35_groups_the_jobs_by_institution(self):
        self.assertEqual(self.rows("CQ35"), [("B INSTITUTE", 1, "Data engineer"), ("Elsewhere University", 1, "Research scientist"),
                                             ("Lab of Nowhere", 1, "Lab technician"), ("UNIVERSITY OF A", 1, "Postdoc in vision")])

    def test_cq36_counts_the_kinds(self):
        self.assertEqual(self.rows("CQ36"), [("engineer", 2), ("phd", 1), ("postdoc", 1), ("research_scientist", 1)])

    def test_cq37_names_who_posted_it(self):
        self.assertEqual(self.rows("CQ37"), [("Postdoc in vision", "Pat Poster")])


if __name__ == "__main__":
    unittest.main(verbosity=1)
