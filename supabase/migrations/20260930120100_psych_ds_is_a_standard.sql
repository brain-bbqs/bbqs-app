-- Psych-DS was filed as resource_type 'grant', which made it a BBQS Project node with no grants row
-- behind it (KG invariant #1). It is a data standard, funded by an NIH award outside BBQS
-- (RF1MH132747 on RePORTER). The award goes onto the standard as data, so the graph can carry it and
-- the row can be rebuilt from the graph. Run after 20260930120000_resource_type_standard.sql.
SELECT public.set_actor('migration:psych_ds_is_a_standard');

SELECT public.set_source_class('curated_with_ai');
UPDATE public.resources
   SET resource_type = 'standard', updated_at = now()
 WHERE id = '8e67d548-47b3-4b48-9a70-e5e22c56f062' AND resource_type = 'grant';

SELECT public.set_source_class('authoritative_registry');
UPDATE public.resources
   SET metadata = coalesce(metadata, '{}'::jsonb) || '{"award_numbers": ["RF1MH132747"]}'::jsonb,
       updated_at = now()
 WHERE id = '8e67d548-47b3-4b48-9a70-e5e22c56f062';

-- Verify: one row, now a standard, carrying its award.
SELECT id, resource_type, metadata->'award_numbers' AS award_numbers
  FROM public.resources WHERE id = '8e67d548-47b3-4b48-9a70-e5e22c56f062';
