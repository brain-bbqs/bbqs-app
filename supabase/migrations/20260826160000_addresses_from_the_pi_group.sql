-- Record the addresses these people are already reachable at.
--
-- SOURCE. The pi@brain-bbqs.org member export, 2026-08-26 (90 rows). Cross-validated against the
-- 74-person roster: 86 of those rows are 69 PIs, 4 are group administration (admin@ owner, two
-- managers) and one unidentified address. Every mapping below is a person whose KG record does not
-- contain an address they are demonstrably subscribed under -- read from the export, not inferred
-- from a local part.
--
-- WHY IT MATTERS. group-audit builds pi@'s expected set from `investigators.email` alone, so a PI
-- with an empty primary is not expected anywhere: that is why the audit reports expected 56 against
-- a roster of 74. And because the address they ARE subscribed under belongs to no member record, the
-- audit cannot tie the membership to the member either -- it lands in "protected", counted as
-- neither missing nor removable. Ten people were invisible from both directions at once.
--
-- WHAT THIS IS NOT. It does not add anyone to a group, remove anyone, or change a role.
-- `trg_sync_member_groups` fires only when role or working_groups changes, so writing email and
-- secondary_emails emits nothing outward. These are the addresses they already receive mail at.
--
-- IDEMPOTENT AND ORDER-INDEPENDENT. Primary is set only where it is currently EMPTY, so this never
-- fights 20260826120000 (which promotes secondaries for Field, Olveczky and Widge, and merges the
-- Roberts and Grinband records). Whichever order the two run in, the end state is the same: every
-- person has a primary, and every address they are subscribed under is recorded somewhere on their
-- record. Running this file twice changes nothing the second time.
--
-- Recommended order all the same: 20260826120000 first, then this. Run the other way round and the
-- Grinband entry is skipped with a NOTICE rather than applied -- his address currently sits on the
-- duplicate record, and investigators_email_unique_ci will not let two rows hold it.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('curator:addresses-from-pi-group-20260826');
-- A person reading a group export and deciding these are the right addresses. Not a registry.
SELECT public.set_source_class('curator_fill');

-- ── 0. Before ──────────────────────────────────────────────────────────────────────────────────
SELECT count(DISTINCT gi.investigator_id) FILTER (WHERE coalesce(btrim(i.email), '') <> '') AS pis_with_email,
       count(DISTINCT gi.investigator_id)                                                   AS roster_pis
  FROM public.grant_investigators gi
  JOIN public.investigators i ON i.id = gi.investigator_id
 WHERE lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi');

DO $do$
DECLARE
  _r record;
  _filled int := 0;
  _aliased int := 0;
BEGIN
  PERFORM public.set_actor('curator:addresses-from-pi-group-20260826');
  PERFORM public.set_source_class('curator_fill');

  FOR _r IN
    -- (investigator, the address to prefer as primary, every address they hold in pi@)
    -- Where someone is subscribed twice, the institutional address is the primary and the personal
    -- one becomes a secondary -- the audit treats a secondary as "already a member", so both keep
    -- working and neither produces a second subscription.
    SELECT * FROM (VALUES
      ('82751e5a-0987-474a-98b9-7ae068507ce6'::uuid, 'danielwesson@ufl.edu',      ARRAY['danielwesson@ufl.edu']),
      ('9d7a13b8-629e-4edb-a4d1-d5f5f4768b0c'::uuid, 'katherine.nagel@nyumc.org', ARRAY['katherine.nagel@nyumc.org']),
      ('e798fd42-dbfd-491e-bf22-38dd5a1b2bbe'::uuid, 'kostas@cis.upenn.edu',      ARRAY['kostas@cis.upenn.edu']),
      ('bbf1c2a3-36fd-4740-ab32-57ad5b3cf915'::uuid, 'monika.jadi@yale.edu',      ARRAY['monika.jadi@yale.edu']),
      ('cb84a80d-ad3a-445c-9fb8-288db9631150'::uuid, 'nanthia@ucla.edu',          ARRAY['nanthia@ucla.edu']),
      ('8024a245-a4ad-432b-9d87-c8aff484c141'::uuid, 'pgrover@andrew.cmu.edu',    ARRAY['pgrover@andrew.cmu.edu']),
      ('5ffdcb2e-b5c1-4c13-81ed-ccec5f1b5e2e'::uuid, 'shreya.saxena@yale.edu',    ARRAY['shreya.saxena@yale.edu']),
      ('d184fe4e-9040-46ff-a6d8-90e1386d7305'::uuid, 'vijay@physics.upenn.edu',   ARRAY['vijay@physics.upenn.edu']),
      ('bb4daeed-e4e8-4ed3-8f57-8ac245b4d4c0'::uuid, 'zhengkua@andrew.cmu.edu',   ARRAY['zhengkua@andrew.cmu.edu']),
      -- Identified by the PI, 2026-08-26. zw24@cornell.edu was the one pi@ address that matched no
      -- member record: Z. Jane Wang at Cornell, whom RePORTER lists as "Jane  Wang", co_pi on
      -- R34DA059500. With this the export has no unexplained addresses left -- the only rows that
      -- are not a PI are admin@ (owner) and the two managers.
      ('200ceb1a-739b-4fa1-b259-93aeefbce55b'::uuid, 'zw24@cornell.edu',          ARRAY['zw24@cornell.edu']),
      -- Subscribed twice; chop.edu is the institutional form. 20260826120000 may already have given
      -- him robertstim@chop.edu from the record folded into him -- a THIRD address for one person,
      -- which is the duplicate showing through. All of them get recorded; none is guessed.
      ('c513c629-cc53-4b42-9902-54322bc96d61'::uuid, 'robertstim@email.chop.edu',
         ARRAY['robertstim@email.chop.edu', 'robertstim01@gmail.com']),
      -- Both of these are handled by 20260826120000 if it ran first; harmless and idempotent here.
      ('0aa1adf0-c841-4513-928b-260afbff27ae'::uuid, 'jg2269@cumc.columbia.edu',  ARRAY['jg2269@cumc.columbia.edu']),
      ('0363e75e-d8c2-4af8-96a6-4534c9de52ff'::uuid, 'gfield@duke.edu',           ARRAY['greg.d.field@gmail.com']),
      ('49d73b8e-c794-48f5-8155-19e2bde865a4'::uuid, 'sharksinmyhead@gmail.com',  ARRAY['awidge@umn.edu']),
      -- Already has a primary; the gmail is an ALIAS he posts from, not a correction.
      ('1e91330a-0f00-45ad-a600-7a3922538595'::uuid, NULL,                        ARRAY['schmidt.schm@gmail.com'])
    ) AS v(investigator_id, preferred_primary, group_addresses)
  LOOP
    -- Primary only where there is none. Never overwrite an address someone put there.
    --
    -- And never collide: investigators_email_unique_ci (20260807190000) is a UNIQUE index on
    -- lower(btrim(email)), so one address cannot sit on two rows. That is exactly what a split
    -- person looks like -- jg2269@cumc.columbia.edu is on the DUPLICATE Grinband record while the
    -- roster row it belongs to has none. Assigning it here failed the whole migration with 23505.
    -- Report and skip instead: 20260826120000 merges those records and moves the address across,
    -- after which this entry is a no-op because the primary is no longer empty.
    IF _r.preferred_primary IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.investigators o
                  WHERE o.id <> _r.investigator_id
                    AND lower(btrim(o.email)) = lower(btrim(_r.preferred_primary))) THEN
        RAISE NOTICE 'skipped %: another investigators row already holds that address — merge the duplicate first (20260826120000)', _r.preferred_primary;
      ELSE
        UPDATE public.investigators
           SET email = _r.preferred_primary
         WHERE id = _r.investigator_id
           AND coalesce(btrim(email), '') = '';
        IF FOUND THEN _filled := _filled + 1; END IF;
      END IF;
    END IF;

    -- Every group address ends up recorded: skipped if it is now the primary, otherwise a secondary.
    UPDATE public.investigators i
       SET secondary_emails = ARRAY(
             SELECT DISTINCT e
               FROM unnest(coalesce(i.secondary_emails, '{}'::text[]) || _r.group_addresses) AS e
              WHERE e IS NOT NULL
                AND btrim(e) <> ''
                AND lower(btrim(e)) <> lower(coalesce(btrim(i.email), '~none~')))
     WHERE i.id = _r.investigator_id
       AND EXISTS (
         SELECT 1 FROM unnest(_r.group_addresses) AS g
          WHERE lower(g) <> lower(coalesce(btrim(i.email), '~none~'))
            AND NOT (lower(g) = ANY (SELECT lower(x) FROM unnest(coalesce(i.secondary_emails, '{}'::text[])) AS x)));
    IF FOUND THEN _aliased := _aliased + 1; END IF;
  END LOOP;

  RAISE NOTICE 'primary email filled for % people; alias recorded for %', _filled, _aliased;

  -- A stray note inside an address field. "anirvan.nandy@gmail.com (for google groups)" is not an
  -- address, and any exact-match membership check fails on it -- the clean form is already present
  -- alongside it, so this only drops the annotated duplicate.
  UPDATE public.investigators
     SET secondary_emails = ARRAY(
           SELECT DISTINCT btrim(e)
             FROM unnest(coalesce(secondary_emails, '{}'::text[])) AS e
            WHERE btrim(e) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
   WHERE EXISTS (
     SELECT 1 FROM unnest(coalesce(secondary_emails, '{}'::text[])) AS e
      WHERE btrim(e) <> '' AND btrim(e) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
  GET DIAGNOSTICS _filled = ROW_COUNT;
  RAISE NOTICE 'records with a malformed secondary address cleaned: %', _filled;
END
$do$;

SELECT public.set_source_class(NULL);

-- ── Verify ─────────────────────────────────────────────────────────────────────────────────────
-- 1) The count group-audit will report. 56 of 74 before this migration; 13 of the 18 people with no
--    address are filled here, so expect 69. With 20260826120000 also applied, 71 -- it supplies
--    Olveczky, whom pi@ cannot because he is not in the group, and Jane Wang is filled here.
SELECT count(DISTINCT gi.investigator_id) FILTER (WHERE coalesce(btrim(i.email), '') <> '') AS pis_with_email,
       count(DISTINCT gi.investigator_id)                                                   AS roster_pis
  FROM public.grant_investigators gi
  JOIN public.investigators i ON i.id = gi.investigator_id
 WHERE lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi');

-- 2) Read the fourteen back. Constitution VIII: the UPDATE reporting success is not the value
--    being there.
SELECT name, email, array_to_string(secondary_emails, '; ') AS secondary_emails
  FROM public.investigators
 WHERE id IN ('82751e5a-0987-474a-98b9-7ae068507ce6','9d7a13b8-629e-4edb-a4d1-d5f5f4768b0c',
              'e798fd42-dbfd-491e-bf22-38dd5a1b2bbe','bbf1c2a3-36fd-4740-ab32-57ad5b3cf915',
              'cb84a80d-ad3a-445c-9fb8-288db9631150','8024a245-a4ad-432b-9d87-c8aff484c141',
              '5ffdcb2e-b5c1-4c13-81ed-ccec5f1b5e2e','d184fe4e-9040-46ff-a6d8-90e1386d7305',
              'bb4daeed-e4e8-4ed3-8f57-8ac245b4d4c0','c513c629-cc53-4b42-9902-54322bc96d61',
              '0aa1adf0-c841-4513-928b-260afbff27ae','0363e75e-d8c2-4af8-96a6-4534c9de52ff',
              '49d73b8e-c794-48f5-8155-19e2bde865a4','1e91330a-0f00-45ad-a600-7a3922538595')
 ORDER BY name;

-- 3) No address field anywhere still holds something that is not an address.
SELECT name, secondary_emails
  FROM public.investigators
 WHERE EXISTS (SELECT 1 FROM unnest(coalesce(secondary_emails, '{}'::text[])) AS e
                WHERE btrim(e) <> '' AND btrim(e) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

-- 4) Nobody ended up with the same address as primary AND secondary.
SELECT name, email, secondary_emails
  FROM public.investigators
 WHERE lower(coalesce(email, '~none~')) = ANY (
         SELECT lower(x) FROM unnest(coalesce(secondary_emails, '{}'::text[])) AS x);

-- ── AFTERWARDS ─────────────────────────────────────────────────────────────────────────────────
-- Run /admin -> Group Audit. pi@'s expected set has grown from 56 to 71 with 20260826120000 applied,
-- and every one of those
-- new expectations should resolve as ALREADY a member -- their address, or an alias of it, is
-- already in the group. If Repair wants to ADD any of these fourteen, an alias did not take and
-- that person is about to be subscribed twice; stop and check the row rather than repairing.
--
-- Three PIs still have no address, because they are not in pi@ either and the group cannot supply
-- what it does not hold: Flavio Frohlich, Jonathan E. Rubin, Nathan Christopher Shaner. They have
-- to be asked.
--
-- And one PI now has an address but is NOT in pi@: Bence Olveczky, whose bolveczky@gmail.com
-- 20260826120000 promoted from his secondaries. He is the one person Group Audit should genuinely
-- propose ADDING -- everyone else it newly expects is already a member under that address or an
-- alias of it.
