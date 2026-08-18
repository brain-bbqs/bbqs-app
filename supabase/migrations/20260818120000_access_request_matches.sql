-- Flag access requests that are probably an EXISTING member under a different address.
--
-- THE CASE. Flavia Vitale filed three times in two days, from three addresses:
--   vitalef@pennmedicine.upenn.edu   her actual record
--   vitalef@pennmedicine.upenn.esu   a typo (2026-08-17, approved, onboard then failed on the name index)
--   vitalef@upenn.edu                a real third Penn address (2026-08-18, pending)
-- She was fully onboarded before any of them. Each request cost an investigation because the row shows
-- only what the requester typed, and nothing on screen connected it to the person already in the roster.
--
-- WHY SHE KEPT ASKING. Two causes, neither hers. The intake form's membership check tests the address
-- AS TYPED, so an unrecorded alias reads as a stranger -- correct behaviour, no knowledge to do better.
-- And her welcome_email step was never sent, so nothing had ever confirmed she was in; from her side she
-- asked twice into silence and then tried another address.
--
-- WHY THIS IS ADMIN-SIDE ONLY. The intake form cannot say "you are already registered as
-- vitalef@pennmedicine.upenn.edu" -- that discloses one person's address to whoever is filling the form,
-- and it would make the form an address-enumeration oracle. This screen is already admin/curator-gated,
-- so disclosure here is fine, and it is where the decision actually gets made.
--
-- A VIEW rather than per-row calls to check_onboard_conflicts: one round trip for the whole queue
-- instead of one RPC per visible request, and the same matching rules in one place.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260818120000');

CREATE OR REPLACE VIEW public.access_request_matches
WITH (security_invoker = true)
AS
WITH req AS (
  SELECT ar.id,
         lower(btrim(ar.email)) AS email,
         lower(regexp_replace(btrim(coalesce(ar.full_name, ar.globus_name, '')),
                              '[[:space:]]+', ' ', 'g')) AS name_n,
         lower(split_part(btrim(ar.email), '@', 1)) AS local_part
    FROM public.access_requests ar
   WHERE ar.status = 'pending'
)
-- 1. This exact address is already a member. The request is simply unnecessary.
SELECT r.id AS request_id, 'already_member'::text AS match_kind,
       i.id AS investigator_id, i.name AS existing_name, i.email AS existing_email,
       format('%s is already a member — nothing to onboard.', i.name) AS note
  FROM req r
  JOIN public.investigators i
    ON lower(btrim(i.email)) = r.email
    OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s
                WHERE lower(btrim(s)) = r.email)

UNION ALL
-- 2. Same person by NAME, on a different address. What Flavia's third request looks like.
SELECT r.id, 'same_name_other_email',
       i.id, i.name, i.email,
       format('%s already exists as %s — likely the same person under another address.', i.name, i.email)
  FROM req r
  JOIN public.investigators i
    ON lower(regexp_replace(btrim(i.name), '[[:space:]]+', ' ', 'g')) = r.name_n
   AND i.email IS NOT NULL AND lower(btrim(i.email)) <> r.email
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s
                    WHERE lower(btrim(s)) = r.email)

UNION ALL
-- 3. Same mailbox name, different domain. Catches both the .esu typo and the upenn/pennmedicine split,
--    even when the typed name differs from the stored one.
SELECT r.id, 'same_mailbox_other_domain',
       i.id, i.name, i.email,
       format('%s has %s — same mailbox name, different domain (a typo, or a second institutional address).',
              i.name, i.email)
  FROM req r
  JOIN public.investigators i
    ON i.email IS NOT NULL
   AND lower(split_part(btrim(i.email), '@', 1)) = r.local_part
   AND lower(split_part(btrim(i.email), '@', 2)) <> split_part(r.email, '@', 2)
   AND r.local_part <> '';

COMMENT ON VIEW public.access_request_matches IS
  'Pending access requests that probably belong to an EXISTING member: exact address, same name on another address, or same mailbox name on another domain. Admin-side only — the intake form must not disclose another person''s address, which would make it an enumeration oracle.';

GRANT SELECT ON public.access_request_matches TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- Flavia's pending request should match on same_name_other_email AND same_mailbox_other_domain,
-- both naming vitalef@pennmedicine.upenn.edu.
SELECT ar.email AS requested, m.match_kind, m.existing_name, m.existing_email
  FROM public.access_request_matches m
  JOIN public.access_requests ar ON ar.id = m.request_id
 ORDER BY ar.email, m.match_kind;
