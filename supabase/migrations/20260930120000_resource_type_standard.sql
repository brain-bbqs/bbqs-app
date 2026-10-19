-- Data and metadata standards (Psych-DS, NWB, BIDS) get their own node type instead of borrowing
-- 'grant'. ADD VALUE must commit before any row can use the value, so the retype of Psych-DS is the
-- next migration, run after this one.
SELECT public.set_actor('migration:resource_type_standard');

ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'standard';
