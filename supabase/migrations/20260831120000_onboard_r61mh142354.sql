-- Onboard R61MH142354 (4 MPIs) ahead of NIH RePORTER, on the funder's award notice.
--
-- Source: Lizzy Ankudowich (lizzy.ankudowich@nih.gov, NIMH, BBQS Co-Lead), 2026-08-31, Message-ID
-- <SA1PR09MB122800FA144E57742259D68A798A92@SA1PR09MB12280.namprd09.prod.outlook.com>, plus her
-- same-day reply naming Meister contact PI and giving the title.
--
-- RePORTER returns total=0 for R61MH142354 as of 2026-08-31, so reporter_project_num stays NULL
-- and fiscal_year 2026 is inferred from the award-notice date.
--
-- profile_ids for the link step once 20260826140000 is applied: Meister 1896907, Perona 9852234,
-- Rutishauser 12046862. Yisong Yue has NO NIH PI profile — targeted search returns 0.
--
-- Does not call onboard_member(): auth.uid() is NULL here, and its merge-stub branch still
-- references personality_scores, dropped by 20260826130000.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260831_onboard_r61mh142354');

-- ── 1. The source class ────────────────────────────────────────────────────
-- agent_kind 'human', not 'external_registry': this claim has a named author who can be asked.
INSERT INTO public.source_classes (code, grade, label, agent_kind, is_verified, description)
VALUES ('funder_notice', 1, 'Funder award notice', 'human', true,
        'A named program officer at the funding institute stating an award, its title, or its investigators directly — by email or letter — ahead of the public registry. Same authority as authoritative_registry and often months earlier; a distinct code so claims awaiting RePORTER confirmation stay queryable.')
ON CONFLICT (code) DO NOTHING;

-- ── 2. Let the roster record it ────────────────────────────────────────────
-- Was ('reporter','curator') since 20260508165535; neither is true of a funder notice.
ALTER TABLE public.grant_investigators
  DROP CONSTRAINT IF EXISTS grant_investigators_role_source_check;
ALTER TABLE public.grant_investigators
  ADD CONSTRAINT grant_investigators_role_source_check
  CHECK (role_source IN ('reporter', 'curator', 'funder_notice'));

SELECT public.set_source_class('funder_notice');

-- ── 3. The award ───────────────────────────────────────────────────────────
INSERT INTO public.grants (grant_number, title, fiscal_year)
SELECT 'R61MH142354',
       'Multimodal AI-enabled synchronized neural, physiological, and behavioral recordings in humans during unstructured behavior to study dynamic task control',
       2026
WHERE NOT EXISTS (SELECT 1 FROM public.grants WHERE grant_number = 'R61MH142354');

-- ── 4. The four MPIs ───────────────────────────────────────────────────────
DO $do$
DECLARE
  _grant_id uuid;
  _p        record;
  _inv_id   uuid;
  _stub_id  uuid;
  _name_n   text;
  _seed     jsonb;
  _created  int := 0;
  _matched  int := 0;
BEGIN
  SELECT id INTO _grant_id FROM public.grants WHERE grant_number = 'R61MH142354';

  FOR _p IN
    SELECT * FROM (VALUES
      ('Markus Meister',   'meister@caltech.edu',   'California Institute of Technology', 'contact_pi'),
      ('Pietro Perona',    'perona@caltech.edu',    'California Institute of Technology', 'mpi'),
      ('Ueli Rutishauser', 'rutishauseru@csmc.edu', 'Cedars-Sinai Medical Center',        'mpi'),
      ('Yisong Yue',       'yyue@caltech.edu',      'California Institute of Technology', 'mpi')
    ) AS t(name, email, institution, role)
  LOOP
    _inv_id  := NULL;
    _stub_id := NULL;

    SELECT id INTO _inv_id FROM public.investigators
     WHERE lower(btrim(email)) = _p.email
        OR EXISTS (SELECT 1 FROM unnest(coalesce(secondary_emails, '{}')) s
                    WHERE lower(btrim(s)) = _p.email)
     LIMIT 1;

    -- Email-less RePORTER stub of the same person, by onboard_member's rule.
    _name_n := lower(regexp_replace(btrim(_p.name), '[[:space:]]+', ' ', 'g'));
    SELECT id INTO _stub_id FROM public.investigators
     WHERE (email IS NULL OR btrim(email) = '')
       AND lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = _name_n
       AND (_inv_id IS NULL OR id <> _inv_id)
     LIMIT 1;

    -- Never merge unreviewed.
    IF _inv_id IS NOT NULL AND _stub_id IS NOT NULL THEN
      RAISE EXCEPTION
        '% has BOTH an emailed record (%) and an email-less twin (%). Merge them deliberately first — see 20260826120000 — then re-run.',
        _p.name, _inv_id, _stub_id;
    END IF;

    IF _inv_id IS NULL AND _stub_id IS NOT NULL THEN
      _inv_id := _stub_id;
      UPDATE public.investigators
         SET email       = _p.email,
             institution = coalesce(nullif(btrim(institution), ''), _p.institution),
             role        = coalesce(nullif(btrim(role), ''), 'Principal Investigator (PI)')
       WHERE id = _inv_id;
      RAISE NOTICE 'ADOPTED email-less stub for % -> %', _p.name, _inv_id;
      _matched := _matched + 1;

    ELSIF _inv_id IS NULL THEN
      INSERT INTO public.investigators (name, email, role, institution)
      VALUES (_p.name, _p.email, 'Principal Investigator (PI)', _p.institution)
      RETURNING id INTO _inv_id;
      RAISE NOTICE 'CREATED % -> %', _p.name, _inv_id;
      _created := _created + 1;

    ELSE
      -- Fill only what is empty: role may hold a curated label like "Working Group Chair".
      UPDATE public.investigators
         SET institution = coalesce(nullif(btrim(institution), ''), _p.institution),
             role        = coalesce(nullif(btrim(role), ''), 'Principal Investigator (PI)')
       WHERE id = _inv_id;
      RAISE NOTICE 'MATCHED existing % -> %', _p.name, _inv_id;
      _matched := _matched + 1;
    END IF;

    INSERT INTO public.grant_investigators (grant_id, investigator_id, role, role_source)
    VALUES (_grant_id, _inv_id, _p.role, 'funder_notice')
    ON CONFLICT (grant_id, investigator_id) DO UPDATE
      SET role = EXCLUDED.role, role_source = EXCLUDED.role_source;

    -- consortium_group / pi_group NOT 'done': trg_sync_member_groups is AFTER UPDATE, these are
    -- INSERTs, so no group was provisioned. The Google Group adds are a separate step.
    _seed := jsonb_build_object(
      'pre_check', 'done', 'kg_created', 'done', 'grant_link', 'done',
      'consortium_group', 'not_started', 'pi_group', 'not_started',
      'welcome_email', 'not_started', 'data_questionnaire', 'not_started', 'slack', 'not_started');

    UPDATE public.investigators
       SET onboarding_checklist = coalesce(onboarding_checklist, '{}'::jsonb) || _seed,
           onboarding_completed_at = NULL
     WHERE id = _inv_id;
  END LOOP;

  RAISE NOTICE 'R61MH142354: % created, % already known.', _created, _matched;
END
$do$;

-- ── 5. Verify ──────────────────────────────────────────────────────────────
SELECT g.grant_number, g.fiscal_year, g.reporter_project_num,
       i.name, i.email, i.institution, i.role AS consortium_role,
       gi.role AS roster_role, gi.role_source,
       i.onboarding_checklist
  FROM public.grant_investigators gi
  JOIN public.grants g        ON g.id = gi.grant_id
  JOIN public.investigators i ON i.id = gi.investigator_id
 WHERE g.grant_number = 'R61MH142354'
 ORDER BY (gi.role = 'contact_pi') DESC, i.name;

-- pi@ derives from the roster (#283) — expect all four.
SELECT 'pi_group_eligible' AS check, i.name
  FROM public.grant_investigators gi
  JOIN public.investigators i ON i.id = gi.investigator_id
  JOIN public.grants g        ON g.id = gi.grant_id
 WHERE g.grant_number = 'R61MH142354'
   AND gi.role IN ('PI', 'contact_pi', 'co_pi', 'mpi');
