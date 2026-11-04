-- Every MCP call, not only the tool calls that reached a handler: a call the step-up gate refused
-- (outcome 'refused') and each session's initialize (method 'initialize', with the client's name)
-- are logged too, and every row carries the call's arguments, so the panel can answer who used
-- which tool, with what, from which client — and who tried a tool above their tier.

SELECT public.set_actor('migration:mcp_call_log');

ALTER TABLE public.mcp_usage_log
  ADD COLUMN IF NOT EXISTS method      text NOT NULL DEFAULT 'tools/call',
  ADD COLUMN IF NOT EXISTS outcome     text,        -- ok | error | refused
  ADD COLUMN IF NOT EXISTS args        jsonb,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS user_agent  text,
  ADD COLUMN IF NOT EXISTS session_id  text;

UPDATE public.mcp_usage_log SET outcome = CASE WHEN ok THEN 'ok' ELSE 'error' END WHERE outcome IS NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_usage_actor ON public.mcp_usage_log (actor_id, occurred_at DESC);

-- Callable by anon (refused and public calls have no account), so every text is capped: an
-- anonymous caller can add rows but cannot make them large.
DROP FUNCTION IF EXISTS public.log_mcp_usage(text, text, boolean, text, integer);
CREATE OR REPLACE FUNCTION public.log_mcp_usage(
  _tool text, _tier text DEFAULT NULL, _ok boolean DEFAULT true,
  _error text DEFAULT NULL, _duration_ms integer DEFAULT NULL,
  _outcome text DEFAULT NULL, _args jsonb DEFAULT NULL, _method text DEFAULT NULL,
  _client_name text DEFAULT NULL, _user_agent text DEFAULT NULL, _session_id text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.mcp_usage_log(tool, tier, actor_id, actor_email, ok, error, duration_ms,
                                   method, outcome, args, client_name, user_agent, session_id)
  VALUES (
    left(_tool, 100), left(_tier, 20), auth.uid(),
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''),
    coalesce(_ok, true), left(_error, 1000), _duration_ms,
    left(coalesce(_method, 'tools/call'), 50),
    left(coalesce(_outcome, CASE WHEN coalesce(_ok, true) THEN 'ok' ELSE 'error' END), 20),
    CASE WHEN _args IS NULL THEN NULL
         WHEN length(_args::text) > 4000 THEN jsonb_build_object('_truncated', left(_args::text, 4000))
         ELSE _args END,
    left(_client_name, 100), left(_user_agent, 300), left(_session_id, 100)
  );
END $$;
GRANT EXECUTE ON FUNCTION public.log_mcp_usage(text, text, boolean, text, integer, text, jsonb, text, text, text, text)
  TO anon, authenticated;

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
    'total_calls',    (SELECT count(*) FROM public.mcp_usage_log WHERE occurred_at >= _since AND method = 'tools/call'),
    'unique_users',   (SELECT count(DISTINCT actor_id) FROM public.mcp_usage_log WHERE occurred_at >= _since AND actor_id IS NOT NULL),
    'anonymous_calls',(SELECT count(*) FROM public.mcp_usage_log WHERE occurred_at >= _since AND method = 'tools/call' AND actor_id IS NULL),
    'error_calls',    (SELECT count(*) FROM public.mcp_usage_log WHERE occurred_at >= _since AND outcome = 'error'),
    'refused_calls',  (SELECT count(*) FROM public.mcp_usage_log WHERE occurred_at >= _since AND outcome = 'refused'),
    'by_tier', (SELECT coalesce(jsonb_object_agg(tier, n), '{}') FROM
                 (SELECT coalesce(tier, 'public') tier, count(*) n FROM public.mcp_usage_log
                   WHERE occurred_at >= _since AND method = 'tools/call' GROUP BY 1) s),
    'by_tool', (SELECT coalesce(jsonb_agg(jsonb_build_object('tool', tool, 'calls', n) ORDER BY n DESC), '[]') FROM
                 (SELECT tool, count(*) n FROM public.mcp_usage_log
                   WHERE occurred_at >= _since AND method = 'tools/call' GROUP BY tool) s),
    'by_day',  (SELECT coalesce(jsonb_agg(jsonb_build_object('day', d, 'calls', n) ORDER BY d), '[]') FROM
                 (SELECT date_trunc('day', occurred_at)::date d, count(*) n FROM public.mcp_usage_log
                   WHERE occurred_at >= _since AND method = 'tools/call' GROUP BY 1) s),
    'top_users', (SELECT coalesce(jsonb_agg(jsonb_build_object('email', email, 'calls', n) ORDER BY n DESC), '[]') FROM
                   (SELECT coalesce(actor_email, '(anonymous)') email, count(*) n FROM public.mcp_usage_log
                     WHERE occurred_at >= _since AND method = 'tools/call' GROUP BY 1 ORDER BY 2 DESC LIMIT 10) s),
    'by_user_tool', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'email', email, 'tool', tool, 'calls', n, 'errors', e, 'refused', r, 'last', last)
                       ORDER BY email, n DESC), '[]') FROM
                      (SELECT coalesce(actor_email, '(anonymous)') email, tool, count(*) n,
                              count(*) FILTER (WHERE outcome = 'error') e,
                              count(*) FILTER (WHERE outcome = 'refused') r, max(occurred_at) last
                         FROM public.mcp_usage_log
                        WHERE occurred_at >= _since AND method = 'tools/call' GROUP BY 1, 2) s),
    'clients', (SELECT coalesce(jsonb_agg(jsonb_build_object('client', client, 'email', email, 'sessions', n, 'last', last)
                  ORDER BY last DESC), '[]') FROM
                 (SELECT coalesce(client_name, '(unknown)') client, coalesce(actor_email, '(anonymous)') email,
                         count(DISTINCT session_id) n, max(occurred_at) last
                    FROM public.mcp_usage_log
                   WHERE occurred_at >= _since AND method = 'initialize' GROUP BY 1, 2) s),
    'recent', (SELECT coalesce(jsonb_agg(row_to_json(s)::jsonb ORDER BY s.occurred_at DESC), '[]') FROM
                (SELECT occurred_at, coalesce(actor_email, '(anonymous)') email, method, tool, tier, outcome,
                        args, error, client_name, duration_ms
                   FROM public.mcp_usage_log WHERE occurred_at >= _since
                  ORDER BY occurred_at DESC LIMIT 200) s),
    'historical_writes',      (SELECT count(*) FROM public.data_audit_log WHERE client_source LIKE 'bbqs-mcp:%'),
    'historical_write_users', (SELECT count(DISTINCT client_source) FROM public.data_audit_log WHERE client_source LIKE 'bbqs-mcp:%')
  );
END $$;
GRANT EXECUTE ON FUNCTION public.mcp_usage_stats(integer) TO authenticated;
