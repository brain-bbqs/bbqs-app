-- Slack channel survey: compute who is missing from which channel, bucketed BY CHANNEL.
--
-- WHY THIS SHAPE. Slack refuses to let a BOT add a guest to a channel — admin-only, and no bot scope
-- changes it. Working-group choices necessarily arrive LATER, from the member, on the site. Those two
-- facts cannot both hold and still be fully automated, so the automation should stop at the boundary
-- and hand a human the smallest possible task.
--
-- The smallest possible task is per CHANNEL, not per person. Slack's "Add people to #channel" dialog
-- accepts a pasted list of addresses, so one paste clears an entire channel's backlog. Bucketing by
-- person would mean opening the member-management screen once each; bucketing by channel means six
-- pastes at most, however many people are waiting.
--
-- WHAT IS AUTOMATED: detecting the gap, continuously. WHAT IS NOT: the click, because Slack forbids it.
-- The intent is never discarded — previously a blocked add surfaced as "Could not add to 2 channel(s)"
-- and the wanted channels were thrown away, so the same failure recurred every time anyone retried.
--
-- The channel map moves from env vars (SLACK_ONBOARDING_CHANNELS / _YI_CHANNELS / _WG_CHANNELS) into a
-- table, because a survey has to JOIN against it and the console has to render it. Env vars can stay
-- as-is for the existing per-member invite path; this table is what the audit reads.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260811160000');

-- ── The channel map ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.slack_channels (
  channel_id   text PRIMARY KEY,
  channel_name text NOT NULL,
  -- 'everyone'            : every member with an email
  -- 'young_investigators' : career stage postdoc / PhD student (substring match on the free-text
  --                         investigators.role, which holds raw Google-Form labels)
  -- 'wg'                  : one working group, named in wg_token
  scope        text NOT NULL CHECK (scope IN ('everyone', 'young_investigators', 'wg')),
  wg_token     text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wg_token_required_for_wg_scope
    CHECK ((scope = 'wg') = (wg_token IS NOT NULL))
);

COMMENT ON TABLE public.slack_channels IS
  'The BBQS Slack channel map, in the database so the survey can join against it and the console can render per-channel buckets. Mirrors the SLACK_*_CHANNELS env vars used by the per-member invite path.';

INSERT INTO public.slack_channels (channel_id, channel_name, scope, wg_token) VALUES
  ('C07UA8763SA', '#general',             'everyone',            NULL),
  ('C09673P9D1A', '#younginvestigators',  'young_investigators', NULL),
  ('C0BP1AN59CZ', '#bbqs-wg-analytics',   'wg',                  'WG-Analytics'),
  ('C09633EE5M5', '#bbqs-wg-devices',     'wg',                  'WG-Devices'),
  ('C098CRMDFUK', '#bbqs-wg-elsi',        'wg',                  'WG-ELSI'),
  ('C097J7SLNJY', '#bbqs-wg-standards',   'wg',                  'WG-Standards')
ON CONFLICT (channel_id) DO UPDATE
  SET channel_name = excluded.channel_name,
      scope        = excluded.scope,
      wg_token     = excluded.wg_token;

-- ── The live snapshot, written by the survey ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.slack_channel_members (
  channel_id text NOT NULL REFERENCES public.slack_channels(channel_id) ON DELETE CASCADE,
  email      text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, email)
);

COMMENT ON TABLE public.slack_channel_members IS
  'Last observed LIVE Slack membership per channel, replaced on each survey. Slack is the authority for who is in a channel; investigators.working_groups is only intent.';

-- ── The backlog, with age ───────────────────────────────────────────────────────────────────────
-- A table rather than a pure view so "pending since" survives across surveys. That matters: a name
-- that has been waiting three weeks is a different problem from one that appeared this morning, and
-- a view recomputed from live state cannot tell them apart.
CREATE TABLE IF NOT EXISTS public.slack_channel_pending (
  channel_id     text NOT NULL REFERENCES public.slack_channels(channel_id) ON DELETE CASCADE,
  email          text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  PRIMARY KEY (channel_id, email)
);

COMMENT ON TABLE public.slack_channel_pending IS
  'Members the KG says belong in a Slack channel who are not in it live. Maintained by the slack-survey function: upserted while still missing, resolved_at stamped once they appear. Kept as a table so "pending since" survives surveys.';

ALTER TABLE public.slack_channels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_channel_pending ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['slack_channels','slack_channel_members','slack_channel_pending']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %s_read ON public.%I', t, t);
    -- Reading these exposes who is on which channel, so curator/admin only. Writes go through the
    -- service-role survey function, which needs no policy.
    EXECUTE format(
      'CREATE POLICY %s_read ON public.%I FOR SELECT TO authenticated '
      'USING (public.has_role(auth.uid(), ''admin'') OR public.has_role(auth.uid(), ''curator''))', t, t);
  END LOOP;
END
$do$;

-- ── Who SHOULD be in each channel ───────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.slack_channel_expected
WITH (security_invoker = true)
AS
SELECT c.channel_id, c.channel_name, c.scope, c.wg_token,
       lower(btrim(i.email)) AS email,
       i.name,
       i.role
  FROM public.slack_channels c
  JOIN public.investigators i
    ON i.email IS NOT NULL AND btrim(i.email) <> ''
   AND CASE c.scope
         WHEN 'everyone' THEN true
         -- Substring, not equality: investigators.role holds raw form labels ("Postdoc/Grad Student",
         -- "Research Staff (Scientist and others)"). Exact matching once flagged 66 real trainees.
         WHEN 'young_investigators' THEN
           coalesce(i.role, '') ~* 'post-?doc|grad(uate)?\s*student|\mgrad\M|trainee|student|ph\.?\s?d'
         WHEN 'wg' THEN c.wg_token = ANY (coalesce(i.working_groups, '{}'))
       END
 WHERE c.active
   AND coalesce(i.onboarding_checklist ->> 'status', '') <> 'offboarded';

COMMENT ON VIEW public.slack_channel_expected IS
  'Per channel, the member addresses the KG says belong there: everyone-channel for all emailed members, young-investigators by career-stage substring, and one channel per working group they selected.';

-- ── The bucket a human works from ───────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.slack_channel_backlog
WITH (security_invoker = true)
AS
SELECT p.channel_id,
       c.channel_name,
       count(*) AS waiting,
       min(p.first_seen_at) AS oldest_pending,
       max(p.last_seen_at)  AS last_surveyed,
       -- One paste per channel: this is the whole point of bucketing by channel rather than person.
       string_agg(p.email, ', ' ORDER BY p.email) AS emails_to_paste,
       array_agg(p.email ORDER BY p.email)        AS emails,
       'https://slack.com/app_redirect?channel=' || p.channel_id AS open_channel_url
  FROM public.slack_channel_pending p
  JOIN public.slack_channels c ON c.channel_id = p.channel_id
 WHERE p.resolved_at IS NULL
 GROUP BY p.channel_id, c.channel_name
 ORDER BY count(*) DESC;

COMMENT ON VIEW public.slack_channel_backlog IS
  'One row per Slack channel with people waiting, and emails_to_paste ready for Slack''s "Add people to #channel" dialog. Bucketed by CHANNEL because that dialog takes a list — one paste clears a channel however many are waiting, whereas per-person means one member-management visit each.';

GRANT SELECT ON public.slack_channel_expected TO authenticated;
GRANT SELECT ON public.slack_channel_backlog  TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The map, and how many the KG expects in each channel. This works before any survey has run.
SELECT c.channel_name, c.scope, coalesce(c.wg_token, '—') AS wg,
       (SELECT count(*) FROM public.slack_channel_expected e WHERE e.channel_id = c.channel_id) AS expected
  FROM public.slack_channels c
 ORDER BY c.scope, c.channel_name;

-- 2) The backlog. Empty until the slack-survey function has run at least once — an empty result here
--    means "not surveyed yet", NOT "nobody is missing".
SELECT channel_name, waiting, oldest_pending::date, emails_to_paste
  FROM public.slack_channel_backlog;
