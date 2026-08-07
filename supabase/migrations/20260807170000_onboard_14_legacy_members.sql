-- Onboard the legacy form respondents who were never fully created in the KG.
--
-- REVISED after a real 23505 on investigators_name_key: the first version keyed idempotency on
-- EMAIL only, but 5 of these people ALREADY EXIST under a different (or EMPTY) email, and the
-- table has a UNIQUE constraint on name. So they are MERGED, never re-inserted:
--   Dayu Lin, Cristina Savin, John Rogers  -> exist with an EMPTY email (they cannot sign in
--       via Globus until it is set) — the form email becomes their primary email.
--   Darrell De Freitas (ddd@upenn.edu), Joseph Neimat (joseph.neimat@louisville.edu)
--       -> keep their existing primary; the form email is added as a SECONDARY email so both
--          addresses resolve for Globus / mailing lists.
--
-- Mirrors onboard_member (the RPC gates on auth.uid(), which is NULL in the SQL editor).
-- Idempotent and fill-only-empty. Two-step on purpose: trg_sync_member_groups fires on UPDATE,
-- not INSERT, so role/working_groups are set in a later statement to provision Google Groups.

-- ── A. Create the 9 genuinely new people (no role/WGs yet — see note) ───────
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Talia V Roman Lopez', 'taliaroman1@g.ucla.edu', '0000-0001-5038-5445', 'UCLA', ARRAY['talia.viann@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='taliaroman1@g.ucla.edu' OR lower(btrim(name))=lower(btrim('Talia V Roman Lopez')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Arina Knowlton', 'arina.knowlton@nih.gov', NULL, 'NIH/NIMH', ARRAY['akadam1119@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='arina.knowlton@nih.gov' OR lower(btrim(name))=lower(btrim('Arina Knowlton')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Jacqueline Boccanfuso', 'boccanfj@pennmedicine.upenn.edu', '0000-0003-1307-2268', 'University of Pennsylvania, Pennsieve', ARRAY['jacb@sparc.science']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='boccanfj@pennmedicine.upenn.edu' OR lower(btrim(name))=lower(btrim('Jacqueline Boccanfuso')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Brandon Brooks-Patton', 'brandon.brooks-patton@yale.edu', NULL, 'Yale University', '{}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='brandon.brooks-patton@yale.edu' OR lower(btrim(name))=lower(btrim('Brandon Brooks-Patton')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Luke Shaw', 'luke.shaw@yale.edu', '0000-0003-3886-9740', 'Yale University', '{}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='luke.shaw@yale.edu' OR lower(btrim(name))=lower(btrim('Luke Shaw')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Olha Metenko', 'ovm24@drexel.edu', NULL, 'UPenn - Dr. Duncan', ARRAY['olhametenko1123@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='ovm24@drexel.edu' OR lower(btrim(name))=lower(btrim('Olha Metenko')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Dominique Duncan', 'duncan1@upenn.edu', '0000-0002-6154-9262', 'University of Pennsylvania', '{}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='duncan1@upenn.edu' OR lower(btrim(name))=lower(btrim('Dominique Duncan')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Kris Williams', 'ksw5570@psu.edu', NULL, 'Pennsylvania State University', '{}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='ksw5570@psu.edu' OR lower(btrim(name))=lower(btrim('Kris Williams')));
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Keyvan Ansarino', 'ka0002@pennmedicine.upenn.edu', NULL, 'Perelman School of Medicine University of Pennsylvania', ARRAY['kkansarino@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='ka0002@pennmedicine.upenn.edu' OR lower(btrim(name))=lower(btrim('Keyvan Ansarino')));

-- ── B. MERGE the 5 who already exist (fill gaps; never duplicate) ──────────
-- Dayu Lin: had NO email on file -> set it so Globus sign-in works
UPDATE public.investigators SET email='dayu.lin@nyulangone.org' WHERE id='8c409880-03c5-4730-b397-0745b74df42f'::uuid AND coalesce(nullif(btrim(email),''),'')='';
UPDATE public.investigators SET orcid=coalesce(nullif(btrim(orcid),''),'0000-0003-2006-0791'), institution=coalesce(nullif(btrim(institution),''),'NYU Langone Medical Center') WHERE id='8c409880-03c5-4730-b397-0745b74df42f'::uuid;
-- Cristina Savin: had NO email on file -> set it so Globus sign-in works
UPDATE public.investigators SET email='cs5360@nyu.edu' WHERE id='93447677-b9aa-4ee6-8fe7-7d06b1d0c013'::uuid AND coalesce(nullif(btrim(email),''),'')='';
UPDATE public.investigators SET orcid=coalesce(nullif(btrim(orcid),''),'0000-0002-3414-8244'), institution=coalesce(nullif(btrim(institution),''),'NYU') WHERE id='93447677-b9aa-4ee6-8fe7-7d06b1d0c013'::uuid;
-- Darrell De Freitas: keep ddd@upenn.edu as primary, add the form address as secondary
UPDATE public.investigators SET secondary_emails=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(secondary_emails,'{}')||ARRAY['ddd@seas.upenn.edu']) x) WHERE id='aefd64de-51c3-4eda-8ef3-498fd2efed10'::uuid AND NOT ('ddd@seas.upenn.edu' = ANY(coalesce(secondary_emails,'{}')));
UPDATE public.investigators SET orcid=coalesce(nullif(btrim(orcid),''),'0000-0002-3717-3007'), institution=coalesce(nullif(btrim(institution),''),'UPenn / Pennsieve') WHERE id='aefd64de-51c3-4eda-8ef3-498fd2efed10'::uuid;
-- John Rogers: had NO email on file -> set it so Globus sign-in works
UPDATE public.investigators SET email='jrogers@northwestern.edu' WHERE id='50289f42-2f53-4ec2-bd71-8168cb068d42'::uuid AND coalesce(nullif(btrim(email),''),'')='';
UPDATE public.investigators SET orcid=coalesce(nullif(btrim(orcid),''),orcid), institution=coalesce(nullif(btrim(institution),''),'Northwestern University') WHERE id='50289f42-2f53-4ec2-bd71-8168cb068d42'::uuid;
-- Joseph Neimat: keep joseph.neimat@louisville.edu as primary, add the form address as secondary
UPDATE public.investigators SET secondary_emails=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(secondary_emails,'{}')||ARRAY['jneimat@gmail.com']) x) WHERE id='2351859a-8fd0-4933-9223-58ed9f1dedb3'::uuid AND NOT ('jneimat@gmail.com' = ANY(coalesce(secondary_emails,'{}')));
UPDATE public.investigators SET orcid=coalesce(nullif(btrim(orcid),''),orcid), institution=coalesce(nullif(btrim(institution),''),'University of Louisville') WHERE id='2351859a-8fd0-4933-9223-58ed9f1dedb3'::uuid;

-- ── C. Set role + working groups -> fires the Google-Group sync for all 14 ──
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'postdoc'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||'{}'::text[]) x) WHERE lower(email)='taliaroman1@g.ucla.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'nih_program'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||'{}'::text[]) x) WHERE lower(email)='arina.knowlton@nih.gov';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'project_manager'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-ELSI','WG-Standards']::text[]) x) WHERE lower(email)='boccanfj@pennmedicine.upenn.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'postdoc'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||'{}'::text[]) x) WHERE lower(email)='brandon.brooks-patton@yale.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'postdoc'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-Analytics','WG-Devices']::text[]) x) WHERE lower(email)='luke.shaw@yale.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'postdoc'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||'{}'::text[]) x) WHERE lower(email)='ovm24@drexel.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'co-investigator'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-Analytics','WG-ELSI']::text[]) x) WHERE lower(email)='duncan1@upenn.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'postdoc'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-ELSI']::text[]) x) WHERE lower(email)='ksw5570@psu.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'postdoc'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-Analytics']::text[]) x) WHERE lower(email)='ka0002@pennmedicine.upenn.edu';
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'contact_pi'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-Analytics']::text[]) x) WHERE id='8c409880-03c5-4730-b397-0745b74df42f'::uuid;
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'contact_pi'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-Analytics','WG-Standards']::text[]) x) WHERE id='93447677-b9aa-4ee6-8fe7-7d06b1d0c013'::uuid;
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'research_staff'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-Analytics','WG-ELSI']::text[]) x) WHERE id='aefd64de-51c3-4eda-8ef3-498fd2efed10'::uuid;
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'co-investigator'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||'{}'::text[]) x) WHERE id='50289f42-2f53-4ec2-bd71-8168cb068d42'::uuid;
UPDATE public.investigators SET role=coalesce(nullif(btrim(role),''),'contact_pi'), working_groups=(SELECT array_agg(DISTINCT x) FROM unnest(coalesce(working_groups,'{}')||ARRAY['WG-Analytics','WG-Devices']::text[]) x) WHERE id='2351859a-8fd0-4933-9223-58ed9f1dedb3'::uuid;

-- ── D. Link matched consortium grants ───────────────────────────────────────
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '9754ce3a-48c7-41ff-a68c-ae6d36f2e84a'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='taliaroman1@g.ucla.edu' ON CONFLICT DO NOTHING;  -- R61MH138713
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '3ab1c6c5-31b7-4ed2-b14a-868f06669d09'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='brandon.brooks-patton@yale.edu' ON CONFLICT DO NOTHING;  -- 1U01DA063534
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '3ab1c6c5-31b7-4ed2-b14a-868f06669d09'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='luke.shaw@yale.edu' ON CONFLICT DO NOTHING;  -- 1U01DA063534
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'f6f0e459-9673-4f74-af3b-c667884aa729'::uuid, i.id, 'co-investigator' FROM public.investigators i WHERE lower(i.email)='duncan1@upenn.edu' ON CONFLICT DO NOTHING;  -- R24MH136632
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'f959e79e-ab2b-4ba1-b12d-2a34b8e637ca'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='ksw5570@psu.edu' ON CONFLICT DO NOTHING;  -- U24MH136628
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'f6f0e459-9673-4f74-af3b-c667884aa729'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='ka0002@pennmedicine.upenn.edu' ON CONFLICT DO NOTHING;  -- R24MH136632
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'b6b3c609-1bed-4107-9734-5415d14d6737'::uuid, i.id, 'contact_pi' FROM public.investigators i WHERE i.id='8c409880-03c5-4730-b397-0745b74df42f'::uuid ON CONFLICT DO NOTHING;  -- 1U01DA063565
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'b6b3c609-1bed-4107-9734-5415d14d6737'::uuid, i.id, 'contact_pi' FROM public.investigators i WHERE i.id='93447677-b9aa-4ee6-8fe7-7d06b1d0c013'::uuid ON CONFLICT DO NOTHING;  -- 1U01DA063565
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '7e061a35-8f96-4aa2-91a0-2e9da72bdd69'::uuid, i.id, 'co-investigator' FROM public.investigators i WHERE i.id='50289f42-2f53-4ec2-bd71-8168cb068d42'::uuid ON CONFLICT DO NOTHING;  -- 1R61MH138967
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '7e061a35-8f96-4aa2-91a0-2e9da72bdd69'::uuid, i.id, 'contact_pi' FROM public.investigators i WHERE i.id='2351859a-8fd0-4933-9223-58ed9f1dedb3'::uuid ON CONFLICT DO NOTHING;  -- 1R61MH138967

-- ── E. Seed the onboarding checklist (only where absent) ────────────────────
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "grant_link": "done"}'::jsonb) WHERE lower(email)='taliaroman1@g.ucla.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "grant_link": "not_started"}'::jsonb) WHERE lower(email)='arina.knowlton@nih.gov';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "wg_groups": "done", "grant_link": "not_started"}'::jsonb) WHERE lower(email)='boccanfj@pennmedicine.upenn.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "grant_link": "done"}'::jsonb) WHERE lower(email)='brandon.brooks-patton@yale.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "wg_groups": "done", "grant_link": "done"}'::jsonb) WHERE lower(email)='luke.shaw@yale.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "grant_link": "not_started"}'::jsonb) WHERE lower(email)='ovm24@drexel.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb) WHERE lower(email)='duncan1@upenn.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "wg_groups": "done", "grant_link": "done"}'::jsonb) WHERE lower(email)='ksw5570@psu.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "wg_groups": "done", "grant_link": "done"}'::jsonb) WHERE lower(email)='ka0002@pennmedicine.upenn.edu';
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "pi_group": "done", "data_questionnaire": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb) WHERE id='8c409880-03c5-4730-b397-0745b74df42f'::uuid;
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "pi_group": "done", "data_questionnaire": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb) WHERE id='93447677-b9aa-4ee6-8fe7-7d06b1d0c013'::uuid;
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "wg_groups": "done", "grant_link": "not_started"}'::jsonb) WHERE id='aefd64de-51c3-4eda-8ef3-498fd2efed10'::uuid;
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "grant_link": "done"}'::jsonb) WHERE id='50289f42-2f53-4ec2-bd71-8168cb068d42'::uuid;
UPDATE public.investigators SET onboarding_checklist = coalesce(nullif(onboarding_checklist,'{}'::jsonb), '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "pi_group": "done", "data_questionnaire": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb) WHERE id='2351859a-8fd0-4933-9223-58ed9f1dedb3'::uuid;
