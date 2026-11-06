-- Funding opportunities carry their funders only as acronyms in participating_orgs (NIMH, NSF, ...),
-- so the graph could not link a call to the organization behind it (#475: FundingOpportunity was
-- isolated). This creates the funder organizations that are missing (each with its resources spine
-- row, resource_type 'organization'), a join table, and fills it from participating_orgs through an
-- explicit acronym map. Acronyms not in the map are left unlinked and reported, never guessed.
-- Idempotent: safe to run twice. Old rows are untouched; everything is audited via set_actor.
SELECT public.set_actor('migration:funding_opportunity_orgs');
SELECT public.set_source_class('curator_fill');

CREATE TABLE IF NOT EXISTS public.funding_opportunity_orgs (
  funding_opportunity_id uuid NOT NULL REFERENCES public.funding_opportunities(id) ON DELETE CASCADE,
  organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (funding_opportunity_id, organization_id)
);
COMMENT ON TABLE public.funding_opportunity_orgs IS
  'Funders of a funding opportunity, derived from funding_opportunities.participating_orgs via an explicit acronym map.';

ALTER TABLE public.funding_opportunity_orgs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone may read funding opportunity orgs" ON public.funding_opportunity_orgs;
CREATE POLICY "anyone may read funding opportunity orgs" ON public.funding_opportunity_orgs
  FOR SELECT USING (true);
GRANT SELECT ON public.funding_opportunity_orgs TO anon, authenticated;

DO $$
DECLARE
  m    record;
  _rid uuid;
  _oid uuid;
BEGIN
  FOR m IN
    SELECT * FROM (VALUES
      ('NIMH',   'National Institute of Mental Health'),
      ('NIDA',   'National Institute on Drug Abuse'),
      ('NINDS',  'National Institute of Neurological Disorders and Stroke'),
      ('NEI',    'National Eye Institute'),
      ('NIA',    'National Institute on Aging'),
      ('NIAAA',  'National Institute on Alcohol Abuse and Alcoholism'),
      ('NIBIB',  'National Institute of Biomedical Imaging and Bioengineering'),
      ('NIDCD',  'National Institute on Deafness and Other Communication Disorders'),
      ('NICHD',  'Eunice Kennedy Shriver National Institute of Child Health and Human Development'),
      ('NCCIH',  'National Center for Complementary and Integrative Health'),
      ('NIH OD (Common Fund)', 'NIH Office of the Director (Common Fund)'),
      ('OBSSR',  'NIH Office of Behavioral and Social Sciences Research'),
      ('ORWH',   'NIH Office of Research on Women''s Health'),
      ('NSF',    'National Science Foundation'),
      ('Simons Foundation',    'Simons Foundation'),
      ('Empire AI Consortium', 'Empire AI Consortium')
    ) AS t(acronym, full_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE lower(btrim(name)) = lower(m.full_name)) THEN
      -- same shape as the existing 37: the spine row points back at its organization in metadata
      _oid := gen_random_uuid();
      INSERT INTO public.resources (resource_type, name, metadata)
        VALUES ('organization', m.full_name,
                jsonb_build_object('source_id', _oid, 'source_table', 'organizations'))
        RETURNING id INTO _rid;
      INSERT INTO public.organizations (id, name, resource_id) VALUES (_oid, m.full_name, _rid);
    END IF;
  END LOOP;
END $$;

INSERT INTO public.funding_opportunity_orgs (funding_opportunity_id, organization_id)
SELECT DISTINCT f.id, o.id
FROM public.funding_opportunities f
CROSS JOIN LATERAL jsonb_array_elements_text(to_jsonb(f.participating_orgs)) AS a(acronym)
JOIN (VALUES
  ('NIMH',   'National Institute of Mental Health'),
  ('NIDA',   'National Institute on Drug Abuse'),
  ('NINDS',  'National Institute of Neurological Disorders and Stroke'),
  ('NEI',    'National Eye Institute'),
  ('NIA',    'National Institute on Aging'),
  ('NIAAA',  'National Institute on Alcohol Abuse and Alcoholism'),
  ('NIBIB',  'National Institute of Biomedical Imaging and Bioengineering'),
  ('NIDCD',  'National Institute on Deafness and Other Communication Disorders'),
  ('NICHD',  'Eunice Kennedy Shriver National Institute of Child Health and Human Development'),
  ('NCCIH',  'National Center for Complementary and Integrative Health'),
  ('NIH OD (Common Fund)', 'NIH Office of the Director (Common Fund)'),
  ('OBSSR',  'NIH Office of Behavioral and Social Sciences Research'),
  ('ORWH',   'NIH Office of Research on Women''s Health'),
  ('NSF',    'National Science Foundation'),
  ('Simons Foundation',    'Simons Foundation'),
  ('Empire AI Consortium', 'Empire AI Consortium')
) AS map(acronym, full_name) ON map.acronym = a.acronym
JOIN public.organizations o ON lower(btrim(o.name)) = lower(map.full_name)
WHERE f.participating_orgs IS NOT NULL
ON CONFLICT DO NOTHING;

-- Verify: every acronym should be mapped (expect 0 unmapped), and each call linked to its funders.
SELECT DISTINCT a.acronym AS unmapped_acronym
FROM public.funding_opportunities f
CROSS JOIN LATERAL jsonb_array_elements_text(to_jsonb(f.participating_orgs)) AS a(acronym)
WHERE f.participating_orgs IS NOT NULL
  AND a.acronym NOT IN ('NIMH','NIDA','NINDS','NEI','NIA','NIAAA','NIBIB','NIDCD','NICHD','NCCIH',
    'NIH OD (Common Fund)','OBSSR','ORWH','NSF','Simons Foundation','Empire AI Consortium');

SELECT f.title, count(fo.organization_id) AS funders
FROM public.funding_opportunities f
LEFT JOIN public.funding_opportunity_orgs fo ON fo.funding_opportunity_id = f.id
GROUP BY f.id, f.title ORDER BY funders, f.title;
