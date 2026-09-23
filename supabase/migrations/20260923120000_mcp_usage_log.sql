-- MCP usage log: one row per bbqs-mcp tool call (reads AND writes) so the admin console can show the
-- MCP's reach. The MCP has no service-role key, so it logs via log_mcp_usage (SECURITY DEFINER), which
-- self-derives the actor from the caller's JWT — the MCP cannot mis-stamp it, and anon (public-tool)
-- calls are logged with a null actor. The table is written ONLY by that function (no direct DML grant);
-- SELECT is admin/curator. mcp_usage_stats returns the aggregates the panel renders.

SELECT public.set_actor('migration:mcp_usage_log');

CREATE TABLE IF NOT EXISTS public.mcp_usage_log (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool        text        NOT NULL,
  tier        text,                       -- public | member | curator
  actor_id    uuid,                       -- auth.uid() when signed in; null for anonymous public calls
  actor_email text,
  ok          boolean     NOT NULL DEFAULT true,
  error       text,
  duration_ms integer,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_time ON public.mcp_usage_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_tool ON public.mcp_usage_log (tool, occurred_at DESC);

ALTER TABLE public.mcp_usage_log ENABLE ROW LEVEL SECURITY;
-- No INSERT/UPDATE/DELETE policy: only the SECURITY DEFINER log_mcp_usage below writes. Admins/curators read.
DROP POLICY IF EXISTS "mcp usage read" ON public.mcp_usage_log;
CREATE POLICY "mcp usage read" ON public.mcp_usage_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'));

-- Append one usage row, deriving the actor from the caller's JWT (works for anon: actor_id null).
CREATE OR REPLACE FUNCTION public.log_mcp_usage(
  _tool text, _tier text DEFAULT NULL, _ok boolean DEFAULT true,
  _error text DEFAULT NULL, _duration_ms integer DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.mcp_usage_log(tool, tier, actor_id, actor_email, ok, error, duration_ms)
  VALUES (
    _tool, _tier, auth.uid(),
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''),
    coalesce(_ok, true), _error, _duration_ms
  );
END $$;
GRANT EXECUTE ON FUNCTION public.log_mcp_usage(text, text, boolean, text, integer) TO anon, authenticated;

-- Admin/curator-only aggregates for the console, as a single jsonb blob.
CREATE OR REPLACE FUNCTION public.mcp_usage_stats(_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid   uuid := auth.uid();
  _days2 integer := greatest(coalesce(_days, 30), 1);
  _since timestamptz := now() - make_interval(days => _days2);
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'admin or curator only';
  END IF;

  RETURN jsonb_build_object(
    'window_days', _days2,
    'total_calls',    (SELECT count(*) FROM public.mcp_usage_log WHERE occurred_at >= _since),
    'unique_users',   (SELECT count(DISTINCT actor_id) FROM public.mcp_usage_log WHERE occurred_at >= _since AND actor_id IS NOT NULL),
    'anonymous_calls',(SELECT count(*) FROM public.mcp_usage_log WHERE occurred_at >= _since AND actor_id IS NULL),
    'error_calls',    (SELECT count(*) FROM public.mcp_usage_log WHERE occurred_at >= _since AND ok = false),
    'by_tier', (SELECT coalesce(jsonb_object_agg(tier, n), '{}') FROM
                 (SELECT coalesce(tier, 'public') tier, count(*) n FROM public.mcp_usage_log
                   WHERE occurred_at >= _since GROUP BY 1) s),
    'by_tool', (SELECT coalesce(jsonb_agg(jsonb_build_object('tool', tool, 'calls', n) ORDER BY n DESC), '[]') FROM
                 (SELECT tool, count(*) n FROM public.mcp_usage_log WHERE occurred_at >= _since GROUP BY tool) s),
    'by_day',  (SELECT coalesce(jsonb_agg(jsonb_build_object('day', d, 'calls', n) ORDER BY d), '[]') FROM
                 (SELECT date_trunc('day', occurred_at)::date d, count(*) n FROM public.mcp_usage_log
                   WHERE occurred_at >= _since GROUP BY 1) s),
    'top_users', (SELECT coalesce(jsonb_agg(jsonb_build_object('email', email, 'calls', n) ORDER BY n DESC), '[]') FROM
                   (SELECT coalesce(actor_email, '(anonymous)') email, count(*) n FROM public.mcp_usage_log
                     WHERE occurred_at >= _since GROUP BY 1 ORDER BY 2 DESC LIMIT 10) s),
    -- Retroactive WRITE reach from data_audit_log (all-time), captured since before this usage log
    -- existed: MCP writes are stamped client_source = 'bbqs-mcp:<email>'.
    'historical_writes',      (SELECT count(*) FROM public.data_audit_log WHERE client_source LIKE 'bbqs-mcp:%'),
    'historical_write_users', (SELECT count(DISTINCT client_source) FROM public.data_audit_log WHERE client_source LIKE 'bbqs-mcp:%')
  );
END $$;
GRANT EXECUTE ON FUNCTION public.mcp_usage_stats(integer) TO authenticated;

-- Register mcp_usage_log as an append-only log so the provenance guard does not expect it to be graded.
CREATE OR REPLACE FUNCTION public.provenance_excluded_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    -- the mechanism itself: recording provenance about provenance recurses
    'field_provenance', 'source_classes',
    -- append-only logs: a log row is already a historical assertion, with no current value to grade
    'data_audit_log', 'auth_audit_log', 'edit_history', 'curation_audit_log',
    'analytics_clicks', 'analytics_pageviews', 'search_queries', 'security_audit_results',
    'mcp_usage_log',
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
    -- mirrors of external systems: the truth lives in the system being mirrored. reporter_pi_
    -- observations is added here by 20260826140000 -- a curator cannot verify a RePORTER row, and
    -- re-fetching is how it is corrected.
    'slack_channel_members', 'slack_channel_pending', 'slack_channels', 'dandisets',
    'reporter_pi_observations',
    -- PURE LINK TABLES: foreign keys and nothing else, so no cell a human can judge -- grading them
    -- protected nothing while filling the worklist with uuids (20260822160000). This is now the
    -- ONLY reason. The old second reason -- that the guard is BEFORE UPDATE and link rows are never
    -- updated, so it could not fire here -- expired when 20260831160000 added an AFTER INSERT
    -- recorder. Provenance CAN reach these tables now; they are excluded because the cells are not
    -- worth judging, not because it cannot.
    -- grant_investigators and grant_dandisets are NOT in this group -- they carry attributes.
    'investigator_organizations', 'project_publications'
  ]::text[]
$fn$;
