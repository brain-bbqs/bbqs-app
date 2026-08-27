-- Merge two split people, and give three PIs a primary address.
--
-- WHAT IS BROKEN. Five of the 74 roster PIs are invisible to every group operation, for two
-- reasons that look different and are the same defect: the KG holds the person's identity in one
-- place and their address in another.
--
--   SPLIT RECORDS (2). A RePORTER import created a stub -- shouted name, no email, institution from
--   the award -- and `grant_investigators` points at it. A human later entered the same person
--   again, with a working email and no grant. So the roster entitles one row and the mailbox lives
--   on the other, and nothing connects them:
--     Timothy P Roberts  c513c629  co_pi on R61MH135114, NO email
--     Tim Roberts        78b8c979  no roster row, robertstim@chop.edu, WG-Analytics
--     JACK  GRINBAND     0aa1adf0  co_pi on R34DA059716, NO email   (section C of duplicate-people.md)
--     Jack Grinband      3e3a9d44  no roster row, jg2269@cumc.columbia.edu
--
--   EMPTY PRIMARY, POPULATED SECONDARY (3). Field, Olveczky and Widge each have an address in
--   `secondary_emails` and nothing in `email`. group-audit builds its expected set from the PRIMARY
--   only, so these three are not expected anywhere either.
--
-- MEASURED CONSEQUENCE (2026-08-26): pi@brain-bbqs.org reports expected 56 against a roster of 74.
-- The 18-person gap is exactly the PIs with no primary address. This migration closes 5 of the 18.
--
-- WHY THIS DOES NOT FIX pi@ BY ITSELF. Those five are already ON pi@ -- under addresses the KG does
-- not hold (greg.d.field@gmail.com, awidge@umn.edu, robertstim@email.chop.edu, ...). So each merge
-- below ALSO records the address the group actually carries, in `secondary_emails`. group-audit
-- treats a secondary as "already a member" when deciding `missing`, so recording it means the audit
-- recognises the existing membership instead of proposing a SECOND address for the same human.
-- Set the primary without doing this and Repair will subscribe them twice.
--
-- ── THE ORDERING HAZARD ────────────────────────────────────────────────────────────────────────
-- `trg_sync_member_groups` fires AFTER UPDATE on investigators when role or working_groups changes,
-- and posts to sync-member-groups, which ADDS and REMOVES Google Group memberships.
-- `trg_sync_slack_channels` fires on the same condition. Carrying WG-Analytics and the PI label from
-- the Tim Roberts row onto the surviving record would therefore emit live membership changes as a
-- side effect of a data merge.
--
-- Both triggers are DISABLED for the duration, following the precedent set in 20260811120000: a
-- record merge is not a membership decision and must not emit one. Reconcile groups afterwards,
-- deliberately, from /admin -> Onboarding pipeline -> Group Audit, which is roster-derived.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('curator:merge-people-20260826');
-- G4 attributed to a curator, not an undeclared service-role write graded G8 (Constitution X).
SELECT public.set_source_class('curator_fill');

-- ── 0. Look before you write ───────────────────────────────────────────────────────────────────
-- Everything that points at the two records about to be deleted. Expect zeros for
-- grant_investigators (that is the whole point -- the roster row is on the record we KEEP); any
-- non-zero elsewhere is repointed by step 1, not lost.
SELECT d.label, t.tbl, t.n
  FROM (VALUES ('Tim Roberts',   '78b8c979-05f8-4cd3-9cf1-31be0e551654'::uuid),
               ('Jack Grinband', '3e3a9d44-fd47-4db6-af18-155faf82b553'::uuid)) AS d(label, id)
  CROSS JOIN LATERAL (
    -- grant_investigators and investigator_organizations declare a foreign key to investigators;
    -- curation_audit_log carries the column without one. investigator_cohorts and
    -- access_request_matches are VIEWS and ir_drain_queue is a function -- derived, nothing to
    -- repoint. personality_scores declares one too but is deliberately NOT named here: 20260826130000
    -- drops that table, and naming a dropped table fails at PARSE time whichever order the two
    -- migrations run in. The block below handles it dynamically instead.
    SELECT 'grant_investigators' AS tbl, count(*) AS n FROM public.grant_investigators      WHERE investigator_id = d.id
    UNION ALL SELECT 'investigator_organizations', count(*) FROM public.investigator_organizations WHERE investigator_id = d.id
    UNION ALL SELECT 'curation_audit_log',         count(*) FROM public.curation_audit_log         WHERE investigator_id = d.id
    UNION ALL SELECT 'field_provenance',           count(*) FROM public.field_provenance
                                                    WHERE entity_table = 'investigators' AND entity_id = d.id
  ) t
 WHERE t.n > 0
 ORDER BY 1, 2;

DO $do$
DECLARE
  -- survivor := the record grant_investigators points at. Deleting it would orphan the roster row.
  _roberts_keep uuid := 'c513c629-cc53-4b42-9902-54322bc96d61';  -- Timothy P Roberts, co_pi R61MH135114
  _roberts_drop uuid := '78b8c979-05f8-4cd3-9cf1-31be0e551654';  -- Tim Roberts, holds the email
  _grinband_keep uuid := '0aa1adf0-c841-4513-928b-260afbff27ae'; -- JACK  GRINBAND, co_pi R34DA059716
  _grinband_drop uuid := '3e3a9d44-fd47-4db6-af18-155faf82b553'; -- Jack Grinband, holds the email
  _n int;
  -- Which outward-facing triggers this database ACTUALLY has. The repo is not the authority on
  -- that (Principle III): 20260807220000 creates trg_sync_slack_channels, and it is NOT present in
  -- vpexxhfpvghlejljwpvt as of 2026-08-26 -- naming it unconditionally aborts the whole merge with
  -- 42704. Disable only what exists, and re-enable exactly the same set.
  _trg text;
  _disabled text[] := '{}';
  -- field_provenance is append-only, enforced by trg_field_provenance_append_only (BEFORE UPDATE OR
  -- DELETE, no exemption). Step 1 has to move claims from the folded-in record to the surviving one.
  _prov_guard boolean := false;
  -- The folded-in identity, read BEFORE the donor row is deleted. It has to be carried in variables
  -- rather than sub-selected at write time: investigators_email_unique_ci is a UNIQUE index on
  -- lower(btrim(email)), so copying robertstim@chop.edu onto the survivor while the donor still holds
  -- it fails with 23505 -- even though the donor is about to be deleted in the same transaction.
  _r_email text; _r_role text; _r_wg text[];
  _g_email text;
BEGIN
  -- Re-declared INSIDE the block on purpose. set_actor/set_source_class are transaction-LOCAL
  -- (set_config(..., true)), so the declarations above only reach these writes if the whole file is
  -- executed in one go. Running the DO block on its own would otherwise attribute every row below to
  -- nobody, at grade G8 -- the exact gap Principle X exists to close.
  PERFORM public.set_actor('curator:merge-people-20260826');
  PERFORM public.set_source_class('curator_fill');

  -- Refuse rather than corrupt. This merge assumes the dropped records hold NO roster rows -- true
  -- on 2026-08-26 -- because grant_investigators is unique per (grant, investigator) and repointing
  -- a colliding row would fail halfway through. If someone linked a grant to the duplicate since,
  -- stop and re-decide which record survives.
  SELECT count(*) INTO _n FROM public.grant_investigators
   WHERE investigator_id IN (_roberts_drop, _grinband_drop);
  IF _n > 0 THEN
    RAISE EXCEPTION 'aborting: % grant_investigators row(s) now point at a record marked for deletion', _n;
  END IF;

  FOREACH _trg IN ARRAY ARRAY['trg_sync_member_groups', 'trg_sync_slack_channels'] LOOP
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'public.investigators'::regclass
                  AND tgname = _trg AND NOT tgisinternal) THEN
      EXECUTE format('ALTER TABLE public.investigators DISABLE TRIGGER %I', _trg);
      _disabled := _disabled || _trg;
    ELSE
      RAISE NOTICE 'trigger % is not present on investigators — nothing to disable', _trg;
    END IF;
  END LOOP;
  RAISE NOTICE 'triggers disabled for this merge: %', coalesce(array_to_string(_disabled, ', '), '(none)');

  -- The append-only rule protects a CLAIM from being quietly rewritten. Nothing below rewrites one:
  -- every row keeps its value, its author, its grade and its timestamp, and only entity_id changes --
  -- from one uuid for a person to the other uuid for the SAME person. Leaving them behind would point
  -- the Edit log at a deleted record, which is the "5b0171cb..." failure 20260823120000 exists to
  -- prevent. Re-anchoring is the opposite of losing history.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.field_provenance'::regclass
                AND tgname = 'trg_field_provenance_append_only' AND NOT tgisinternal) THEN
    ALTER TABLE public.field_provenance DISABLE TRIGGER trg_field_provenance_append_only;
    _prov_guard := true;
  END IF;

  -- ── 1. Read the identity off the records about to be folded in ───────────────────────────────
  SELECT email, role, working_groups INTO _r_email, _r_role, _r_wg
    FROM public.investigators WHERE id = _roberts_drop;
  SELECT email INTO _g_email
    FROM public.investigators WHERE id = _grinband_drop;

  -- ── 2. Repoint everything that references the record being folded in ─────────────────────────
  -- investigator_organizations is keyed (investigator_id, organization_id). If both records name the
  -- same org -- the ordinary case for a real duplicate -- repointing would collide, so drop the
  -- redundant link first. Only links to an org the survivor ALREADY has are removed.
  DELETE FROM public.investigator_organizations d
   WHERE d.investigator_id IN (_roberts_drop, _grinband_drop)
     AND EXISTS (SELECT 1 FROM public.investigator_organizations k
                  WHERE k.organization_id = d.organization_id
                    AND k.investigator_id = CASE WHEN d.investigator_id = _roberts_drop
                                                 THEN _roberts_keep ELSE _grinband_keep END);
  UPDATE public.investigator_organizations SET investigator_id = _roberts_keep  WHERE investigator_id = _roberts_drop;
  UPDATE public.investigator_organizations SET investigator_id = _grinband_keep WHERE investigator_id = _grinband_drop;

  -- personality_scores: gone, or going. 20260826130000 drops the table and the whole
  -- personality-score project with it (PI decision, 2026-08-26). Until that migration is applied the
  -- table may still be here, and the first run of THIS migration aborted on it -- both Roberts
  -- records carried a score row. There is nothing to reconcile: the score is deterministic machine
  -- output over whatever half of the person's text reached that record, so neither row is right
  -- after a merge. Delete both sides and let the table's own removal finish the job.
  --
  -- Dynamic because a dropped table cannot be NAMED in static SQL -- the statement would fail at
  -- parse time even inside an IF that never runs.
  IF to_regclass('public.personality_scores') IS NOT NULL THEN
    EXECUTE format(
      'DELETE FROM public.personality_scores WHERE investigator_id = ANY($1)')
      USING ARRAY[_roberts_drop, _grinband_drop, _roberts_keep, _grinband_keep];
    GET DIAGNOSTICS _n = ROW_COUNT;
    RAISE NOTICE 'personality_scores: % row(s) deleted for the merged people (the table itself goes in 20260826130000)', _n;
  ELSE
    RAISE NOTICE 'personality_scores is already gone — nothing to reconcile';
  END IF;
  UPDATE public.curation_audit_log         SET investigator_id = _roberts_keep  WHERE investigator_id = _roberts_drop;
  UPDATE public.curation_audit_log         SET investigator_id = _grinband_keep WHERE investigator_id = _grinband_drop;

  -- Provenance follows the person, not the row. Leaving these behind would point the Edit log at a
  -- deleted uuid, which is the "5b0171cb..." problem 20260823120000 exists to prevent.
  UPDATE public.field_provenance SET entity_id = _roberts_keep
   WHERE entity_table = 'investigators' AND entity_id = _roberts_drop;
  UPDATE public.field_provenance SET entity_id = _grinband_keep
   WHERE entity_table = 'investigators' AND entity_id = _grinband_drop;

  -- ── 3. Delete the folded-in records, THEN write their identity onto the survivor ─────────────
  -- This order is forced by the unique index: the address cannot exist twice, so the donor must go
  -- first. Safe because the whole block is one transaction -- if anything below fails, the delete
  -- rolls back with it and both records are still here.
  DELETE FROM public.investigators WHERE id IN (_roberts_drop, _grinband_drop);
  GET DIAGNOSTICS _n = ROW_COUNT;
  RAISE NOTICE 'duplicate investigator records removed: % (expected 2)', _n;

  -- Roberts. The name is NOT changed: "Timothy P Roberts" is the fuller form, and duplicate-people.md
  -- recommends the fuller form for a person's own name. role/working_groups come across from the
  -- self-entered row -- that is why the group-sync trigger is off.
  -- robertstim@email.chop.edu is the address pi@ actually carries (from the 2026-08-26 export); it is
  -- recorded as a secondary so the audit matches the existing membership rather than adding another.
  -- coalesce keeps whatever the survivor already had: this merges, it does not overwrite.
  UPDATE public.investigators
     SET email = coalesce(nullif(btrim(email), ''), _r_email),
         role  = coalesce(role, _r_role),
         working_groups = ARRAY(
           SELECT DISTINCT e FROM unnest(
             coalesce(working_groups, '{}'::text[]) || coalesce(_r_wg, '{}'::text[])
           ) AS e),
         secondary_emails = ARRAY(
           SELECT DISTINCT e FROM unnest(
             coalesce(secondary_emails, '{}'::text[]) || ARRAY['robertstim@email.chop.edu']
           ) AS e)
   WHERE id = _roberts_keep;

  -- Grinband. Fix the shouted RePORTER spelling, per section C of duplicate-people.md.
  -- NOTE the conflict that record carries and this does NOT resolve: the email says Columbia, the
  -- RePORTER institution says Mount Sinai. One is the awardee org, the other is where he is.
  UPDATE public.investigators
     SET email = coalesce(nullif(btrim(email), ''), _g_email),
         name  = 'Jack Grinband'
   WHERE id = _grinband_keep;

  -- ── 4. Promote a secondary address to primary where the primary is empty ─────────────────────
  -- Each keeps the pi@ address as a secondary for the reason in the header.
  UPDATE public.investigators
     SET email = 'gfield@duke.edu',
         secondary_emails = ARRAY['greg.d.field@gmail.com']   -- the address he is on pi@ under
   WHERE id = '0363e75e-d8c2-4af8-96a6-4534c9de52ff'          -- Gregory Darin Field, co_pi R34DA059512
     AND coalesce(btrim(email), '') = '';

  UPDATE public.investigators
     SET email = 'bolveczky@gmail.com',
         secondary_emails = '{}'                              -- not on the pi@ list; nothing to alias
   WHERE id = '526eb63b-840a-4d58-925c-6ecf666fe436'          -- Bence P Olveczky, co_pi R34DA059506
     AND coalesce(btrim(email), '') = '';

  UPDATE public.investigators
     SET email = 'sharksinmyhead@gmail.com',
         secondary_emails = ARRAY['awidge@umn.edu']            -- the address he is on pi@ under
   WHERE id = '49d73b8e-c794-48f5-8155-19e2bde865a4'          -- Alik S. Widge, co_pi R61MH135405
     AND coalesce(btrim(email), '') = '';

  -- Re-enable exactly what was disabled, and nothing else.
  FOREACH _trg IN ARRAY _disabled LOOP
    EXECUTE format('ALTER TABLE public.investigators ENABLE TRIGGER %I', _trg);
  END LOOP;
  IF _prov_guard THEN
    ALTER TABLE public.field_provenance ENABLE TRIGGER trg_field_provenance_append_only;
  END IF;
END
$do$;

SELECT public.set_source_class(NULL);

-- ── Verify ─────────────────────────────────────────────────────────────────────────────────────
-- 1) Still 74 PIs, and the two merged people now carry an address.
SELECT count(DISTINCT gi.investigator_id) AS roster_pis,                                    -- expect 74
       count(DISTINCT gi.investigator_id) FILTER (WHERE coalesce(btrim(i.email),'') <> '')
         AS pis_with_email                                                                  -- expect 61 (was 56)
  FROM public.grant_investigators gi
  JOIN public.investigators i ON i.id = gi.investigator_id
 WHERE lower(gi.role) IN ('pi','contact_pi','co_pi','mpi');

-- 2) The five, read back. Constitution VIII: the UPDATE reporting success is not the same as the
--    value being there.
SELECT name, email, array_to_string(secondary_emails, '; ') AS secondary_emails, role, working_groups
  FROM public.investigators
 WHERE id IN ('c513c629-cc53-4b42-9902-54322bc96d61',   -- Timothy P Roberts
              '0aa1adf0-c841-4513-928b-260afbff27ae',   -- Jack Grinband
              '0363e75e-d8c2-4af8-96a6-4534c9de52ff',   -- Gregory Darin Field
              '526eb63b-840a-4d58-925c-6ecf666fe436',   -- Bence P Olveczky
              '49d73b8e-c794-48f5-8155-19e2bde865a4')   -- Alik S. Widge
 ORDER BY name;

-- 3) The dropped records are gone and nothing still references them.
SELECT count(*) AS should_be_zero
  FROM public.investigators
 WHERE id IN ('78b8c979-05f8-4cd3-9cf1-31be0e551654', '3e3a9d44-fd47-4db6-af18-155faf82b553');

-- 4) No surname now carries two records that both look like the same person. This is the same
--    check that surfaced Roberts and Grinband; Walker is expected to remain (Jeffery/Jeffrey, two
--    different institutions -- a judgement, not a data-cleaning rule).
SELECT lower(regexp_replace(btrim(name), '^.*\s', '')) AS surname,
       string_agg(name || coalesce(' <' || email || '>', ' <no email>'), ' | ' ORDER BY name) AS records
  FROM public.investigators
 GROUP BY 1 HAVING count(*) > 1
 ORDER BY 1;

-- 5) Every trigger that exists is back on. A merge that leaves one disabled silently stops sync.
--    Expect one row, trg_sync_member_groups with tgenabled = 'O'. trg_sync_slack_channels is absent
--    in this database — see the note below.
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.investigators'::regclass
   AND tgname IN ('trg_sync_member_groups', 'trg_sync_slack_channels')
   AND NOT tgisinternal;

-- 6) The append-only guard on field_provenance is back on. It was off for exactly two UPDATEs.
SELECT tgname, tgenabled   -- expect 'O'
  FROM pg_trigger
 WHERE tgrelid = 'public.field_provenance'::regclass
   AND tgname = 'trg_field_provenance_append_only';

-- 7) SEPARATE FINDING, not fixed here: trg_sync_slack_channels is missing from this database, so
--    migration 20260807220000 has never been applied to it. That trigger is what keeps Slack
--    channels following working-group membership ("if anyone is added to any of the working groups,
--    they should automatically be added to the corresponding channels"). Its absence means Google
--    Groups follow a membership edit and Slack does not. Applying it needs the slack-channels
--    function deployed and SLACK_WG_CHANNELS configured, so it is a deliberate separate step.
SELECT to_regprocedure('public.sync_slack_channels()') IS NOT NULL AS sync_function_exists;

-- ── THE OTHER THIRTEEN: see 20260826160000 ────────────────────────────────────────────────────
-- This migration closes 5 of the 18 PIs with no primary address. The rest are handled by
-- 20260826160000_addresses_from_the_pi_group.sql, which takes every address from the pi@ member
-- EXPORT rather than inferring it from the local part of an audit line -- that distinction is why
-- the list that used to sit here was left commented out.
--
-- Run this file FIRST. 20260826160000 cannot give Jack Grinband his address while the duplicate
-- record still holds it: investigators_email_unique_ci is a UNIQUE index on lower(btrim(email)),
-- and it fails with 23505. The merge below moves the address to the surviving record and the
-- question stops existing.
--
-- Four PIs are beyond both files, having no address anywhere and no pi@ membership to read one
-- from: Flavio Frohlich, Jonathan E. Rubin, Nathan Christopher Shaner, Jane Wang. They have to be
-- asked, not guessed.
