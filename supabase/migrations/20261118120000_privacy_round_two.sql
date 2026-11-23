-- ================================================================================================
-- 20261118120000_privacy_round_two.sql
-- SECURITY: anonymous visitors could run 100 of the 107 functions in schema public, among them one
-- that let anyone sign in as a member, one that gave out any member's e-mail address by name, and
-- the provenance maintenance functions that create and drop triggers. Every function now says who
-- may run it. Anon also loses the questionnaire answers no public page shows, and signed-in members
-- lose each other's login ids and pending role requests.
-- ================================================================================================
--
-- ON HOLD (owner, 2026-11-19): DO NOT APPLY. Its first statement stops it before anything runs.
-- A review of this script found faults it still has:
--   * investigator_directory still shows signed-in members each other's user_id;
--   * section 4a re-scopes RESTRICTIVE row-level policies as well as permissive ones;
--   * applied after 20261117181500, the functions that script creates arrive open to anon again;
--   * the gate "no auth.uid() means the service role" is still in the function bodies it keeps;
--   * two of its guards miss cases (a grant back, a JSON-path read).
-- Three of its fixes went ahead separately (#523: the provenance writer and the vote counters), and
-- 20261118100000 closed the account-takeover path. The site does not depend on this script: it reads
-- the public questionnaire keys with a fallback when project_metadata_public is missing
-- (src/lib/projectPublicMetadata.ts). To lift the hold: fix the list above, have it reviewed, then
-- remove the stop below and this notice in the same change (tests/guards/held-migrations holds them
-- together).
--
-- WHY. PostgreSQL grants EXECUTE on every new function to PUBLIC, and Supabase's default privileges
-- grant it to anon and authenticated by name as well, so nothing decided who may call a function.
-- A SECURITY DEFINER function runs as its owner, past row-level security. An audit of every function
-- in public on a replica of this schema (2026-11-18, every migration applied), under SET ROLE anon:
--   record_investigator_alias(primary, alias)  appended any address to a member's secondary_emails
--       (refused only where a verified provenance claim holds that cell, which a record written with
--       no declared source class lacks). Its gate reads "a NULL auth.uid() is the service role", and
--       anon has no uid either. globus-auth (an edge function: read, not run here) lets in an address
--       found among secondary_emails (email_is_consortium_member), resolves it to that member's
--       primary address and signs that in. So anyone could add their own address to an admin's record
--       and sign in as that admin.
--   check_onboard_conflicts(email, name)  the same gate. Given a member's name it returned their
--       e-mail address ('name_conflict'), and given an address, every member address with the same
--       mailbox name ('near_miss_email').
--   provenance_attach_guard / _recorder / _all, provenance_detach_out_of_scope: SECURITY DEFINER and
--       no check, so anon could create and drop triggers on public tables. provenance_backfill_all /
--       _unknown wrote backfill claims. record_field_provenance(13 arguments) wrote any provenance
--       claim at any grade; a claim at a verified grade makes enforce_field_provenance refuse later
--       machine updates of that cell.
--   increment_vote_count / decrement_vote_count  moved any suggestion's vote count, no check, with
--       every trigger switched off (session_replication_role = replica), so nothing was audited.
--   Every other function either refuses anon itself (a has_role check inside) or reveals nothing,
--   but no visitor needs it: admin RPCs, RLS helpers, trigger functions, vocabularies.
-- And two columns:
--   projects.metadata  every questionnaire answer, free text included (help_needed, reuse_challenges,
--       additional_info, primary_storage_details, ...), readable by anon. The public pages show 20 keys.
--   investigators_public.user_id, .pending_role  every member's login id and pending role request,
--       readable by every signed-in member (20261117190000 took them from anon only).
--
-- WHAT.
--   1. Functions. kg_function_access (section 1) gives every function in public one of three tiers:
--        anon           a visitor needs it: anon, authenticated and service_role may run it
--        authenticated  signed-in users, RLS policies or triggers on tables they write need it
--        service        only the owner (migrations, triggers, SECURITY DEFINER callers) and the
--                       service role (edge functions) run it
--      For every overload of each name: REVOKE ALL FROM PUBLIC, anon, authenticated, then GRANT
--      EXECUTE to the tier's roles. An anon-tier function is granted to the three roles by name and
--      keeps PUBLIC. Before taking EXECUTE from a role, the run asks the live catalog what makes that
--      role run the function: an RLS policy (any schema) that applies to it, a view it can read, an
--      index, default, generated column, CHECK or trigger WHEN on a table it can write, an invoker
--      function it keeps (or an invoker trigger on a table it writes) that calls it, an operator,
--      cast or aggregate. If anything does, the role keeps EXECUTE and the report names the object,
--      so an object that exists only in production is never broken. A function this list does not
--      name is left as it is and reported 'not reviewed'.
--   2. The nine admin-only policies that named PUBLIC (system_alerts 2, lovable_invoices 4,
--      publication_figure, publication_fulltext, publication_fulltext_body) now name authenticated.
--      Each is has_role(auth.uid(), 'admin'), false for anon on every row, so anon sees and writes
--      what it did: nothing. Only anon's need to run has_role goes, and with it has_role leaves anon.
--      A policy is re-scoped only if it names PUBLIC alone and each of its expressions is one of
--      those has_role / is_curator_or_admin(auth.uid()) forms.
--   3. project_metadata_public (project_id, grant_number, metadata): metadata holds only the 20 keys
--      the public pages show. The view has its owner's rights, so anon reads it without reading
--      projects.metadata; it shows every project (projects' one read policy is USING (true)); no one
--      may write through it. anon loses SELECT on projects.metadata. Signed-in users keep it: members'
--      and curators' access is unchanged.
--      Why a view and not a STORED generated column: on the replica, a generated column made
--      record_field_provenance record every public key twice on each insert (metadata.<key> and
--      metadata_public.<key>), so provenance_excluded_columns would have had to change too;
--      jsonb_build_object is not IMMUTABLE, so the column needs a custom function that every writer
--      of projects must be allowed to run; and a change to that function would leave every stored
--      row stale until rewritten. The view touches no write path, and a change to its key list is
--      one CREATE OR REPLACE VIEW, live for every row at once.
--   4. investigators_public: authenticated loses user_id and pending_role, column by column (as anon
--      did in 20261117190000), and keeps every other column. The person, curators and admins read
--      both from public.investigators under its RLS.
--
-- WHAT THE AUDIT RESTS ON (each checked on the replica with the literal error):
--   * EXECUTE is not checked when a trigger fires. With EXECUTE revoked from PUBLIC, GoTrue's role
--     inserting into auth.users still ran handle_new_user, auto_link_investigator and
--     grant_default_member_role, and anon's access request still ran log_data_change and
--     notify_new_access_request. So every trigger function is 'service'.
--   * It IS checked, for the role that evaluates it, in an index expression ("permission denied for
--     function kg_fon_key" on a curator's insert into funding_opportunities), in a function an
--     invoker trigger calls ("... normalize_grant_role" on a roster insert), in an RLS policy ("...
--     has_role" for anon reading system_alerts) and in a view ("... kg_award_key" for anon reading a
--     view column it computes). So kg_*_key, normalize_grant_role, canonical_working_group and
--     onboarding_required_open stay with signed-in users, who write those tables.
--
-- KEPT FOR ANON, and why:
--   email_is_consortium_member  src/pages/RequestAccess.tsx asks it before sign-in, to tell a
--       would-be requester they are already registered. IT IS AN ORACLE: it tells anyone whether an
--       address, primary or secondary, is a member's. Least-revealing alternative (not done here: it
--       changes what the form tells a member, so it is the owner's call): the form stops asking;
--       upsert_access_request decides on the server, files nothing for a member's address (so no
--       admin re-approves a member), and every submission gets the same answer: "Request received.
--       If this address is already registered, you need no request: sign in with Globus using it."
--       Then this function is 'service' (globus-auth calls it with the service role).
--   upsert_access_request  the same form's submission, before sign-in. Writes access_requests.
--       Through was_created it tells anyone whether an address already has a pending request, and
--       it lets anyone replace the name, institution, role, message and Globus subject on another
--       address's pending request. Alternative: return nothing to anon (no caller reads the result)
--       and fill only the fields a pending request has left empty.
--   questionnaire_grant_options  scripts/forms/sync-project-dropdowns.gs runs with the anon key.
--       Grant numbers, titles and PI names, all on the public Projects page.
--   search_knowledge_embeddings  the public search and ask tools (bbqs-mcp, bbqs-api, discovery-chat,
--       through _shared/kg.ts and _shared/rag.ts) call it with the anon key when there is no user.
--       It runs as its caller, so knowledge_embeddings' RLS decides what it returns.
--   log_mcp_usage  bbqs-mcp logs an anonymous MCP call under the anon key; it holds no service-role
--       key, by design. One mcp_usage_log row per call; reveals nothing; anyone can add rows.
--   provenance_is_gradable_column, provenance_table_priority, provenance_excluded_columns,
--   provenance_external_identifier_columns, provenance_excluded_tables  constant lists that the
--       views provenance_coverage, provenance_worklist and provenance_guardable_tables call. anon may
--       read those views, and a view's functions run as its reader. No visitor page reads them
--       (DataProvenance shows them signed in only): revoking anon's SELECT on the three views would
--       let these five go to 'authenticated'.
--
-- NO CALLER IN THIS REPOSITORY (src, supabase/functions, kg, scripts, e2e, triggers, policies, views,
-- other functions, cron jobs): increment_vote_count, decrement_vote_count, get_investigator_attention
-- (docs name CognitiveLayer.tsx and CohortHeatmap.tsx, which are gone), ir_drain_queue,
-- ir_upsert_profiles (and ir_is_authorized, which only they call), kg_read_sql, user_owns_resource,
-- provenance_tracked_columns, ai_authored_metadata_keys. ../bbqs-agent may call some of them; one it
-- calls with the anon key fails after this with 42501 "permission denied for function ...".
--
-- READERS of the two columns (checked 2026-11-18). projects.metadata, under anon: GrantSummary (the
-- Summary and Details tabs), GrantMarrSection, useMarrProjects (the Species page and its diagrams)
-- read the 20 keys; they now read project_metadata_public through src/lib/projectPublicMetadata.ts,
-- and show no details, not an error, before this is applied. useProjectProfileEditor reads metadata
-- only signed in (the profile is members only) and refuses to save answers it has not read in full.
-- kg/bbqs_kg.py asked for metadata and writes nothing from it: PUBLIC_COLUMNS no longer names it.
-- _shared/kg.ts, the MCP server (kg/mcp_server.py reads the export) and e2e never read it.
-- investigators_public.user_id / .pending_role: no reader, signed in or not, in src, the edge
-- functions or kg; ownership and pending roles are read from public.investigators.
-- tests/guards/anon-private-columns holds src, kg and later migrations to both lists, and
-- tests/guards/function-execute-grants holds every later migration to say who may run what it creates.
--
-- CHECK FIRST (read-only: what anon and signed-in users can run and read today):
--   SELECT 'function' AS kind, p.oid::regprocedure::text AS object,
--          CASE WHEN p.prosecdef THEN 'security definer' ELSE 'invoker' END AS runs_as,
--          has_function_privilege('anon', p.oid, 'EXECUTE')::text AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE')::text AS signed_in
--     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--   UNION ALL
--   SELECT 'column', v.obj || '.' || v.col, '',
--          has_column_privilege('anon', ('public.' || v.obj)::regclass, v.col, 'SELECT')::text,
--          has_column_privilege('authenticated', ('public.' || v.obj)::regclass, v.col, 'SELECT')::text
--     FROM (VALUES ('projects', 'metadata'), ('investigators_public', 'user_id'),
--                  ('investigators_public', 'pending_role')) v(obj, col)
--   UNION ALL
--   SELECT 'policy', pol.polname || ' on ' || pol.polrelid::regclass::text, 'TO PUBLIC',
--          coalesce(pg_get_expr(pol.polqual, pol.polrelid), ''), coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
--     FROM pg_policy pol
--    WHERE 0 = ANY (pol.polroles)
--      AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
--                     AND d.refobjid = 'public.has_role(uuid, public.app_role)'::regprocedure)
--    ORDER BY 1, 4 DESC, 2;
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt, as its default role (postgres),
-- after 20261117190000. Deploy the site first (the new readers work before and after this), so no
-- visitor page asks for projects.metadata once anon may not read it.
--   Copy it with:  Get-Content "<checkout>\supabase\migrations\20261118120000_privacy_round_two.sql" -Raw | Set-Clipboard
--   (the file is ASCII only, so no code page can garble it), paste the WHOLE file, then Run.
--   1. As shipped it is a DRY RUN: every change is made, the report is shown, then everything is
--      rolled back.
--   2. Read the report (the last statement, the only result the editor shows): the RESULT row, then
--      one row per function, policy and object, with what anon and signed-in users could do before
--      and may do now. 'kept' rows are a role keeping EXECUTE because a live object needs it; read
--      them. 'not reviewed' rows are functions this file does not name (production only): decide
--      their tier in a later migration. Any 'error' row means a real run would change nothing.
--   3. Apply: in the DRY-RUN SWITCH line just below BEGIN, change 'on' to 'off' (the only edit), and
--      Run the whole file again. It is one transaction: it refuses to commit if anon could still run
--      or read what it should not, if anon or signed-in users would lose anything else, or if a
--      function would be denied to a role that a live object needs it for.
--   4. A second run changes nothing: every row says 'unchanged'.
--   LOCKS. ALTER POLICY takes an exclusive lock on system_alerts, lovable_invoices, publication_figure,
--   publication_fulltext and publication_fulltext_body for a moment (first run only). No wait lasts
--   more than 5 s (lock_timeout): the run then fails and changes nothing; run it again.
-- UNDO one function: GRANT EXECUTE ON FUNCTION public.<name>(<arguments>) TO anon (or authenticated).
-- A policy: ALTER POLICY "<name>" ON public.<table> TO public. The columns: GRANT SELECT (metadata) ON
-- public.projects TO anon; GRANT SELECT (user_id, pending_role) ON public.investigators_public TO
-- authenticated. The view can stay; DROP VIEW public.project_metadata_public removes it.
-- ================================================================================================

-- ON HOLD: this statement is first, and it stops the script. Remove it only with the notice above.
DO $hold$
BEGIN
  RAISE EXCEPTION 'privacy_round_two is ON HOLD (owner, 2026-11-19): a review found faults in it, listed in its header, and it must not be applied as written. NOTHING WAS CHANGED.';
END
$hold$;

BEGIN;
-- Principle X: a SQL-editor write has no auth.uid(), so the script names itself before anything else.
SELECT public.set_actor('migration:privacy_round_two');
-- No lock wait longer than 5 s, in the dry run as in the real run (both take the same locks).
SET LOCAL lock_timeout = '5s';

-- +------------------------------ DRY-RUN SWITCH (the one line to edit) ------------------------------+
--   'on'  = rehearse: make every change, show the report, then roll everything back (nothing changes).
--   'off' = apply: the same run, committed.  Any other value is treated as 'on'.
SELECT set_config('bbqs.dry_run', 'on', true);
-- +----------------------------------------------------------------------------------------------------+

-- == 0. Preconditions: stop, changing nothing, on a schema this was not written for ---------------------
DO $guard$
DECLARE
  _have text[];
BEGIN
  IF to_regclass('public.projects') IS NULL OR to_regclass('public.investigators_public') IS NULL
     OR to_regtype('public.app_role') IS NULL THEN
    RAISE EXCEPTION 'public.projects, public.investigators_public or public.app_role is missing: this is not the KG database';
  END IF;
  -- 20261117190000 first: anon reads projects and investigators_public column by column, and the
  -- questionnaire attribution has left metadata for its own columns.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.projects'::regclass
                    AND attname = 'questionnaire_submitted_by' AND NOT attisdropped)
     OR has_table_privilege('anon', 'public.projects', 'SELECT')
     OR has_table_privilege('anon', 'public.investigators_public', 'SELECT') THEN
    RAISE EXCEPTION 'apply 20261117190000_hide_private_columns_from_anon.sql first: nothing changed';
  END IF;
  -- A second run finds the view made by the first. CREATE OR REPLACE VIEW only appends columns (42P16).
  IF to_regclass('public.project_metadata_public') IS NOT NULL THEN
    SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO _have
      FROM pg_attribute a
     WHERE a.attrelid = 'public.project_metadata_public'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    IF _have[1:3] IS DISTINCT FROM ARRAY['project_id', 'grant_number', 'metadata'] THEN
      RAISE EXCEPTION 'public.project_metadata_public exists with the columns (%), not (project_id, grant_number, metadata): nothing changed',
        array_to_string(_have, ', ');
    END IF;
  END IF;
END
$guard$;

-- == 1. The decisions -------------------------------------------------------------------------------------
-- Every function in public, by name (every overload of a name gets its tier): what it does or reveals,
-- and who calls it. tests/guards/function-execute-grants reads this list from this file.
DROP TABLE IF EXISTS pg_temp.kg_function_access;
CREATE TEMP TABLE kg_function_access (fn_name text PRIMARY KEY, tier text NOT NULL
  CHECK (tier IN ('anon', 'authenticated', 'service')), does text NOT NULL, callers text NOT NULL);
INSERT INTO kg_function_access (fn_name, tier, does, callers) VALUES
  -- anon: a visitor needs it (see KEPT FOR ANON in the header)
  ('email_is_consortium_member',  'anon', 'whether an address is a member''s, primary or secondary. AN ORACLE, kept for the request-access form', 'src/pages/RequestAccess.tsx before sign-in; globus-auth (service role); check_onboard_conflicts'),
  ('upsert_access_request',       'anon', 'files or enriches the pending access request of an address; was_created says whether one existed', 'src/pages/RequestAccess.tsx before sign-in'),
  ('questionnaire_grant_options', 'anon', 'grant numbers, titles and PI names, as on the public Projects page', 'scripts/forms/sync-project-dropdowns.gs (anon key)'),
  ('search_knowledge_embeddings', 'anon', 'runs as its caller: the knowledge_embeddings rows its RLS shows, nearest first', '_shared/kg.ts, _shared/rag.ts (bbqs-mcp, bbqs-api, discovery-chat) under the anon key or a user'),
  ('log_mcp_usage',               'anon', 'writes one mcp_usage_log row naming the caller; reveals nothing', 'bbqs-mcp logCall, under the caller''s JWT or the anon key'),
  ('provenance_is_gradable_column', 'anon', 'a constant rule: whether a column is graded', 'views provenance_coverage, provenance_worklist (anon may read them); enforce_field_provenance'),
  ('provenance_table_priority',   'anon', 'a constant table ranking', 'view provenance_worklist'),
  ('provenance_excluded_columns', 'anon', 'a constant list', 'provenance_is_gradable_column; record_field_provenance; provenance_backfill_unknown'),
  ('provenance_external_identifier_columns', 'anon', 'a constant list', 'provenance_is_gradable_column'),
  ('provenance_excluded_tables',  'anon', 'a constant list', 'view provenance_guardable_tables; provenance_detach_out_of_scope'),
  -- authenticated: signed-in users, or what runs on their behalf
  ('admin_get_last_logins',       'authenticated', 'every account''s last sign-in; curators and admins only', 'src/pages/AdminUsers.tsx'),
  ('admin_lookup_user',           'authenticated', 'an account''s e-mail, roles and investigator; admins only', 'bbqs-mcp whois, list_admins, revoke_role'),
  ('ai_authored_metadata_keys',   'authenticated', 'a constant list', 'none found'),
  ('approve_working_groups',      'authenticated', 'writes investigators.working_groups; curators and admins only', 'AdminUsers.tsx, ResolveStageDialog.tsx, WorkingGroupRequestsPanel.tsx'),
  ('canonical_working_group',     'authenticated', 'a working-group spelling to its token', 'trigger normalize_working_groups (runs as the writer of investigators); approve_working_groups; member_self_update'),
  ('check_onboard_conflicts',     'authenticated', 'given an address and a name, the member records they collide with, e-mail addresses included. Its gate let anon through', 'src/components/admin/OnboardMemberDialog.tsx (curators)'),
  ('confirm_species_candidate',   'authenticated', 'writes projects.study_species; curators and admins only', 'bbqs-mcp confirm_species_candidate'),
  ('create_grant',                'authenticated', 'writes grants, projects, organizations and a roster; curators and admins only', 'bbqs-mcp create_grant'),
  ('dismiss_group_audit_entry',   'authenticated', 'writes group_audit_dismissals; curators and admins only', 'src/components/admin/GroupAuditDialog.tsx'),
  ('get_investigator_attention',  'authenticated', 'click and pageview counts per investigator; admins only', 'none found'),
  ('has_role',                    'authenticated', 'whether a login id holds a role', 'RLS policies (to authenticated after section 2); trigger guard_investigator_client_write (as the writer); SECURITY DEFINER functions'),
  ('import_questionnaire_response', 'authenticated', 'writes projects.metadata; curators and admins only', 'bbqs-mcp import_questionnaire_response'),
  ('ir_drain_queue',              'authenticated', 'deletes from internal_research.interactional_queue; admins or the service role', 'none found'),
  ('ir_is_authorized',            'authenticated', 'whether the caller is an admin or the service role', 'ir_drain_queue, ir_upsert_profiles'),
  ('ir_upsert_profiles',          'authenticated', 'writes internal_research.interactional_profiles; admins or the service role', 'none found'),
  ('is_curator_or_admin',         'authenticated', 'whether a login id is a curator or admin', 'RLS policies; triggers guard_investigator_client_write, guard_roster_client_write (as the writer); device-knowledge-seed (service role)'),
  ('jsonb_is_answered',           'authenticated', 'whether a questionnaire value is filled', 'view project_questionnaire_status (signed in); import_questionnaire_response'),
  ('kg_award_key',                'authenticated', 'an award number''s identity key', 'indexes uq_grants_award_key, uq_projects_award_key (run as whoever writes grants and projects)'),
  ('kg_doi_key',                  'authenticated', 'a DOI''s identity key', 'index uq_publications_doi_key (src/pages/Publications.tsx); kg_is_preprint'),
  ('kg_fon_key',                  'authenticated', 'a funding notice''s identity key', 'index uq_funding_opportunities_fon_key (AddFundingOpportunityDialog.tsx)'),
  ('kg_is_preprint',              'authenticated', 'whether a journal and DOI are a preprint''s', 'kg_link_publication_versions'),
  ('kg_name_key',                 'authenticated', 'an organization name''s identity key', 'index uq_organizations_name_key; kg_title_key'),
  ('kg_orcid_key',                'authenticated', 'an ORCID iD''s identity key', 'index uq_investigators_orcid_key (members'' own profile saves)'),
  ('kg_pmid_key',                 'authenticated', 'a PubMed id''s identity key', 'index uq_publications_pmid_key; kg_preprint_is_later'),
  ('kg_preprint_is_later',        'authenticated', 'whether a preprint is later than a paper', 'kg_link_publication_versions'),
  ('kg_read_sql',                 'authenticated', 'one read-only query, run as its caller', 'none found'),
  ('kg_title_key',                'authenticated', 'a title''s identity key', 'kg_link_publication_versions'),
  ('link_investigator_grant',     'authenticated', 'writes grant_investigators; curators and admins only', 'src/components/admin/ResolveGrantLinkDialog.tsx'),
  ('mcp_usage_stats',             'authenticated', 'MCP usage figures; curators and admins only', 'src/components/admin/McpUsagePanel.tsx'),
  ('member_self_update',          'authenticated', 'writes the caller''s own investigators row', 'MemberProfileEditor.tsx; bbqs-mcp update_my_profile'),
  ('normalize_grant_role',        'authenticated', 'a role label to its canonical token', 'trigger trg_normalize_grant_role (runs as the writer of grant_investigators)'),
  ('offboard_member',             'authenticated', 'writes rosters and investigators; curators and admins only', 'OffboardMemberDialog.tsx; bbqs-mcp offboard_member'),
  ('onboard_member',              'authenticated', 'writes investigators and rosters; curators and admins only', 'OnboardMemberDialog.tsx; bbqs-mcp onboard_member; create_grant'),
  ('onboarding_required_open',    'authenticated', 'counts open onboarding steps', 'trigger stamp_onboarding_completed (runs as the writer of investigators)'),
  ('onboarding_status_rank',      'authenticated', 'orders onboarding statuses', 'onboard_member'),
  ('provenance_activity',         'authenticated', 'runs as its caller: the field_provenance rows its RLS shows (staff only)', 'src/pages/DataProvenance.tsx (signed in only)'),
  ('provenance_mark_verified',    'authenticated', 'writes a verified provenance claim; curators and admins only', 'ProvenanceChip.tsx, ProvenanceGrades.tsx'),
  ('provenance_tracked_columns',  'authenticated', 'a constant list', 'none found'),
  ('questionnaire_fields',        'authenticated', 'a constant list', 'view project_questionnaire_status (signed in)'),
  ('questionnaire_form_url',      'authenticated', 'the Data Questionnaire''s respondent link', 'view project_questionnaire_status (signed in)'),
  ('questionnaire_metadata_keys', 'authenticated', 'a constant list', 'import_questionnaire_response'),
  ('questionnaire_responses_url', 'authenticated', 'the form''s responses tab', 'view project_questionnaire_status (signed in)'),
  ('record_onboarding_reminder',  'authenticated', 'writes investigators'' reminder fields; curators and admins only', 'src/components/admin/OnboardingPipelinePanel.tsx'),
  ('repoint_grant',               'authenticated', 'writes grants, projects and resources; curators and admins only', 'bbqs-mcp repoint_grant'),
  ('revert_curation_change',      'authenticated', 'reverts one audited change, if user_can_revert_audit allows', 'src/lib/curation-audit.ts'),
  ('role_label_from_token',       'authenticated', 'a role token to its label', 'onboard_member'),
  ('role_owns_questionnaire',     'authenticated', 'whether a role owns the questionnaire', 'onboard_member'),
  ('set_dandiset_hidden',         'authenticated', 'hides or shows datasets; curators and admins only', 'bbqs-mcp set_dandiset_hidden'),
  ('set_onboarding_step',         'authenticated', 'writes investigators.onboarding_checklist; curators and admins only', 'OnboardMemberDialog.tsx, ResolveStageDialog.tsx; bbqs-mcp; import_questionnaire_response'),
  ('suggest_grants_for_investigator', 'authenticated', 'grant suggestions for an investigator; curators and admins only', 'src/components/admin/ResolveGrantLinkDialog.tsx'),
  ('undismiss_group_audit_entry', 'authenticated', 'deletes group_audit_dismissals; curators and admins only', 'src/components/admin/GroupAuditDialog.tsx'),
  ('user_can_edit_grant_roster',  'authenticated', 'whether a login id may edit a roster', 'RLS policies on grant_investigators'),
  ('user_can_edit_project',       'authenticated', 'whether a login id may edit a project', 'src/hooks/useCanEditProject.ts (signed in only); RLS policy on edit_history; user_can_edit_grant_roster; user_can_revert_audit'),
  ('user_can_revert_audit',       'authenticated', 'whether a login id may revert an audit row', 'revert_curation_change'),
  ('user_owns_investigator',      'authenticated', 'whether a login id owns an investigator record', 'RLS policies on investigators, investigator_organizations'),
  ('user_owns_resource',          'authenticated', 'whether a login id created a resource', 'none found'),
  ('user_shares_grant_with_investigator', 'authenticated', 'whether two people share a grant', 'RLS policies on investigators, investigator_organizations'),
  ('working_group_tokens',        'authenticated', 'a constant list', 'member_self_update'),
  -- service: the owner and the service role only
  ('auto_link_investigator',      'service', 'trigger on auth.users', 'trigger'),
  ('check_publication_fulltext_sha', 'service', 'trigger', 'trigger'),
  ('cron_invoke',                 'service', 'calls an edge function with the vault''s service key', 'pg_cron jobs (run as postgres)'),
  ('current_actor_via',           'service', 'the transaction''s actor label', 'log_data_change, enforce_field_provenance, record_field_provenance (SECURITY DEFINER); kg_link_publication_versions; default of field_provenance.recorded_by'),
  ('current_source_class',        'service', 'the transaction''s source class', 'enforce_field_provenance, record_field_provenance; kg_link_publication_versions'),
  ('decrement_vote_count',        'service', 'moves a suggestion''s vote count with every trigger off; no check', 'none found'),
  ('enforce_feature_votes_immutable', 'service', 'trigger', 'trigger'),
  ('enforce_field_provenance',    'service', 'trigger', 'trigger'),
  ('field_provenance_is_append_only', 'service', 'trigger', 'trigger'),
  ('grant_default_member_role',   'service', 'trigger on auth.users', 'trigger'),
  ('guard_investigator_client_write', 'service', 'trigger', 'trigger'),
  ('guard_roster_client_write',   'service', 'trigger', 'trigger'),
  ('guard_secondary_emails',      'service', 'trigger', 'trigger'),
  ('handle_new_user',             'service', 'trigger on auth.users', 'trigger'),
  ('increment_vote_count',        'service', 'moves a suggestion''s vote count with every trigger off; no check', 'none found'),
  ('keep_questionnaire_attribution_private', 'service', 'trigger', 'trigger'),
  ('kg_link_publication_versions', 'service', 'links preprints to their papers', '_shared/kg-write.ts (import-grant-publications, service role)'),
  ('log_data_change',             'service', 'trigger', 'trigger'),
  ('normalize_grant_role_trg',    'service', 'trigger', 'trigger'),
  ('normalize_working_groups',    'service', 'trigger', 'trigger'),
  ('notify_new_access_request',   'service', 'trigger', 'trigger'),
  ('provenance_attach_all',       'service', 'DDL: attaches the provenance triggers; no check', 'migrations'),
  ('provenance_attach_guard',     'service', 'DDL: creates a trigger on a table; no check', 'provenance_attach_all, provenance_guard_new_tables'),
  ('provenance_attach_recorder',  'service', 'DDL: creates a trigger on a table; no check', 'provenance_attach_all, provenance_guard_new_tables'),
  ('provenance_backfill_all',     'service', 'writes backfill provenance claims; no check', 'migrations'),
  ('provenance_backfill_unknown', 'service', 'writes backfill provenance claims; no check', 'provenance_backfill_all'),
  ('provenance_detach_out_of_scope', 'service', 'DDL: drops provenance triggers; no check', 'migrations'),
  ('provenance_guard_new_tables', 'service', 'event trigger', 'event trigger'),
  ('record_field_provenance',     'service', 'the trigger, and the 13-argument writer: any claim at any grade, no check', 'triggers; confirm_species_candidate, provenance_mark_verified (SECURITY DEFINER)'),
  ('record_investigator_alias',   'service', 'appends an alias to a member''s secondary_emails. Its gate let anon through, and globus-auth signs an alias in as the member', 'group-audit (service role)'),
  ('resource_links_check_types',  'service', 'trigger', 'trigger'),
  ('set_actor',                   'service', 'sets the transaction''s actor label', 'migrations; repoint_grant, import_questionnaire_response (SECURITY DEFINER); kg_link_publication_versions'),
  ('set_source_class',            'service', 'sets the transaction''s source class', 'migrations; create_grant, repoint_grant, import_questionnaire_response, enforce_field_provenance; kg_link_publication_versions'),
  ('source_class_was_declared',   'service', 'whether the transaction declared a source class', 'record_field_provenance'),
  ('stamp_onboarding_completed',  'service', 'trigger', 'trigger'),
  ('stamp_onboarding_started',    'service', 'trigger', 'trigger'),
  ('sync_member_groups',          'service', 'trigger', 'trigger'),
  ('sync_slack_channels',         'service', 'trigger; its migration (20260807220000) never applied, so it exists nowhere yet', 'trigger'),
  ('update_updated_at_column',    'service', 'trigger', 'trigger');

-- What anon must never run, whatever a live object says it needs: a write, DDL or a member's data.
-- A dependency that keeps one of these for anon stops the run (an 'error' row) for a human to look at.
DROP TABLE IF EXISTS pg_temp.kg_never_anon;
CREATE TEMP TABLE kg_never_anon (fn_name text PRIMARY KEY);
INSERT INTO kg_never_anon VALUES
  ('record_investigator_alias'), ('check_onboard_conflicts'), ('record_field_provenance'),
  ('provenance_attach_all'), ('provenance_attach_guard'), ('provenance_attach_recorder'),
  ('provenance_backfill_all'), ('provenance_backfill_unknown'), ('provenance_detach_out_of_scope'),
  ('increment_vote_count'), ('decrement_vote_count');

-- Columns anon may not read, added to 20261117190000's list. tests/guards/anon-private-columns and
-- kg/test_exporter.py read these rows from this file.
DROP TABLE IF EXISTS pg_temp.kg_private_from_anon;
CREATE TEMP TABLE kg_private_from_anon (object_name text, column_name text, holds text);
INSERT INTO kg_private_from_anon (object_name, column_name, holds) VALUES
  ('projects',                   'metadata',                   'every questionnaire answer, free text included (anon reads project_metadata_public)');

-- Columns signed-in users may not read either. tests/guards/anon-private-columns reads these rows.
DROP TABLE IF EXISTS pg_temp.kg_private_from_authenticated;
CREATE TEMP TABLE kg_private_from_authenticated (object_name text, column_name text, holds text);
INSERT INTO kg_private_from_authenticated (object_name, column_name, holds) VALUES
  ('investigators_public',       'user_id',                    'auth user id (the person, curators and admins read it from investigators)'),
  ('investigators_public',       'pending_role',               'a role request awaiting review (the same)');

-- == 2. Before: what each role may do now ------------------------------------------------------------------
DROP TABLE IF EXISTS pg_temp.kg_fn_before;
CREATE TEMP TABLE kg_fn_before AS
SELECT p.oid AS fn_oid, p.proname::text AS fn_name, p.prosecdef AS definer, p.prokind::text AS kind,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_could,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_could,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_could
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace;

DROP TABLE IF EXISTS pg_temp.kg_col_before;
CREATE TEMP TABLE kg_col_before AS
SELECT c.relname::text AS object_name, a.attnum, a.attname::text AS column_name,
       has_column_privilege('anon', c.oid, a.attnum, 'SELECT')          AS anon_could,
       has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT') AS authenticated_could
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname IN ('projects', 'investigators_public', 'project_metadata_public');

DROP TABLE IF EXISTS pg_temp.kg_pol_before;
CREATE TEMP TABLE kg_pol_before AS
SELECT pol.oid AS pol_oid, pol.polrelid::regclass::text AS table_name, pol.polname::text AS policy_name,
       (SELECT string_agg(x.role_name, ', ' ORDER BY x.role_name)
          FROM (SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE r::regrole::text END AS role_name
                  FROM unnest(pol.polroles) r) x) AS roles_before
  FROM pg_policy pol;

-- The plan, one row per reviewed function (filled in section 4).
DROP TABLE IF EXISTS pg_temp.kg_plan;
CREATE TEMP TABLE kg_plan (fn_oid oid PRIMARY KEY, fn_name text, tier text, anon_may boolean,
  authenticated_may boolean, anon_kept_for text, authenticated_kept_for text);

DROP TABLE IF EXISTS pg_temp.kg_report;
CREATE TEMP TABLE kg_report (seq serial, section text, object text, anon_before text, anon_now text,
  signed_in_before text, signed_in_now text, outcome text, detail text);

-- == 3. Helpers (temporary: they go with the session) ------------------------------------------------------
-- Every pg_temp.kg_* function an earlier run left in this editor session goes first: CREATE OR REPLACE
-- keeps an old overload whose arguments differ.
DO $drop$
DECLARE _f text;
BEGIN
  FOR _f IN SELECT format('pg_temp.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
              FROM pg_proc p WHERE p.pronamespace = pg_my_temp_schema() AND p.proname LIKE 'kg\_%'
  LOOP
    EXECUTE 'DROP FUNCTION ' || _f;
  END LOOP;
END
$drop$;

-- A function's signature with every name schema-qualified, whatever the session's search_path.
CREATE FUNCTION pg_temp.kg_sig(_fn oid) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog
AS $fn$ SELECT _fn::regprocedure::text $fn$;

-- Can the role write some row of the table? A privilege, and no row-level security or a permissive
-- INSERT/UPDATE policy that applies to it.
CREATE FUNCTION pg_temp.kg_can_write(_role oid, _rel oid) RETURNS boolean LANGUAGE sql STABLE
AS $fn$
  SELECT (has_any_column_privilege(_role, _rel, 'INSERT') OR has_any_column_privilege(_role, _rel, 'UPDATE'))
     AND (NOT c.relrowsecurity
          OR EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = _rel AND p.polpermissive AND p.polcmd IN ('a', 'w', '*')
                        AND (0 = ANY (p.polroles) OR _role = ANY (p.polroles))))
    FROM pg_class c WHERE c.oid = _rel
$fn$;

-- Will the role be able to run the function after this run? The plan for a reviewed one, the live
-- privilege for any other.
CREATE FUNCTION pg_temp.kg_will_execute(_fn oid, _role text) RETURNS boolean LANGUAGE sql STABLE
AS $fn$
  SELECT coalesce((SELECT CASE _role WHEN 'anon' THEN p.anon_may ELSE p.authenticated_may END
                     FROM pg_temp.kg_plan p WHERE p.fn_oid = _fn),
                  has_function_privilege(_role, _fn, 'EXECUTE'))
$fn$;

-- What in the live database makes the role run the function, or NULL. The rules this checks are in the
-- header (WHAT THE AUDIT RESTS ON); a trigger function's own EXECUTE is never checked, so a trigger is
-- not a reason, but what an invoker trigger function calls is.
CREATE FUNCTION pg_temp.kg_needs(_fn oid, _role text) RETURNS text LANGUAGE plpgsql STABLE
AS $fn$
DECLARE
  _r    oid  := to_regrole(_role);
  _name text := (SELECT proname FROM pg_proc WHERE oid = _fn);
  _hit  text;
BEGIN
  -- a row-level security policy, in any schema, that applies to the role and calls it
  SELECT format('policy %s on %s', pol.polname, pol.polrelid::regclass) INTO _hit
    FROM pg_depend d
    JOIN pg_policy pol ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
   WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn
     AND (0 = ANY (pol.polroles) OR _r = ANY (pol.polroles))
   ORDER BY 1 LIMIT 1;
  IF _hit IS NOT NULL THEN RETURN _hit; END IF;

  -- a view the role can read that calls it, itself or through the views it reads
  WITH RECURSIVE v(rel) AS (
    SELECT rw.ev_class
      FROM pg_depend d JOIN pg_rewrite rw ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn
    UNION
    SELECT rw.ev_class
      FROM v
      JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = v.rel
      JOIN pg_rewrite rw ON rw.oid = d.objid
     WHERE rw.ev_class <> v.rel
  )
  SELECT format('view %s', c.oid::regclass) INTO _hit
    FROM v JOIN pg_class c ON c.oid = v.rel
   WHERE c.relkind = 'v' AND has_any_column_privilege(_r, c.oid, 'SELECT')
   ORDER BY 1 LIMIT 1;
  IF _hit IS NOT NULL THEN RETURN _hit; END IF;

  -- an expression on a table the role can write: index, default or generated value, CHECK, trigger WHEN, rule
  SELECT x.what INTO _hit FROM (
    SELECT format('index %s on %s', i.indexrelid::regclass, i.indrelid::regclass) AS what, i.indrelid AS rel
      FROM pg_depend d JOIN pg_index i ON d.classid = 'pg_class'::regclass AND d.objid = i.indexrelid
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn
    UNION ALL
    SELECT format('%s of %s.%s', CASE WHEN a.attgenerated = 's' THEN 'generated value' ELSE 'default' END,
                  ad.adrelid::regclass, a.attname), ad.adrelid
      FROM pg_depend d JOIN pg_attrdef ad ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn
    UNION ALL
    SELECT format('constraint %s on %s', con.conname, con.conrelid::regclass), con.conrelid
      FROM pg_depend d JOIN pg_constraint con ON d.classid = 'pg_constraint'::regclass AND d.objid = con.oid
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn AND con.conrelid <> 0
    UNION ALL
    SELECT format('trigger %s on %s (its WHEN)', t.tgname, t.tgrelid::regclass), t.tgrelid
      FROM pg_depend d JOIN pg_trigger t ON d.classid = 'pg_trigger'::regclass AND d.objid = t.oid
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn AND t.tgfoid <> _fn
    UNION ALL
    SELECT format('rule %s on %s', rw.rulename, rw.ev_class::regclass), rw.ev_class
      FROM pg_depend d JOIN pg_rewrite rw ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
      JOIN pg_class c ON c.oid = rw.ev_class
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn AND c.relkind IN ('r', 'p')
  ) x
   WHERE pg_temp.kg_can_write(_r, x.rel)
   ORDER BY 1 LIMIT 1;
  IF _hit IS NOT NULL THEN RETURN _hit; END IF;

  -- a domain's CHECK, an operator, a cast or an aggregate: whoever uses it runs the function
  SELECT x.what INTO _hit FROM (
    SELECT format('constraint %s on domain %s', con.conname, con.contypid::regtype) AS what
      FROM pg_depend d JOIN pg_constraint con ON d.classid = 'pg_constraint'::regclass AND d.objid = con.oid
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn AND con.contypid <> 0
    UNION ALL SELECT format('operator %s', o.oid::regoperator) FROM pg_operator o WHERE o.oprcode = _fn
    UNION ALL SELECT format('cast %s to %s', format_type(k.castsource, NULL), format_type(k.casttarget, NULL))
                FROM pg_cast k WHERE k.castfunc = _fn
    UNION ALL SELECT format('aggregate %s', g.aggfnoid::regprocedure) FROM pg_aggregate g
               WHERE _fn IN (g.aggtransfn, g.aggfinalfn, g.aggcombinefn, g.aggmtransfn, g.aggminvtransfn, g.aggmfinalfn)
  ) x ORDER BY 1 LIMIT 1;
  IF _hit IS NOT NULL THEN RETURN _hit; END IF;

  -- an invoker function whose body calls it, and that the role runs: one it may still execute, or a
  -- trigger function on a table it can write
  SELECT format('%s calls it as its caller', g.oid::regprocedure) INTO _hit
    FROM pg_proc g
   WHERE NOT g.prosecdef AND g.oid <> _fn
     AND g.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
     AND g.pronamespace <> pg_my_temp_schema()
     AND (g.prosrc ~ ('(^|[^[:alnum:]_.])(public\.)?' || _name || '[[:space:]]*\(')
          OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = g.oid
                        AND d.refclassid = 'pg_proc'::regclass AND d.refobjid = _fn))
     AND ((g.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
           AND pg_temp.kg_will_execute(g.oid, _role))
          OR EXISTS (SELECT 1 FROM pg_trigger t
                      WHERE t.tgfoid = g.oid AND NOT t.tgisinternal AND pg_temp.kg_can_write(_r, t.tgrelid)))
   ORDER BY 1 LIMIT 1;
  RETURN _hit;
END
$fn$;

-- == 4. The run: every change, the checks, the report; rolled back as a whole in a dry run ---------------
DO $kg$
DECLARE
  _dry      boolean := coalesce(current_setting('bbqs.dry_run', true), 'on') <> 'off';
  _keep     pg_temp.kg_report[];
  _errs     int := 0;
  _list     text;
  _r        record;
  _why      text;
  _changed  int;
  _grantees text;
  _rel      regclass;
  _all      text;
  _keepcols text;
  _q        text;
  _w        text;
  _ok       text := '^\(*(public\.)?(has_role\(auth\.uid\(\), ''(admin|curator|member)''::(public\.)?app_role\)'
                    || '|is_curator_or_admin\(auth\.uid\(\)\))\)*$';
BEGIN
  BEGIN
    -- 4a. The admin-only policies that named PUBLIC name authenticated: never true for anon.
    FOR _r IN
      SELECT pol.oid, pol.polname, pol.polrelid::regclass AS tbl,
             pg_get_expr(pol.polqual, pol.polrelid) AS q, pg_get_expr(pol.polwithcheck, pol.polrelid) AS w
        FROM pg_policy pol
       WHERE pol.polroles = ARRAY[0::oid]
         AND (pol.polqual IS NOT NULL OR pol.polwithcheck IS NOT NULL)
       ORDER BY 3, 2
    LOOP
      _q := coalesce(_r.q, '');
      _w := coalesce(_r.w, '');
      CONTINUE WHEN NOT ((_q = '' OR _q ~ _ok) AND (_w = '' OR _w ~ _ok));
      BEGIN
        EXECUTE format('ALTER POLICY %I ON %s TO authenticated', _r.polname, _r.tbl);
        INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
        VALUES ('2 policy', format('%s on %s', _r.polname, _r.tbl), 'evaluated (never true)', 'not evaluated',
                'evaluated', 'evaluated', 'changed',
                format('TO PUBLIC -> TO authenticated. %s', concat_ws(' / ', nullif(_q, ''), nullif(_w, ''))));
      EXCEPTION WHEN insufficient_privilege THEN
        -- Not the table's owner: the policy keeps PUBLIC, so the plan below keeps has_role for anon.
        INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
        VALUES ('2 policy', format('%s on %s', _r.polname, _r.tbl), 'evaluated', 'evaluated', 'evaluated', 'evaluated',
                'kept', 'could not re-scope it (' || SQLERRM || '): it keeps PUBLIC, and anon keeps what it calls');
      END;
    END LOOP;

    -- 4b. The plan: the tier, then what the live catalog says each role needs, until nothing changes.
    INSERT INTO pg_temp.kg_plan (fn_oid, fn_name, tier, anon_may, authenticated_may)
    SELECT b.fn_oid, b.fn_name, a.tier, a.tier = 'anon', a.tier IN ('anon', 'authenticated')
      FROM pg_temp.kg_fn_before b JOIN pg_temp.kg_function_access a ON a.fn_name = b.fn_name
     WHERE b.kind IN ('f', 'p');
    LOOP
      _changed := 0;
      FOR _r IN SELECT fn_oid FROM pg_temp.kg_plan WHERE NOT authenticated_may LOOP
        _why := pg_temp.kg_needs(_r.fn_oid, 'authenticated');
        IF _why IS NOT NULL THEN
          UPDATE pg_temp.kg_plan SET authenticated_may = true, authenticated_kept_for = _why WHERE fn_oid = _r.fn_oid;
          _changed := _changed + 1;
        END IF;
      END LOOP;
      FOR _r IN SELECT fn_oid FROM pg_temp.kg_plan WHERE NOT anon_may LOOP
        _why := pg_temp.kg_needs(_r.fn_oid, 'anon');
        IF _why IS NOT NULL THEN
          -- what a visitor may run, a signed-in user may run
          UPDATE pg_temp.kg_plan SET anon_may = true, anon_kept_for = _why,
                 authenticated_may = true, authenticated_kept_for = coalesce(authenticated_kept_for, _why)
           WHERE fn_oid = _r.fn_oid;
          _changed := _changed + 1;
        END IF;
      END LOOP;
      EXIT WHEN _changed = 0;
    END LOOP;

    -- 4c. The grants. PUBLIC goes from every function a visitor does not need: anon holds what PUBLIC holds.
    FOR _r IN SELECT p.*, pg_temp.kg_sig(p.fn_oid) AS sig, b.kind
                FROM pg_temp.kg_plan p JOIN pg_temp.kg_fn_before b USING (fn_oid) ORDER BY p.fn_name, sig LOOP
      _grantees := concat_ws(', ', CASE WHEN _r.anon_may THEN 'anon' END,
                             CASE WHEN _r.authenticated_may THEN 'authenticated' END, 'service_role');
      IF _r.tier = 'anon' THEN
        EXECUTE format('GRANT EXECUTE ON %s %s TO %s',
                       CASE WHEN _r.kind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, _r.sig, _grantees);
      ELSE
        EXECUTE format('REVOKE ALL ON %s %s FROM PUBLIC, anon, authenticated',
                       CASE WHEN _r.kind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, _r.sig);
        EXECUTE format('GRANT EXECUTE ON %s %s TO %s',
                       CASE WHEN _r.kind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, _r.sig, _grantees);
      END IF;
    END LOOP;

    -- 4d. The public questionnaire keys: the 20 the public pages show (READERS, in the header). A key is
    --     added here when a public page starts to show it (tests/guards/anon-private-columns checks).
    CREATE OR REPLACE VIEW public.project_metadata_public
    WITH (security_invoker = false)
    AS
    SELECT p.id AS project_id,
           p.grant_number,
           (SELECT jsonb_object_agg(e.key,
                     CASE WHEN e.key <> 'devices' THEN e.value
                          WHEN jsonb_typeof(e.value) = 'object' THEN
                            coalesce((SELECT jsonb_object_agg(d.key, d.value)
                                        FROM jsonb_each(e.value) AS d(key, value)
                                       WHERE d.key IN ('sensor', 'data_acquisition_modalities',
                                                       'behavioral_rigs', 'electrophysiology_setup')),
                                     '{}'::jsonb)
                     END)
              FROM jsonb_each(CASE WHEN jsonb_typeof(p.metadata) = 'object' THEN p.metadata END) AS e(key, value)
             WHERE e.key IN ('use_approaches', 'marr_l1_ethological_goal', 'marr_l2_algorithmic_function',
                             'marr_l3_implementational_hardware', 'cross_project_synergy',
                             'data_analysis_approach', 'target_species_domain', 'agentic_action_required',
                             'experimental_approaches', 'data_modalities', 'data_type', 'analysis_types',
                             'analysis_methods', 'software_tools_used', 'produce_data_modality',
                             'produce_data_type', 'use_analysis_types', 'use_analysis_method',
                             'develope_software_type', 'devices')) AS metadata
      FROM public.projects p;

    COMMENT ON VIEW public.project_metadata_public IS
      'The questionnaire answers a visitor may read: the keys of projects.metadata the public pages show (GrantSummary, GrantMarrSection, useMarrProjects). Owner''s rights, so anon reads it without projects.metadata, which only signed-in users may read (20261118120000). Every project, as projects'' read policy shows them. Read only.';

    -- Nobody writes through it; anon and signed-in users read it.
    REVOKE ALL ON public.project_metadata_public FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT ON public.project_metadata_public TO anon, authenticated, service_role;

    -- 4e. Column grants: anon loses projects.metadata, authenticated loses investigators_public.user_id and
    --     .pending_role, and each keeps every other column it could read.
    FOR _r IN
      SELECT x.role_name, x.object_name, array_agg(x.column_name) AS private
        FROM (SELECT 'anon' AS role_name, object_name, column_name FROM pg_temp.kg_private_from_anon
              UNION ALL
              SELECT 'authenticated', object_name, column_name FROM pg_temp.kg_private_from_authenticated) x
       GROUP BY 1, 2 ORDER BY 1, 2
    LOOP
      _rel := to_regclass(format('public.%I', _r.object_name));
      CONTINUE WHEN _rel IS NULL;
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
             string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
               FILTER (WHERE NOT (a.attname::text = ANY (_r.private))
                         AND has_column_privilege(_r.role_name, _rel, a.attnum, 'SELECT'))
        INTO _all, _keepcols
        FROM pg_attribute a
       WHERE a.attrelid = _rel AND a.attnum > 0 AND NOT a.attisdropped;
      -- PUBLIC too: every role holds what PUBLIC holds.
      EXECUTE format('REVOKE SELECT ON %s FROM %I, PUBLIC', _rel, _r.role_name);
      EXECUTE format('REVOKE SELECT (%s) ON %s FROM %I, PUBLIC', _all, _rel, _r.role_name);
      IF _keepcols IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON %s TO %I', _keepcols, _rel, _r.role_name);
      END IF;
    END LOOP;

    -- 4f. The checks. Each failure is an 'error' row: a real run then commits nothing.
    -- Every reviewed function: each role may run it exactly as planned, and the service role always.
    INSERT INTO pg_temp.kg_report (section, object, outcome, detail)
    SELECT '1 function', pg_temp.kg_sig(p.fn_oid), 'error',
           format('planned anon %s / signed-in %s, but anon %s / signed-in %s / service_role %s',
                  p.anon_may, p.authenticated_may, has_function_privilege('anon', p.fn_oid, 'EXECUTE'),
                  has_function_privilege('authenticated', p.fn_oid, 'EXECUTE'),
                  has_function_privilege('service_role', p.fn_oid, 'EXECUTE'))
      FROM pg_temp.kg_plan p
     WHERE has_function_privilege('anon', p.fn_oid, 'EXECUTE') IS DISTINCT FROM p.anon_may
        OR has_function_privilege('authenticated', p.fn_oid, 'EXECUTE') IS DISTINCT FROM p.authenticated_may
        OR NOT has_function_privilege('service_role', p.fn_oid, 'EXECUTE');
    -- What anon must never run, whatever a live object needs.
    INSERT INTO pg_temp.kg_report (section, object, outcome, detail)
    SELECT '1 function', pg_temp.kg_sig(p.fn_oid), 'error',
           format('anon would keep it because %s: anon must not run this; decide that object first', p.anon_kept_for)
      FROM pg_temp.kg_plan p JOIN pg_temp.kg_never_anon n USING (fn_name)
     WHERE p.anon_may;
    -- The private columns.
    INSERT INTO pg_temp.kg_report (section, object, outcome, detail)
    SELECT '3 column', x.object_name || '.' || x.column_name, 'error', x.role_name || ' could still read it'
      FROM (SELECT 'anon' AS role_name, object_name, column_name FROM pg_temp.kg_private_from_anon
            UNION ALL
            SELECT 'authenticated', object_name, column_name FROM pg_temp.kg_private_from_authenticated) x
     WHERE has_column_privilege(x.role_name, to_regclass(format('public.%I', x.object_name)), x.column_name, 'SELECT');
    -- Every other column of these objects: each role reads it exactly as before.
    INSERT INTO pg_temp.kg_report (section, object, outcome, detail)
    SELECT '3 column', b.object_name || '.' || b.column_name, 'error', concat_ws('; ',
             CASE WHEN b.anon_could IS DISTINCT FROM has_column_privilege('anon', to_regclass('public.' || b.object_name), b.column_name, 'SELECT')
                  THEN 'anon would ' || CASE WHEN b.anon_could THEN 'lose' ELSE 'gain' END || ' it' END,
             CASE WHEN b.authenticated_could IS DISTINCT FROM has_column_privilege('authenticated', to_regclass('public.' || b.object_name), b.column_name, 'SELECT')
                  THEN 'signed-in users would ' || CASE WHEN b.authenticated_could THEN 'lose' ELSE 'gain' END || ' it' END)
      FROM pg_temp.kg_col_before b
     WHERE b.object_name <> 'project_metadata_public'
       AND NOT EXISTS (SELECT 1 FROM pg_temp.kg_private_from_anon p WHERE p.object_name = b.object_name AND p.column_name = b.column_name)
       AND NOT EXISTS (SELECT 1 FROM pg_temp.kg_private_from_authenticated p WHERE p.object_name = b.object_name AND p.column_name = b.column_name)
       AND (b.anon_could IS DISTINCT FROM has_column_privilege('anon', to_regclass('public.' || b.object_name), b.column_name, 'SELECT')
            OR b.authenticated_could IS DISTINCT FROM has_column_privilege('authenticated', to_regclass('public.' || b.object_name), b.column_name, 'SELECT'));
    -- Signed-in users still read every answer; the hidden columns still exist for those who read them.
    IF NOT has_column_privilege('authenticated', 'public.projects', 'metadata', 'SELECT') THEN
      INSERT INTO pg_temp.kg_report (section, object, outcome, detail)
      VALUES ('3 column', 'projects.metadata', 'error', 'signed-in users could not read it');
    END IF;
    -- The view: anon and signed-in users read it, nobody writes through it.
    IF NOT (has_table_privilege('anon', 'public.project_metadata_public', 'SELECT')
            AND has_table_privilege('authenticated', 'public.project_metadata_public', 'SELECT'))
       OR has_table_privilege('anon', 'public.project_metadata_public', 'INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('authenticated', 'public.project_metadata_public', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      INSERT INTO pg_temp.kg_report (section, object, outcome, detail)
      VALUES ('4 view', 'project_metadata_public', 'error', 'anon and signed-in users must read it and write nothing through it');
    END IF;

    -- 4g. The report rows.
    -- One per reviewed function.
    INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
    SELECT '1 function', pg_temp.kg_sig(p.fn_oid),
           CASE WHEN b.anon_could THEN 'may run' ELSE 'no' END,
           CASE WHEN has_function_privilege('anon', p.fn_oid, 'EXECUTE') THEN 'may run' ELSE 'no' END,
           CASE WHEN b.authenticated_could THEN 'may run' ELSE 'no' END,
           CASE WHEN has_function_privilege('authenticated', p.fn_oid, 'EXECUTE') THEN 'may run' ELSE 'no' END,
           CASE WHEN (p.anon_kept_for IS NOT NULL AND p.tier <> 'anon')
                  OR (p.authenticated_kept_for IS NOT NULL AND p.tier = 'service') THEN 'kept'
                WHEN b.anon_could IS DISTINCT FROM has_function_privilege('anon', p.fn_oid, 'EXECUTE')
                  OR b.authenticated_could IS DISTINCT FROM has_function_privilege('authenticated', p.fn_oid, 'EXECUTE')
                  OR b.service_could IS DISTINCT FROM has_function_privilege('service_role', p.fn_oid, 'EXECUTE')
                THEN 'changed' ELSE 'unchanged' END,
           format('%s%s | %s | callers: %s', p.tier,
                  CASE WHEN b.definer THEN ', SECURITY DEFINER' ELSE '' END, a.does, a.callers)
           || coalesce(' | anon keeps it: ' || p.anon_kept_for, '')
           || CASE WHEN p.tier = 'service' THEN coalesce(' | signed-in users keep it: ' || p.authenticated_kept_for, '') ELSE '' END
      FROM pg_temp.kg_plan p
      JOIN pg_temp.kg_fn_before b USING (fn_oid)
      JOIN pg_temp.kg_function_access a ON a.fn_name = p.fn_name
     ORDER BY p.tier, p.fn_name, 2;
    -- A function this file does not name: left as it is, for a later migration to decide.
    INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
    SELECT '5 not reviewed', pg_temp.kg_sig(b.fn_oid),
           CASE WHEN b.anon_could THEN 'may run' ELSE 'no' END,
           CASE WHEN has_function_privilege('anon', b.fn_oid, 'EXECUTE') THEN 'may run' ELSE 'no' END,
           CASE WHEN b.authenticated_could THEN 'may run' ELSE 'no' END,
           CASE WHEN has_function_privilege('authenticated', b.fn_oid, 'EXECUTE') THEN 'may run' ELSE 'no' END,
           'not reviewed',
           CASE WHEN b.definer THEN 'SECURITY DEFINER. ' ELSE '' END
           || 'Not in kg_function_access (production only?): left as it is. Give it a tier in a later migration.'
      FROM pg_temp.kg_fn_before b
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.kg_plan p WHERE p.fn_oid = b.fn_oid)
     ORDER BY 2;
    -- The policies that already named authenticated on a second run, and the ones left as they are.
    INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
    SELECT '2 policy', format('%s on %s', pol.polname, pol.polrelid::regclass), 'not evaluated', 'not evaluated',
           'evaluated', 'evaluated', 'unchanged', 'already TO authenticated'
      FROM pg_policy pol JOIN pg_temp.kg_pol_before pb ON pb.pol_oid = pol.oid
     WHERE pb.roles_before = 'authenticated' AND pol.polroles = ARRAY['authenticated'::regrole::oid]
       AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
                      AND d.refclassid = 'pg_proc'::regclass
                      AND d.refobjid IN (SELECT fn_oid FROM pg_temp.kg_plan WHERE fn_name = 'has_role'))
       AND pol.polname IN ('Admins can update system alerts', 'Admins can view system alerts',
                           'Admins delete lovable invoices', 'Admins insert lovable invoices',
                           'Admins update lovable invoices', 'Admins view lovable invoices',
                           'Admins manage publication_figure', 'Admins manage publication_fulltext',
                           'Admins manage publication_fulltext_body');
    INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
    SELECT '2 policy', format('%s on %s', pol.polname, pol.polrelid::regclass), 'evaluated', 'evaluated',
           'evaluated', 'evaluated', 'kept',
           'names PUBLIC and calls has_role in a form this run does not know to be false for anon: left as it is, so anon keeps has_role. '
           || concat_ws(' / ', pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid))
      FROM pg_policy pol
     WHERE 0 = ANY (pol.polroles)
       AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
                      AND d.refclassid = 'pg_proc'::regclass
                      AND d.refobjid IN (SELECT fn_oid FROM pg_temp.kg_plan WHERE fn_name = 'has_role'));
    -- The columns, per object and role.
    INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
    SELECT '3 column', b.object_name || '.' || b.column_name,
           CASE WHEN b.anon_could THEN 'may read' ELSE 'no' END,
           CASE WHEN has_column_privilege('anon', to_regclass('public.' || b.object_name), b.column_name, 'SELECT') THEN 'may read' ELSE 'no' END,
           CASE WHEN b.authenticated_could THEN 'may read' ELSE 'no' END,
           CASE WHEN has_column_privilege('authenticated', to_regclass('public.' || b.object_name), b.column_name, 'SELECT') THEN 'may read' ELSE 'no' END,
           CASE WHEN b.anon_could IS DISTINCT FROM has_column_privilege('anon', to_regclass('public.' || b.object_name), b.column_name, 'SELECT')
                  OR b.authenticated_could IS DISTINCT FROM has_column_privilege('authenticated', to_regclass('public.' || b.object_name), b.column_name, 'SELECT')
                THEN 'changed' ELSE 'unchanged' END,
           coalesce((SELECT 'private from anon: ' || p.holds FROM pg_temp.kg_private_from_anon p
                      WHERE p.object_name = b.object_name AND p.column_name = b.column_name),
                    (SELECT 'private from signed-in users: ' || p.holds FROM pg_temp.kg_private_from_authenticated p
                      WHERE p.object_name = b.object_name AND p.column_name = b.column_name), '')
      FROM pg_temp.kg_col_before b
     WHERE EXISTS (SELECT 1 FROM pg_temp.kg_private_from_anon p WHERE p.object_name = b.object_name AND p.column_name = b.column_name)
        OR EXISTS (SELECT 1 FROM pg_temp.kg_private_from_authenticated p WHERE p.object_name = b.object_name AND p.column_name = b.column_name)
     ORDER BY 2;
    INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
    SELECT '3 column', o.object_name || ' (every other column)',
           count(*) FILTER (WHERE b.anon_could) || ' of ' || count(*),
           count(*) FILTER (WHERE has_column_privilege('anon', to_regclass('public.' || b.object_name), b.column_name, 'SELECT')) || ' of ' || count(*),
           count(*) FILTER (WHERE b.authenticated_could) || ' of ' || count(*),
           count(*) FILTER (WHERE has_column_privilege('authenticated', to_regclass('public.' || b.object_name), b.column_name, 'SELECT')) || ' of ' || count(*),
           'unchanged', 'every column but the private ones reads as before (checked above)'
      FROM (SELECT DISTINCT object_name FROM pg_temp.kg_col_before WHERE object_name <> 'project_metadata_public') o
      JOIN pg_temp.kg_col_before b ON b.object_name = o.object_name
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.kg_private_from_anon p WHERE p.object_name = b.object_name AND p.column_name = b.column_name)
       AND NOT EXISTS (SELECT 1 FROM pg_temp.kg_private_from_authenticated p WHERE p.object_name = b.object_name AND p.column_name = b.column_name)
     GROUP BY o.object_name;
    -- The view.
    INSERT INTO pg_temp.kg_report (section, object, anon_before, anon_now, signed_in_before, signed_in_now, outcome, detail)
    SELECT '4 view', 'project_metadata_public',
           CASE WHEN EXISTS (SELECT 1 FROM pg_temp.kg_col_before WHERE object_name = 'project_metadata_public' AND anon_could) THEN 'may read' ELSE 'no view' END,
           'may read',
           CASE WHEN EXISTS (SELECT 1 FROM pg_temp.kg_col_before WHERE object_name = 'project_metadata_public' AND authenticated_could) THEN 'may read' ELSE 'no view' END,
           'may read',
           CASE WHEN EXISTS (SELECT 1 FROM pg_temp.kg_col_before WHERE object_name = 'project_metadata_public') THEN 'unchanged' ELSE 'changed' END,
           format('%s projects; the 20 public keys of metadata; read only', (SELECT count(*) FROM public.project_metadata_public));

    SELECT count(*) INTO _errs FROM pg_temp.kg_report WHERE outcome = 'error';
    IF _dry OR _errs > 0 THEN
      SELECT array_agg(r ORDER BY r.seq) INTO _keep FROM pg_temp.kg_report r;
      RAISE EXCEPTION USING ERRCODE = 'KG000', MESSAGE = 'privacy_round_two: rolling the run back';
    END IF;
  EXCEPTION WHEN SQLSTATE 'KG000' THEN
    -- Every change above is undone at this point; only the report survives (it was copied first).
    INSERT INTO pg_temp.kg_report SELECT * FROM unnest(_keep);
  END;
  PERFORM public.set_actor('migration:privacy_round_two');
  IF NOT _dry AND _errs > 0 THEN
    SELECT string_agg(format('[%s] %s: %s', r.section, r.object, r.detail), E'\n' ORDER BY r.seq)
      INTO _list FROM pg_temp.kg_report r WHERE r.outcome = 'error';
    RAISE EXCEPTION E'privacy_round_two: NOTHING WAS CHANGED, % error(s):\n%', _errs, _list
      USING HINT = 'Set the dry-run switch back to ''on'' and run again to see the whole report.';
  END IF;
  INSERT INTO pg_temp.kg_report (seq, section, object, outcome, detail)
  SELECT 0, '0 RESULT',
         CASE WHEN _dry THEN 'DRY RUN: every change was made, then rolled back. NOTHING WAS CHANGED.'
              ELSE 'APPLIED: committed as one transaction under migration:privacy_round_two.' END,
         CASE WHEN _errs > 0 THEN 'error' WHEN _dry THEN 'report' ELSE 'done' END,
         format('functions: %s changed, %s kept for a live object, %s unchanged, %s not reviewed; policies re-scoped: %s; columns changed: %s. ',
                count(*) FILTER (WHERE section = '1 function' AND outcome = 'changed'),
                count(*) FILTER (WHERE section = '1 function' AND outcome = 'kept'),
                count(*) FILTER (WHERE section = '1 function' AND outcome = 'unchanged'),
                count(*) FILTER (WHERE section = '5 not reviewed'),
                count(*) FILTER (WHERE section = '2 policy' AND outcome = 'changed'),
                count(*) FILTER (WHERE section = '3 column' AND outcome = 'changed'))
         || CASE WHEN _errs > 0 THEN format('%s ERROR(S): a real run changes nothing until they are fixed (rows marked error). ', _errs) ELSE '' END
         || CASE WHEN _dry THEN 'To apply: change the dry-run switch to ''off'' in the line  SELECT set_config(''bbqs.dry_run'', ''on'', true);  near the top, and run the whole script again.'
                 ELSE 'Running it again changes nothing (every row says unchanged).' END
    FROM pg_temp.kg_report;
END
$kg$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- == Report (the editor shows only this last result) -------------------------------------------------------
SELECT section, object,
       coalesce(anon_before || ' -> ' || anon_now, '') AS anon,
       coalesce(signed_in_before || ' -> ' || signed_in_now, '') AS signed_in,
       outcome, detail
  FROM pg_temp.kg_report
 ORDER BY seq = 0 DESC, section, CASE outcome WHEN 'error' THEN 0 WHEN 'kept' THEN 1 WHEN 'changed' THEN 2 ELSE 3 END, object;
