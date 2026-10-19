-- Dynestyx was added through bbqs-mcp add_resource before the tool coerced booleans, so
-- metadata.containerized landed as the string "false" -- which the Resources page reads as truthy.
-- add_resource could not repair it: curators may INSERT resources but RLS blocks UPDATE.
SELECT public.set_actor('migration:dynestyx_containerized_boolean');

UPDATE public.resources
   SET metadata = jsonb_set(metadata, '{containerized}', 'false'::jsonb)
 WHERE id = '2759fdf8-4690-4aea-b5d6-3a44bd3270e4'
   AND metadata->>'containerized' = 'false'
   AND jsonb_typeof(metadata->'containerized') = 'string';
