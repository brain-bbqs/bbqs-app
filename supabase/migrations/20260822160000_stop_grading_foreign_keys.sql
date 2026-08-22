-- A foreign key is not a claim about the world. Stop putting UUIDs in the review queue.
--
-- WHAT WAS ON SCREEN:
--
--   5b0171cb...  investigator_organizations   2 fields · worst G8   [I have reviewed this record]
--     investigator_id   dc1a0c02-8697-4c88-83a3-721e0a1ce6e5   G8 No recorded source
--     organization_id   00e61ed0-1e2b-4334-b345-6915f4f77b76
--
-- There is nothing a human can review there. The row's only content is two foreign keys, and the
-- label is a truncated uuid because there is no name to show. Measured: 254 of 1,000 sampled queue
-- rows are a *_id column, 176 of them from this one table.
--
-- TWO THINGS WRONG, both mine.
--
-- 1. FOREIGN KEYS ARE NOT GRADABLE CELLS. "investigator_id = dc1a0c02" is not a claim with a source
--    a person can check; it is the identity of a relationship. The claim worth grading is "this
--    investigator is affiliated with this organization" -- one fact about the ROW, which a per-cell
--    store cannot express as two facts about two uuids without producing nonsense. Columns matching
--    _id$ are no longer graded.
--
-- 2. PURE LINK TABLES SHOULD NEVER HAVE BEEN IN SCOPE. investigator_organizations and
--    project_publications have no attribute columns at all -- only foreign keys and bookkeeping. I
--    brought them in deliberately, in 20260820160000, by adding surrogate uuid ids, on the reasoning
--    that "the link is a claim this consortium makes". The reasoning was right and the conclusion was
--    wrong: the guard is BEFORE UPDATE, and link rows are inserted and deleted, never updated, so
--    guarding them protected nothing while filling the queue with uuids.
--
--    grant_investigators and grant_dandisets STAY: they carry real attributes (role, role_source,
--    match_source, matched_award), and grant_investigators genuinely does get updated when a role
--    changes.
--
-- The existing claims stay in the store, as append-only requires. They stop being counted and
-- queued, which is the same treatment the out-of-scope tables got in 20260820180000.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822160000');

-- ── 1. Drop the two FK-only tables from scope ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_excluded_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    -- the mechanism itself: recording provenance about provenance recurses
    'field_provenance', 'source_classes',
    -- append-only logs: a log row is already a historical assertion, with no current value to grade
    'data_audit_log', 'auth_audit_log', 'edit_history', 'curation_audit_log',
    'analytics_clicks', 'analytics_pageviews', 'search_queries', 'security_audit_results',
    -- derived bulk, regenerated wholesale
    'knowledge_embeddings', 'cohort_summaries', 'budget_snapshots',
    -- harvester pipeline: output and state, rewritten every run
    'harvester_queue', 'harvester_runs', 'harvester_settings', 'harvester_keywords',
    'harvester_synonyms', 'harvester_relations',
    'grant_methods_traversal_paths', 'grant_methods_evidence', 'news_candidates',
    -- configuration: knobs, not the record
    'state_privacy_rules', 'allowed_domains', 'budget_config',
    -- intake and moderation state: decisions about data rather than data
    'access_requests', 'group_audit_dismissals',
    -- user-submitted opinion, not a claim about the world
    'feature_suggestions', 'feature_votes', 'entity_comments',
    -- access control: covered by data_audit_log; the question is who granted it
    'user_roles',
    -- personal preferences
    'user_dashboard_layouts', 'working_group_dashboard_defaults',
    -- billing
    'lovable_invoices', 'lovable_user_usage', 'lovable_credit_events',
    -- mirrors of external systems: the truth lives in the system being mirrored
    'slack_channel_members', 'slack_channel_pending', 'slack_channels', 'dandisets',
    -- PURE LINK TABLES: foreign keys and nothing else, so no cell a human can judge. The guard is
    -- BEFORE UPDATE and link rows are inserted or deleted, never updated, so it never fired here
    -- anyway. grant_investigators and grant_dandisets are NOT in this group -- they carry attributes.
    'investigator_organizations', 'project_publications'
  ]::text[]
$fn$;

-- ── 2. Never grade a foreign key ────────────────────────────────────────────────────────────
/** Is this column worth a provenance claim? Named columns are excluded by list; foreign keys by
 *  shape, because they are added constantly and a list would always be behind.
 *
 *  The pattern is a REGEX, not LIKE. `entity_column NOT LIKE '%_id'` looks right and is wrong:
 *  in LIKE, `_` matches any single character, so it would also exclude `orcid`. */
CREATE OR REPLACE FUNCTION public.provenance_is_gradable_column(_col text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT NOT (split_part(_col, '.', 1) = ANY (public.provenance_excluded_columns()))
     AND _col !~ '_id$'
$fn$;

COMMENT ON FUNCTION public.provenance_is_gradable_column(text) IS
  'Whether a cell deserves a provenance claim. Excludes bookkeeping columns by name and foreign keys by shape (_id$). A foreign key is the identity of a relationship, not a claim with a checkable source -- grading them put rows reading "investigator_id = dc1a0c02..." in the curator queue.';

GRANT EXECUTE ON FUNCTION public.provenance_is_gradable_column(text) TO authenticated, service_role;

-- ── 3. The guard stops recording them ───────────────────────────────────────────────────────
-- Only the two CONTINUE guards change; everything else is the migration-20260820150000 body.
CREATE OR REPLACE FUNCTION public.enforce_field_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _class     text := public.current_source_class();
  _verified  boolean;
  _actor     text := public.current_actor_via();
  _tbl       text := TG_TABLE_NAME;
  _oldj      jsonb := to_jsonb(OLD);
  _newj      jsonb := to_jsonb(NEW);
  _id        uuid;
  _col       text;
  _oldv      jsonb;
  _newv      jsonb;
  _txt       text;
  _cur_ok    boolean;
  _cur_label text;
  _cur_agent text;
  _cur_who   text;
  _key       text;
BEGIN
  _id := nullif(_newj ->> 'id', '')::uuid;
  IF _id IS NULL THEN RETURN NEW; END IF;

  SELECT sc.is_verified INTO _verified
    FROM public.source_classes sc WHERE sc.code = _class;

  FOR _col IN SELECT k FROM jsonb_object_keys(_newj) AS k LOOP
    CONTINUE WHEN NOT public.provenance_is_gradable_column(_col);

    _oldv := _oldj -> _col;
    _newv := _newj -> _col;
    CONTINUE WHEN _oldv IS NOT DISTINCT FROM _newv;

    IF jsonb_typeof(_newv) = 'object' THEN
      FOR _key IN SELECT k FROM jsonb_object_keys(_newv) AS k LOOP
        CONTINUE WHEN _key = 'field_provenance';
        CONTINUE WHEN NOT public.provenance_is_gradable_column(_col || '.' || _key);
        CONTINUE WHEN (_oldv -> _key) IS NOT DISTINCT FROM (_newv -> _key);
        _txt := CASE WHEN jsonb_typeof(_newv -> _key) = 'string'
                     THEN _newv ->> _key ELSE (_newv -> _key)::text END;
        CONTINUE WHEN btrim(coalesce(_txt, '')) = '';

        SELECT sc.is_verified, sc.label, fp.agent_label
          INTO _cur_ok, _cur_label, _cur_agent
          FROM public.field_provenance fp
          JOIN public.source_classes sc ON sc.code = fp.source_class
         WHERE fp.entity_table = _tbl AND fp.entity_id = _id
           AND fp.entity_column = _col || '.' || _key
         ORDER BY fp.recorded_at DESC, fp.id DESC LIMIT 1;

        _cur_who := CASE WHEN _cur_agent IS NULL OR btrim(_cur_agent) = ''
                              OR _cur_agent = _cur_label THEN ''
                         ELSE ' (' || _cur_agent || ')' END;

        IF _cur_ok AND NOT _verified THEN
          RAISE EXCEPTION
            'Refusing to overwrite %.%.% : it is held at "%"%, and this write is only "%".',
            _tbl, _col, _key, _cur_label, _cur_who, _class
            USING ERRCODE = 'check_violation',
                  HINT = 'Constitution XI: a machine may not silently overwrite a human- or registry-established value. Declare a better source with set_source_class() or the x-bbqs-source-class header.';
        END IF;

        INSERT INTO public.field_provenance (
          entity_table, entity_id, entity_column, source_class, activity,
          agent_id, agent_label, value_text, recorded_by)
        VALUES (_tbl, _id, _col || '.' || _key, _class, 'direct_write',
                auth.uid(), _actor, left(_txt, 500), _actor);
      END LOOP;
      CONTINUE;
    END IF;

    _txt := CASE
      WHEN jsonb_typeof(_newv) = 'array'
        THEN (SELECT string_agg(e, ', ') FROM jsonb_array_elements_text(_newv) AS e)
      ELSE _newj ->> _col
    END;
    CONTINUE WHEN btrim(coalesce(_txt, '')) = '';

    SELECT sc.is_verified, sc.label, fp.agent_label
      INTO _cur_ok, _cur_label, _cur_agent
      FROM public.field_provenance fp
      JOIN public.source_classes sc ON sc.code = fp.source_class
     WHERE fp.entity_table = _tbl AND fp.entity_id = _id AND fp.entity_column = _col
     ORDER BY fp.recorded_at DESC, fp.id DESC LIMIT 1;

    _cur_who := CASE WHEN _cur_agent IS NULL OR btrim(_cur_agent) = ''
                          OR _cur_agent = _cur_label THEN ''
                     ELSE ' (' || _cur_agent || ')' END;

    IF _cur_ok AND NOT _verified THEN
      RAISE EXCEPTION
        'Refusing to overwrite %.% : it is held at "%"%, and this write is only "%".',
        _tbl, _col, _cur_label, _cur_who, _class
        USING ERRCODE = 'check_violation',
              HINT = 'Constitution XI: a machine may not silently overwrite a human- or registry-established value. Declare a better source with set_source_class() or the x-bbqs-source-class header.';
    END IF;

    INSERT INTO public.field_provenance (
      entity_table, entity_id, entity_column, source_class, activity,
      agent_id, agent_label, value_text, recorded_by)
    VALUES (_tbl, _id, _col, _class, 'direct_write',
            auth.uid(), _actor, left(_txt, 500), _actor);
  END LOOP;

  RETURN NEW;
END;
$fn$;

-- ── 4. The views stop counting and queueing them ────────────────────────────────────────────
CREATE OR REPLACE VIEW public.provenance_coverage
WITH (security_invoker = true)
AS
WITH scope AS MATERIALIZED (
  SELECT table_name FROM public.provenance_guardable_tables
), standing AS (
  SELECT DISTINCT ON (fp.entity_table, fp.entity_id, fp.entity_column)
         fp.entity_table, fp.entity_id, fp.source_class
    FROM public.field_provenance fp
   WHERE fp.entity_table IN (SELECT table_name FROM scope)
     AND public.provenance_is_gradable_column(fp.entity_column)
   ORDER BY fp.entity_table, fp.entity_id, fp.entity_column, fp.recorded_at DESC, fp.id DESC
)
SELECT s.table_name,
       count(st.entity_table)                                            AS cells,
       count(st.entity_table) FILTER (WHERE sc.is_verified)              AS verified,
       count(st.entity_table) FILTER (WHERE NOT sc.is_verified)          AS unverified,
       round(100.0 * count(st.entity_table) FILTER (WHERE sc.is_verified)
             / nullif(count(st.entity_table), 0), 1)                     AS pct_verified,
       count(DISTINCT st.entity_id)                                      AS rows_with_claims
  FROM scope s
  LEFT JOIN standing st ON st.entity_table = s.table_name
  LEFT JOIN public.source_classes sc ON sc.code = st.source_class
 GROUP BY s.table_name;

GRANT SELECT ON public.provenance_coverage TO authenticated;

CREATE OR REPLACE VIEW public.provenance_worklist
WITH (security_invoker = true)
AS
WITH scope AS MATERIALIZED (
  SELECT table_name FROM public.provenance_guardable_tables
), standing AS (
  SELECT DISTINCT ON (fp.entity_table, fp.entity_id, fp.entity_column)
         fp.entity_table, fp.entity_id, fp.entity_column, fp.source_class,
         fp.value_text, fp.agent_label, fp.recorded_at
    FROM public.field_provenance fp
   WHERE fp.entity_table IN (SELECT table_name FROM scope)
     AND public.provenance_is_gradable_column(fp.entity_column)
   ORDER BY fp.entity_table, fp.entity_id, fp.entity_column, fp.recorded_at DESC, fp.id DESC
)
SELECT st.entity_table,
       st.entity_id,
       st.entity_column,
       st.source_class,
       sc.grade AS source_grade,
       sc.label AS source_label,
       st.value_text,
       st.agent_label,
       st.recorded_at,
       coalesce(
         p.grant_number, i.name, g.grant_number, pub.title, o.name, sp.common_name,
         stl.name, dc.label, dm.name, dmo.model_name,
         fo.title, an.title, jb.title, res.name, pr.full_name, sa.message,
         psi.name, gii.name,
         left(st.entity_id::text, 8) || '...'
       ) AS record_label,
       public.provenance_table_priority(st.entity_table) AS priority
  FROM standing st
  JOIN public.source_classes sc ON sc.code = st.source_class AND NOT sc.is_verified
  LEFT JOIN public.projects       p   ON st.entity_table = 'projects'      AND p.id   = st.entity_id
  LEFT JOIN public.investigators  i   ON st.entity_table = 'investigators' AND i.id   = st.entity_id
  LEFT JOIN public.grants         g   ON st.entity_table = 'grants'        AND g.id   = st.entity_id
  LEFT JOIN public.publications   pub ON st.entity_table = 'publications'  AND pub.id = st.entity_id
  LEFT JOIN public.organizations  o   ON st.entity_table = 'organizations' AND o.id   = st.entity_id
  LEFT JOIN public.species        sp  ON st.entity_table = 'species'       AND sp.id  = st.entity_id
  LEFT JOIN public.software_tools stl ON st.entity_table = 'software_tools'        AND stl.id = st.entity_id
  LEFT JOIN public.device_categories    dc  ON st.entity_table = 'device_categories'    AND dc.id  = st.entity_id
  LEFT JOIN public.device_manufacturers dm  ON st.entity_table = 'device_manufacturers' AND dm.id  = st.entity_id
  LEFT JOIN public.device_models        dmo ON st.entity_table = 'device_models'        AND dmo.id = st.entity_id
  LEFT JOIN public.funding_opportunities fo ON st.entity_table = 'funding_opportunities' AND fo.id = st.entity_id
  LEFT JOIN public.announcements  an  ON st.entity_table = 'announcements'  AND an.id  = st.entity_id
  LEFT JOIN public.jobs           jb  ON st.entity_table = 'jobs'           AND jb.id  = st.entity_id
  LEFT JOIN public.resources      res ON st.entity_table = 'resources'      AND res.id = st.entity_id
  LEFT JOIN public.profiles       pr  ON st.entity_table = 'profiles'       AND pr.id  = st.entity_id
  LEFT JOIN public.system_alerts  sa  ON st.entity_table = 'system_alerts'  AND sa.id  = st.entity_id
  LEFT JOIN public.personality_scores  ps ON st.entity_table = 'personality_scores' AND ps.id = st.entity_id
  LEFT JOIN public.investigators      psi ON psi.id = ps.investigator_id
  LEFT JOIN public.grant_investigators gi ON st.entity_table = 'grant_investigators' AND gi.id = st.entity_id
  LEFT JOIN public.investigators      gii ON gii.id = gi.investigator_id;

GRANT SELECT ON public.provenance_worklist TO authenticated;

-- ── 5. Detach the guard from what just left scope ───────────────────────────────────────────
SELECT public.provenance_detach_out_of_scope() AS triggers_removed;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) No uuid columns anywhere in the queue. Expect 0.
SELECT count(*) AS fk_cells_still_queued
  FROM public.provenance_worklist WHERE entity_column ~ '_id$';

-- 2) The two FK-only tables are gone from both views. Expect no rows.
SELECT table_name FROM public.provenance_coverage
 WHERE table_name IN ('investigator_organizations', 'project_publications');

-- 3) orcid was NOT caught by the _id$ pattern -- the reason it is a regex and not LIKE '%_id'.
SELECT public.provenance_is_gradable_column('orcid')          AS orcid_gradable_expect_true,
       public.provenance_is_gradable_column('investigator_id') AS fk_gradable_expect_false,
       public.provenance_is_gradable_column('pmid')            AS pmid_gradable_expect_true;

-- 4) The headline, now counting only cells a person could actually judge.
SELECT sum(cells) AS cells, sum(verified) AS verified,
       round(100.0 * sum(verified) / nullif(sum(cells), 0), 1) AS pct_verified
  FROM public.provenance_coverage;
