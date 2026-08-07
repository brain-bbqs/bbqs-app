-- Onboard the 14 members who filled the Google Form but were never created in the KG.
--
-- Mirrors onboard_member() exactly (the RPC itself can't be used here: it gates on
-- auth.uid(), which is NULL in the SQL editor). Idempotent: every statement is keyed on email
-- and skips anyone who already exists, so re-running is a no-op.
--
-- TWO-STEP ON PURPOSE: trg_sync_member_groups fires on UPDATE, not INSERT. So each person is
-- INSERTed with role/working_groups empty, then a single UPDATE sets both -- which fires the
-- trigger with old=(null,{}) and provisions ALL their Google Groups (consortium@, the role
-- list, and each wg-*@) in one go. Inserting them complete would silently skip group sync.
--
-- Working groups come from the sheet's authoritative 'Working Groups' tab; roles are mapped to
-- the KG vocabulary; data_questionnaire is seeded for PI roles only.

-- ── 1. Create the records (no role/WGs yet — see the note above) ──────────────
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Dayu Lin', 'dayu.lin@nyulangone.org', '0000-0003-2006-0791', 'NYU Langone Medical Center', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='dayu.lin@nyulangone.org');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Cristina Savin', 'cs5360@nyu.edu', '0000-0002-3414-8244', 'NYU', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='cs5360@nyu.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Talia V Roman Lopez', 'taliaroman1@g.ucla.edu', '0000-0001-5038-5445', 'UCLA', ARRAY['talia.viann@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='taliaroman1@g.ucla.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Arina Knowlton', 'arina.knowlton@nih.gov', NULL, 'NIH/NIMH', ARRAY['akadam1119@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='arina.knowlton@nih.gov');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Jacqueline Boccanfuso', 'boccanfj@pennmedicine.upenn.edu', '0000-0003-1307-2268', 'University of Pennsylvania, Pennsieve', ARRAY['jacb@sparc.science']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='boccanfj@pennmedicine.upenn.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Brandon Brooks-Patton', 'brandon.brooks-patton@yale.edu', NULL, 'Yale University', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='brandon.brooks-patton@yale.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Luke Shaw', 'luke.shaw@yale.edu', '0000-0003-3886-9740', 'Yale University', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='luke.shaw@yale.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Darrell De Freitas', 'ddd@seas.upenn.edu', '0000-0002-3717-3007', 'UPenn / Pennsieve', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='ddd@seas.upenn.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'John Rogers', 'jrogers@northwestern.edu', NULL, 'Northwestern University', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='jrogers@northwestern.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Joseph Neimat', 'jneimat@gmail.com', NULL, 'University of Louisville', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='jneimat@gmail.com');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Olha Metenko', 'ovm24@drexel.edu', NULL, 'UPenn - Dr. Duncan', ARRAY['olhametenko1123@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='ovm24@drexel.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Dominique Duncan', 'duncan1@upenn.edu', '0000-0002-6154-9262', 'University of Pennsylvania', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='duncan1@upenn.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Kris Williams', 'ksw5570@psu.edu', NULL, 'Pennsylvania State University', NULL
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='ksw5570@psu.edu');
INSERT INTO public.investigators (name, email, orcid, institution, secondary_emails)
SELECT 'Keyvan Ansarino', 'ka0002@pennmedicine.upenn.edu', NULL, 'Perelman School of Medicine University of Pennsylvania', ARRAY['kkansarino@gmail.com']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.investigators WHERE lower(email)='ka0002@pennmedicine.upenn.edu');

-- ── 2. Set role + working groups -> fires the Google-Group sync ──────────────
UPDATE public.investigators SET role='contact_pi', working_groups=ARRAY['WG-Analytics']::text[] WHERE lower(email)='dayu.lin@nyulangone.org';
UPDATE public.investigators SET role='contact_pi', working_groups=ARRAY['WG-Analytics','WG-Standards']::text[] WHERE lower(email)='cs5360@nyu.edu';
UPDATE public.investigators SET role='postdoc', working_groups='{}'::text[] WHERE lower(email)='taliaroman1@g.ucla.edu';
UPDATE public.investigators SET role='nih_program', working_groups='{}'::text[] WHERE lower(email)='arina.knowlton@nih.gov';
UPDATE public.investigators SET role='project_manager', working_groups=ARRAY['WG-ELSI','WG-Standards']::text[] WHERE lower(email)='boccanfj@pennmedicine.upenn.edu';
UPDATE public.investigators SET role='postdoc', working_groups='{}'::text[] WHERE lower(email)='brandon.brooks-patton@yale.edu';
UPDATE public.investigators SET role='postdoc', working_groups=ARRAY['WG-Analytics','WG-Devices']::text[] WHERE lower(email)='luke.shaw@yale.edu';
UPDATE public.investigators SET role='research_staff', working_groups=ARRAY['WG-Analytics','WG-ELSI']::text[] WHERE lower(email)='ddd@seas.upenn.edu';
UPDATE public.investigators SET role='co-investigator', working_groups='{}'::text[] WHERE lower(email)='jrogers@northwestern.edu';
UPDATE public.investigators SET role='contact_pi', working_groups=ARRAY['WG-Analytics','WG-Devices']::text[] WHERE lower(email)='jneimat@gmail.com';
UPDATE public.investigators SET role='postdoc', working_groups='{}'::text[] WHERE lower(email)='ovm24@drexel.edu';
UPDATE public.investigators SET role='co-investigator', working_groups=ARRAY['WG-Analytics','WG-ELSI']::text[] WHERE lower(email)='duncan1@upenn.edu';
UPDATE public.investigators SET role='postdoc', working_groups=ARRAY['WG-ELSI']::text[] WHERE lower(email)='ksw5570@psu.edu';
UPDATE public.investigators SET role='postdoc', working_groups=ARRAY['WG-Analytics']::text[] WHERE lower(email)='ka0002@pennmedicine.upenn.edu';

-- ── 3. Link grants that matched a consortium award ───────────────────────────
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'b6b3c609-1bed-4107-9734-5415d14d6737'::uuid, i.id, 'contact_pi' FROM public.investigators i WHERE lower(i.email)='dayu.lin@nyulangone.org'
ON CONFLICT DO NOTHING;   -- 1U01DA063565
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'b6b3c609-1bed-4107-9734-5415d14d6737'::uuid, i.id, 'contact_pi' FROM public.investigators i WHERE lower(i.email)='cs5360@nyu.edu'
ON CONFLICT DO NOTHING;   -- 1U01DA063565
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '9754ce3a-48c7-41ff-a68c-ae6d36f2e84a'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='taliaroman1@g.ucla.edu'
ON CONFLICT DO NOTHING;   -- R61MH138713
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '3ab1c6c5-31b7-4ed2-b14a-868f06669d09'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='brandon.brooks-patton@yale.edu'
ON CONFLICT DO NOTHING;   -- 1U01DA063534
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '3ab1c6c5-31b7-4ed2-b14a-868f06669d09'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='luke.shaw@yale.edu'
ON CONFLICT DO NOTHING;   -- 1U01DA063534
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '7e061a35-8f96-4aa2-91a0-2e9da72bdd69'::uuid, i.id, 'co-investigator' FROM public.investigators i WHERE lower(i.email)='jrogers@northwestern.edu'
ON CONFLICT DO NOTHING;   -- 1R61MH138967
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT '7e061a35-8f96-4aa2-91a0-2e9da72bdd69'::uuid, i.id, 'contact_pi' FROM public.investigators i WHERE lower(i.email)='jneimat@gmail.com'
ON CONFLICT DO NOTHING;   -- 1R61MH138967
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'f6f0e459-9673-4f74-af3b-c667884aa729'::uuid, i.id, 'co-investigator' FROM public.investigators i WHERE lower(i.email)='duncan1@upenn.edu'
ON CONFLICT DO NOTHING;   -- R24MH136632
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'f959e79e-ab2b-4ba1-b12d-2a34b8e637ca'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='ksw5570@psu.edu'
ON CONFLICT DO NOTHING;   -- U24MH136628
INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
SELECT 'f6f0e459-9673-4f74-af3b-c667884aa729'::uuid, i.id, 'postdoc' FROM public.investigators i WHERE lower(i.email)='ka0002@pennmedicine.upenn.edu'
ON CONFLICT DO NOTHING;   -- R24MH136632
-- No consortium grant matched for: arina.knowlton@nih.gov, boccanfj@pennmedicine.upenn.edu, ddd@seas.upenn.edu, ovm24@drexel.edu
--   (their form answers were 'ad hoc via NIMH', EMBER/Pennsieve, or N/A — link later if wrong.)

-- ── 4. Seed the onboarding checklist (same shape onboard_member produces) ────
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "pi_group": "done", "data_questionnaire": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='dayu.lin@nyulangone.org';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "pi_group": "done", "data_questionnaire": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='cs5360@nyu.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='taliaroman1@g.ucla.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "grant_link": "not_started"}'::jsonb WHERE lower(email)='arina.knowlton@nih.gov';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "wg_groups": "done", "grant_link": "not_started"}'::jsonb WHERE lower(email)='boccanfj@pennmedicine.upenn.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='brandon.brooks-patton@yale.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "wg_groups": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='luke.shaw@yale.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "wg_groups": "done", "grant_link": "not_started"}'::jsonb WHERE lower(email)='ddd@seas.upenn.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "grant_link": "done"}'::jsonb WHERE lower(email)='jrogers@northwestern.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "pi_group": "done", "data_questionnaire": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='jneimat@gmail.com';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "grant_link": "not_started"}'::jsonb WHERE lower(email)='ovm24@drexel.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "wg_groups": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='duncan1@upenn.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "wg_groups": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='ksw5570@psu.edu';
UPDATE public.investigators SET onboarding_checklist = '{"pre_check": "done", "kg_created": "done", "consortium_group": "done", "welcome_email": "not_started", "slack": "not_started", "young_investigators_group": "done", "wg_groups": "done", "grant_link": "done"}'::jsonb WHERE lower(email)='ka0002@pennmedicine.upenn.edu';
