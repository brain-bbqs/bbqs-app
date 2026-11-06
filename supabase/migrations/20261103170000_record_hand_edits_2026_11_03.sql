-- Records the data edits Sulstice made by hand in the SQL editor on 2026-11-03, so a database rebuilt from
-- supabase/migrations (e.g. the sandbox, #474) ends in the same state as production. Each block below is the
-- statement that ran, keyed to the set_actor label it ran under in data_audit_log (#513).
--
-- Idempotent: every write is guarded, so on production (where all of it already ran) this changes nothing.
-- Recorded elsewhere, so NOT repeated here:
--   funding_opportunity_orgs, project_software_tools  -> 20261103130000 / 20261103140000 (#512)
--   Psych-DS as a standard                             -> 20260930120000 / 20260930120100
--   repoint_grant spine sync for BARD.CC (function)    -> 20260930130000; its effect on the row is block 3
--   the duplicate-person merge                         -> 20261106130000 (#514); the interim rename to
--                                                         'Suliman Sharif (alt)' (scrub_sharif_stub_name) is superseded
--   publication full text                              -> 20261103153000 (#505)
-- Not ours (nightly jobs or other sessions that did not name themselves): budget_config, dandisets,
-- the 'unknown' grant_dandisets/profiles/user_roles rows.
SELECT public.set_actor('migration:record_hand_edits_2026_11_03');
SELECT public.set_source_class('curator_fill');

-- 1. replace_patterned_resource_uuids: the two hand-typed a1b2c3d4-... spine ids, re-keyed to the ids
--    production now has. One statement, so the NO ACTION foreign keys are checked only at its end.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.resources WHERE id IN ('a1b2c3d4-0002-4000-8000-000000000001',
                                                         'a1b2c3d4-0004-4000-8000-000000000001')) THEN
    WITH ids(old_id, new_id) AS (VALUES
      ('a1b2c3d4-0002-4000-8000-000000000001'::uuid, 'bcdcd220-fa82-47d4-9c1b-7a8da03dadd8'::uuid),  -- Sima Mofakham
      ('a1b2c3d4-0004-4000-8000-000000000001'::uuid, '80e226a5-f7e6-49d2-a64a-524940d498a5'::uuid)   -- R61MH138612
    ),
    inv AS (UPDATE public.investigators i SET resource_id = ids.new_id FROM ids WHERE i.resource_id = ids.old_id RETURNING i.id),
    gr  AS (UPDATE public.grants g        SET resource_id = ids.new_id FROM ids WHERE g.resource_id = ids.old_id RETURNING g.id),
    pr  AS (UPDATE public.projects p      SET resource_id = ids.new_id FROM ids WHERE p.resource_id = ids.old_id RETURNING p.id)
    UPDATE public.resources r SET id = ids.new_id FROM ids WHERE r.id = ids.old_id;
  END IF;
END $$;

-- 2. project_name_is_grant_number: one convention for project spine names, the grant number.
UPDATE public.resources r SET name = g.grant_number, updated_at = now()
  FROM public.grants g
 WHERE r.id = g.resource_id AND r.name IS DISTINCT FROM g.grant_number;

-- 3. repoint_grant('U24DA064429','U24DA064429'): BARD.CC's spine row carries its current RePORTER link.
UPDATE public.resources r SET external_url = g.nih_link, updated_at = now()
  FROM public.grants g
 WHERE g.grant_number = 'U24DA064429' AND r.id = g.resource_id
   AND r.external_url ~ '^https?://reporter\.nih\.gov/project-details/'
   AND r.external_url IS DISTINCT FROM g.nih_link;

-- 4. fix_malformed_urls: a job with two links in one field keeps the first; an empty job link becomes NULL;
--    a project website holding a sentence keeps the URL inside it, or becomes NULL if it has none.
UPDATE public.resources SET external_url = btrim(split_part(external_url, ';', 1)), updated_at = now()
 WHERE id = 'ca41ad35-92a2-4391-95c3-0db49351b9a5' AND external_url LIKE '%;%';
UPDATE public.resources SET external_url = NULL, updated_at = now()
 WHERE id = '12234308-3c6b-4d75-a135-f8fb127d4389' AND external_url = '';
UPDATE public.projects SET website = substring(website from 'https?://[^\s,;)]+')
 WHERE website IS NOT NULL AND website !~ '^https?://[^\s]+$'
   AND substring(website from 'https?://[^\s,;)]+') IS NOT NULL;
UPDATE public.projects SET website = NULL
 WHERE website IS NOT NULL AND website !~ '^https?://[^\s]+$'
   AND substring(website from 'https?://[^\s,;)]+') IS NULL;

-- 5. The four organizations created by hand (link_jobs_to_organizations, announcement_orgs_bbqs_sfn),
--    each with its resources spine row in the same shape as every other organization.
DO $$
DECLARE _n text; _oid uuid; _rid uuid;
BEGIN
  PERFORM public.set_actor('migration:record_hand_edits_2026_11_03');
  PERFORM public.set_source_class('curator_fill');
  FOREACH _n IN ARRAY ARRAY['MCGILL UNIVERSITY', 'INTERNATIONAL BRAIN LABORATORY', 'BBQS Consortium', 'Society for Neuroscience'] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE lower(btrim(name)) = lower(_n)) THEN
      _oid := gen_random_uuid();
      INSERT INTO public.resources (resource_type, name, metadata)
        VALUES ('organization', _n, jsonb_build_object('source_id', _oid, 'source_table', 'organizations'))
        RETURNING id INTO _rid;
      INSERT INTO public.organizations (id, name, resource_id) VALUES (_oid, _n, _rid);
    END IF;
  END LOOP;
END $$;

-- 6. link_jobs_to_organizations: all 6 jobs, by their institution text.
UPDATE public.jobs j SET organization_id = o.id
  FROM public.organizations o
 WHERE j.organization_id IS NULL AND (
       (btrim(j.institution) LIKE 'International Brain Laboratory%' AND o.name = 'INTERNATIONAL BRAIN LABORATORY')
    OR (btrim(j.institution) = 'McGill University'                  AND o.name = 'MCGILL UNIVERSITY')
    OR (btrim(j.institution) = 'NYU'                                AND o.name = 'NEW YORK UNIVERSITY')
    OR (btrim(j.institution) LIKE 'UC Berkeley%'                    AND o.name = 'UNIVERSITY OF CALIFORNIA BERKELEY'));

-- 7. link_announcements_to_orgs and announcement_orgs_bbqs_sfn: all 12 announcements, by title.
UPDATE public.announcements a SET organization_id = o.id
  FROM public.organizations o
 WHERE a.organization_id IS NULL AND (
       (o.name ILIKE 'National Institutes of Health'
          AND (a.title ILIKE 'BRAIN NeuroAI%' OR a.title ILIKE 'BRAIN Conference%'
               OR a.title ILIKE 'BRAIN Initiative Research Roadmap%' OR a.title ILIKE 'NIH Common Fund PRIMED-AI%'))
    OR (o.name ILIKE 'National Science Foundation' AND a.title ILIKE 'NSF NeuroAI%')
    OR (o.name = 'Society for Neuroscience' AND a.title ILIKE 'SFN Annual Meeting%')
    OR (o.name = 'BBQS Consortium' AND (
          a.title ILIKE 'New BBQS Website%' OR a.title ILIKE 'Consortia-Wide Workshop%'
       OR a.title ILIKE 'Children''s Speech Recognition%' OR a.title ILIKE 'Canada Impact+%'
       OR a.title ILIKE 'In the news:%')));

-- 8. sync_spine_organization_id: the jobs' and announcements' spine rows carry the same organization.
UPDATE public.resources r SET organization_id = j.organization_id, updated_at = now()
  FROM public.jobs j
 WHERE r.id = j.resource_id AND j.organization_id IS NOT NULL AND r.organization_id IS DISTINCT FROM j.organization_id;
UPDATE public.resources r SET organization_id = a.organization_id, updated_at = now()
  FROM public.announcements a
 WHERE r.id = a.resource_id AND a.organization_id IS NOT NULL AND r.organization_id IS DISTINCT FROM a.organization_id;

-- 9. link_people_to_grant_rosters: the high-confidence, roster-backed rows of the curated people list, with the
--    neutral role 'other' (the list gave no roles). 15 of these 26 were new on 11-03; the rest were already on.
INSERT INTO public.grant_investigators (grant_id, investigator_id, role, role_source)
SELECT g.id, v.inv::uuid, 'other', 'curator'
FROM (VALUES
  ('44304438-eaf2-4000-87ab-c83ba00472ca','R61MH138705'),  -- Adam Noah
  ('73263a75-ff7f-4f28-a2bf-0a6c0f121243','R61MH138713'),  -- Alessandra Dallavecchia
  ('58837953-1c21-4dbf-b293-c1cd3ac25354','R61MH135109'),  -- Alireza Kazemi
  ('e333d557-07da-417f-95e2-f10af7553044','R34DA061925'),  -- Álvaro Vega Hidalgo
  ('9cf4bba5-e7cb-4022-b64f-571a7aac913c','U01DA063534'),  -- Brandon Brooks-Patton
  ('aefd64de-51c3-4eda-8ef3-498fd2efed10','R24MH136632'),  -- Darrell De Freitas
  ('2c3ed28e-b458-4ac5-aaff-ae7a319bcbb0','R24MH136632'),  -- Dominique Duncan
  ('0d6dc865-4be5-4eab-917e-baf9b9398fb1','R61MH135114'),  -- Emily Kuschner
  ('fe79ef5c-430e-4129-807d-9628c0cc00d2','R24MH136632'),  -- Erik Johnson
  ('2af1e903-1322-4197-badc-b6f339909370','R34DA061924'),  -- Gabriella Sahyoun
  ('f9013fb9-c001-4921-82d0-925f6928110e','R24MH136632'),  -- Han Yi
  ('a33e0881-43a9-406a-be48-5c59cd411860','R24MH136632'),  -- Jacqueline Boccanfuso
  ('36b4ca07-7ea2-455e-9981-9da6234fcc68','U01MH144347'),  -- Jarl Haggerty
  ('68945c12-1332-4b90-b7ff-98c1403cf078','U01MH143789'),  -- Joel White
  ('1a7e3c30-709b-4017-ae57-f4f7252c9315','R24MH136632'),  -- Joost Wagenaar
  ('5fdfb8bc-8da1-48ea-8287-b5899c639571','R34DA059512'),  -- Joshua Wu
  ('5b42d42e-0023-430c-a8d5-f165d6ce8826','U24DA064429'),  -- Jyl Boline
  ('7b9a90c7-4f4d-4251-923c-8d870842744b','R24MH136632'),  -- Keyvan Ansarino
  ('ceab2082-50e1-4b58-a9b0-3b4967ceaf4e','U24DA064429'),  -- Kris Williams
  ('36d6d77c-635b-42a4-ac1c-d78cc7e2f004','R24MH136632'),  -- Lauren Diaz
  ('a1b5cc89-7a91-4480-9105-012e81fef5ad','R61MH135114'),  -- Lisa Blaskey
  ('89077e82-bc4a-4166-90ce-2ee4771d7ef2','U01DA063534'),  -- Luke Shaw
  ('e6a87f1b-4fea-4450-8125-20943b56760c','R34DA059723'),  -- Mang Gao
  ('e81d9271-49b7-4925-bb78-5b96a5e44b2b','R24MH136632'),  -- Marcia Patchan
  ('7c5deb0d-69ef-4b29-9688-210b9e5f127b','R24MH136632'),  -- Mattson Ogg
  ('719874ac-d2e2-4d8b-886a-a7d83906063d','U24DA064429')   -- Melissa Kline Struhl
) AS v(inv, gn)
JOIN public.grants g ON g.grant_number = v.gn
JOIN public.investigators i ON i.id = v.inv::uuid
ON CONFLICT (grant_id, investigator_id) DO NOTHING;

-- 10. link_datasets_to_grants: the two EMBER datasets, confirmed by a curator.
INSERT INTO public.grant_dandisets (grant_id, dandiset_id, match_source)
SELECT g.id, d.id, 'curator'
  FROM public.grants g
  JOIN public.dandisets d ON d.id IN ('f3d2079c-6655-46e2-8e4d-c4384168f27d', 'b15965c1-d665-4ed6-a084-1ae37536ff01')
 WHERE g.grant_number = 'R24MH136632'
ON CONFLICT DO NOTHING;

-- 11. link_investigators_to_orgs: affiliations where an investigator's institution text names an
--     organization exactly (41 rows on 11-03).
INSERT INTO public.investigator_organizations (investigator_id, organization_id)
SELECT i.id, o.id FROM public.investigators i
  JOIN public.organizations o ON lower(btrim(o.name)) = lower(btrim(i.institution))
 WHERE NOT EXISTS (SELECT 1 FROM public.investigator_organizations io WHERE io.investigator_id = i.id)
ON CONFLICT DO NOTHING;

-- 12. people_small_fixes: delete the 'Jane Doe' test record, fix three institution typos, and give NIH
--     program staff their consortium label where it was empty (4 people on 11-03). The label change fires
--     trg_sync_member_groups (nih@, dcaic-all@, consortium@), as designed for NIH program staff.
DO $$
DECLARE _id constant uuid := '7040e06c-adca-4319-bfa6-d80009b4cfd4'; _res uuid; _u uuid; _n int;
BEGIN
  PERFORM public.set_actor('migration:record_hand_edits_2026_11_03');
  PERFORM public.set_source_class('curator_fill');
  SELECT resource_id, user_id INTO _res, _u FROM public.investigators WHERE id = _id AND name = 'Jane Doe';
  IF NOT FOUND THEN RETURN; END IF;
  IF _u IS NOT NULL THEN RAISE EXCEPTION 'Jane Doe has a login (user_id); check before deleting'; END IF;
  SELECT count(*) INTO _n FROM public.grant_investigators WHERE investigator_id = _id;
  IF _n > 0 THEN RAISE EXCEPTION 'Jane Doe holds % grant link(s); not deleting', _n; END IF;
  DELETE FROM public.investigator_organizations WHERE investigator_id = _id;
  DELETE FROM public.investigators WHERE id = _id;
  IF _res IS NOT NULL THEN DELETE FROM public.resources WHERE id = _res; END IF;
END $$;

UPDATE public.investigators SET institution = 'Stony Brook University', updated_at = now()
 WHERE id = '589278f9-9638-4d92-9b4d-dc10f3f5f0a0' AND institution = 'Sony Brook University';
UPDATE public.investigators SET institution = 'Columbia University', updated_at = now()
 WHERE id = 'c1f28505-ffa5-4873-8ef8-4efee625ae7a' AND institution = 'Columbia Univeristy';
UPDATE public.investigators SET institution = 'Columbia University / Mount Sinai volunteer', updated_at = now()
 WHERE id = '1ff27c7d-e3a6-45a9-9ed4-c577e6a1e572' AND institution = 'Columbia Univerisity / Mount Sanai volunteer';

UPDATE public.investigators SET role = 'NIH program staff', updated_at = now()
 WHERE (role IS NULL OR btrim(role) = '') AND id IN (
  'e26d868f-f252-4306-8def-0023da48868a', '38db2a70-c62c-4c2b-9a61-7a580156039f',
  '754f6bf7-9bc1-47e4-ad68-b47562e0d01f', 'c3c235c0-42ea-4bb0-83fb-d183ab602263',
  '82cab64f-83e0-4467-8d85-6bd5beb4921b', 'b08d83c8-bd53-4e65-a5b7-194aeb8110d7',
  '1e22ec9a-d957-46a7-868e-e1b8f25a901a', 'ea888d2a-5eb1-43fc-af88-891a8b325afd',
  '203fd2b8-7e20-4acd-97f2-0bf787fdfbb3', 'f9f24553-c42a-42c0-bf47-4a394251e1b0',
  '017f3522-7288-4efc-8e32-4ecec7d6d7ed', 'f66e5087-aa21-4f12-b9e6-c25796a7d415',
  '92647fd1-ec09-488c-9dbf-e8f8d06b2df9', '03fb31a2-688f-4168-97a3-f0e20da2d189');

-- 13. Species confirmed by a curator on 11-03 (#429). In production these went through
--     confirm_species_candidate(), which records the evidence quote under the curator's name; a rebuild
--     writes the resulting values directly. R34DA061924's human candidate was added by curator review.
INSERT INTO public.species_candidates (grant_number, candidate, common_name, evidence, confidence, note)
VALUES ('R34DA061924', 'Homo sapiens', 'human',
        'Curator review (2026-11-03): the project covers ferrets and humans interacting socially.',
        'strong', 'Added by curator; not a verbatim abstract quote.')
ON CONFLICT (grant_number, candidate) DO NOTHING;

UPDATE public.projects p SET study_species = v.species, updated_at = now()
  FROM (VALUES
    ('R34DA059500', ARRAY['Danio rerio', 'Drosophila melanogaster']),
    ('R34DA059510', ARRAY['Cichlidae']),
    ('R34DA059512', ARRAY['Mus musculus']),
    ('R34DA059723', ARRAY['Mus musculus']),
    ('R34DA061924', ARRAY['Homo sapiens', 'Mustela putorius furo']),
    ('R34DA062119', ARRAY['Mus musculus']),
    ('U01MH144347', ARRAY['Homo sapiens'])
  ) AS v(grant_number, species)
 WHERE p.grant_number = v.grant_number
   AND (SELECT array_agg(s ORDER BY s) FROM unnest(p.study_species) s) IS DISTINCT FROM v.species;
