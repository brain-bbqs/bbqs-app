-- Give the PIs a consortium role, because nothing else ever will.
--
-- WHAT IS EMPTY. `investigators.role` is the free-text consortium/career label the profile page shows
-- as "Consortium Role". Only two things ever write it: the onboarding form (via onboard_member) and a
-- curator editing a profile. Anyone whose record arrived from the RePORTER import has never been
-- through either, so the field is NULL -- 23 of the 74 roster PIs on 2026-08-26, Satrajit Ghosh among
-- them, which is what surfaced this: his profile reads 57% complete and shows no consortium role
-- while the same page shows "PI · U24MH136628" two sections below.
--
-- THOSE ARE TWO DIFFERENT COLUMNS (issue #283) AND THIS DOES NOT CONFLATE THEM.
--   grant_investigators.role   per-grant, RePORTER-derived, canonical tokens. Untouched here.
--   investigators.role         ONE free-text label about the person. This is what gets filled.
-- The value written is 'Principal Investigator (PI)' -- the exact string the Google Form offers, that
-- 47 people already carry, and that role_label_from_token() maps every PI token to. It is a human
-- label, not a machine token, so it stays on the right side of the #283 line.
--
-- ONLY WHERE EMPTY. A person who has said "Working Group Chair" or "Steering Committee" keeps it. The
-- roster says what they do on a grant; this column says what they are in the consortium, and a PI can
-- be both. Overwriting would be this migration asserting something about someone that they did not.
--
-- ── THE ORDERING HAZARD, AND WHY THE TRIGGER IS OFF ────────────────────────────────────────────
-- `trg_sync_member_groups` fires AFTER UPDATE on investigators.role and posts to sync-member-groups,
-- which ADDS and REMOVES Google Group memberships. pi@ is roster-derived and would not move, but
-- young-investigators@ is derived FROM THIS COLUMN by substring. A PI currently on that list whose
-- role goes from NULL (unclassifiable, therefore never touched) to 'Principal Investigator (PI)'
-- computes as no-longer-entitled -- and the trigger, unlike group-audit, is not additive-only.
--
-- That is exactly the 20260811120000 failure mode: a vocabulary fix emitting outward-facing removals.
-- The trigger is disabled for the update and re-enabled after, and only the triggers that actually
-- exist are touched (trg_sync_slack_channels is absent in this database; naming it aborts with 42704).
-- Reconcile groups afterwards, deliberately, from /admin -> Group Audit.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('curator:backfill-pi-role-20260826');
-- A person deciding that a PI's consortium role is "PI" is a curator fill, not an unattributed
-- service-role write. Constitution X and XI.
SELECT public.set_source_class('curator_fill');

-- ── 0. Who is about to change ──────────────────────────────────────────────────────────────────
-- Read this first. Expect ~23 people, every one of them holding a PI role on the roster and no
-- consortium label at all.
SELECT i.name,
       coalesce(i.email, '(no email)')                          AS email,
       string_agg(DISTINCT gi.role, '; ' ORDER BY gi.role)      AS roster_roles,
       coalesce(array_length(i.working_groups, 1), 0)           AS working_groups
  FROM public.investigators i
  JOIN public.grant_investigators gi ON gi.investigator_id = i.id
 WHERE lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi')
   AND coalesce(btrim(i.role), '') = ''
 GROUP BY i.id, i.name, i.email, i.working_groups
 ORDER BY lower(regexp_replace(btrim(i.name), '^.*\s', ''));

DO $do$
DECLARE
  _n int;
  _trg text;
  _disabled text[] := '{}';
BEGIN
  -- Transaction-local, so re-declared where the writes actually happen. Running the DO block on its
  -- own would attribute every row below to nobody at G8.
  PERFORM public.set_actor('curator:backfill-pi-role-20260826');
  PERFORM public.set_source_class('curator_fill');

  FOREACH _trg IN ARRAY ARRAY['trg_sync_member_groups', 'trg_sync_slack_channels'] LOOP
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'public.investigators'::regclass
                  AND tgname = _trg AND NOT tgisinternal) THEN
      EXECUTE format('ALTER TABLE public.investigators DISABLE TRIGGER %I', _trg);
      _disabled := _disabled || _trg;
    END IF;
  END LOOP;
  RAISE NOTICE 'triggers disabled for this backfill: %', array_to_string(_disabled, ', ');

  UPDATE public.investigators i
     SET role = 'Principal Investigator (PI)'
   WHERE coalesce(btrim(i.role), '') = ''
     AND EXISTS (SELECT 1 FROM public.grant_investigators gi
                  WHERE gi.investigator_id = i.id
                    AND lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi'));
  GET DIAGNOSTICS _n = ROW_COUNT;
  RAISE NOTICE 'consortium role filled for % PI(s)', _n;

  FOREACH _trg IN ARRAY _disabled LOOP
    EXECUTE format('ALTER TABLE public.investigators ENABLE TRIGGER %I', _trg);
  END LOOP;
END
$do$;

SELECT public.set_source_class(NULL);

-- ── Verify ─────────────────────────────────────────────────────────────────────────────────────
-- 1) No roster PI is left without a consortium role. Expect 0.
SELECT count(DISTINCT i.id) AS pis_still_without_a_role
  FROM public.investigators i
  JOIN public.grant_investigators gi ON gi.investigator_id = i.id
 WHERE lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi')
   AND coalesce(btrim(i.role), '') = '';

-- 2) Nothing that already had a label was overwritten. Expect the pre-existing spread to survive:
--    "Principal Investigator (PI)" grows by the backfill count and every other label is unchanged.
SELECT coalesce(nullif(btrim(role), ''), '(empty)') AS consortium_role, count(*) AS people
  FROM public.investigators
 GROUP BY 1 ORDER BY people DESC;

-- 3) The roster is untouched -- this migration must not have moved a single per-grant role.
SELECT lower(role) AS roster_role, count(*)
  FROM public.grant_investigators GROUP BY 1 ORDER BY 2 DESC;

-- 4) The group-sync trigger is back on. Left disabled, every later membership edit silently stops
--    syncing and nothing else would report it.
SELECT tgname, tgenabled   -- expect 'O'
  FROM pg_trigger
 WHERE tgrelid = 'public.investigators'::regclass
   AND tgname IN ('trg_sync_member_groups', 'trg_sync_slack_channels')
   AND NOT tgisinternal;

-- 5) The writes are attributed. Expect curator:backfill-pi-role-20260826 at G4, not "unknown" at G8.
SELECT recorded_by, agent_label, source_class, count(*)
  FROM public.field_provenance
 WHERE entity_table = 'investigators' AND entity_column = 'role'
   AND recorded_at > now() - interval '10 minutes'
 GROUP BY 1, 2, 3;

-- ── AFTERWARDS, BY HAND ────────────────────────────────────────────────────────────────────────
-- Run /admin -> Group Audit. young-investigators@ is derived from the column this migration just
-- filled, so its expected set has changed. The audit is additive-only for that group and will not
-- propose removing anyone; check that it does not want to ADD anyone unexpected either.
