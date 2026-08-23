-- Machine output should say so. 2,566 computed trait scores currently read "G8 no recorded source".
--
-- WHAT THEY ARE. personality-score-worker scores each person's own text (comments, feature
-- suggestions) against an adjective lexicon, age-of-acquisition weighted after Roivainen 2022, and
-- writes big_five.{o,c,e,a,s}, hexaco.{h,e,x,o,c,a} and top_adjectives. It is a deterministic
-- lexicon match, not an LLM: same text in, same numbers out. That is precisely G5 `algorithmic` --
-- the class added in 20260820140000 for exactly this, "a rule produced this, not a person and not a
-- registry".
--
-- WHY THE CURRENT GRADE IS WORSE THAN WRONG. G8 means "no recorded source", so these read as
-- unsourced data awaiting a curator's blessing. They are the opposite: their provenance is fully
-- known -- known function, known lexicon, known inputs, reproducible on demand. Meanwhile nobody
-- can ever "verify" that someone's openness score is 0.62 by checking it against anything, so the
-- review button on them is an invitation to rubber-stamp a number.
--
-- Constitution XI, bindings: "G5-G8 must be visibly marked" and "an AI helped is not provenance --
-- name the model and date the value". A trait score attributed to nothing fails both. Naming the
-- worker and the lexicon in source_ref satisfies both.
--
-- 2,566 cells: 226 people x 11 trait dimensions, plus 80 top_adjectives arrays. This is 42% of the
-- review queue after 20260822170000 removes the bookkeeping, so it is the difference between a queue
-- a person can work through and one they cannot.
--
-- NOT A VERIFIED CLASS. algorithmic is_verified = false, deliberately. These do not become
-- trustworthy by being labelled; they become HONEST. They stay outside the verified count, they
-- keep an amber chip in the UI, and they leave the curator queue because no curator can confirm them.
--
-- The 678 token_count / matched_count / last_computed_at cells are handled in 20260822170000: those
-- are bookkeeping about the computation, not claims.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822180000');

-- ── 1. Re-declare the scores as what produced them ──────────────────────────────────────────
-- Append, never update: the G8 rows stay as the historical record of what the store used to claim,
-- and DISTINCT ON picks these up as the standing claim.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, model_id, recorded_by)
SELECT 'personality_scores',
       fpc.entity_id,
       fpc.entity_column,
       'algorithmic',
       'lexicon_trait_scoring',
       'personality-score-worker',
       'supabase/functions/personality-score-worker + adjectives.json',
       fpc.value_text,
       'Age-of-acquisition weighted adjective-lexicon match over the person''s own text '
         || '(Roivainen 2022). Deterministic: no model, no human judgement. Reproducible by '
         || 're-running the worker on the same input.',
       NULL,   -- explicitly no model: this is a lexicon, and claiming a model would be a lie
       'migration:20260822180000'
  FROM public.field_provenance_current fpc
 WHERE fpc.entity_table = 'personality_scores'
   AND fpc.source_class = 'unknown'
   AND public.provenance_is_gradable_column(fpc.entity_column)
   AND btrim(coalesce(fpc.value_text, '')) <> '';

-- ── 2. Make the worker declare itself from now on ────────────────────────────────────────────
-- Without this the next run writes as an undeclared service role and lands back at G8. The worker
-- must call set_source_class('algorithmic') -- or send x-bbqs-source-class: algorithmic -- before
-- it upserts. Recorded here so the requirement is discoverable from the schema.
COMMENT ON TABLE public.personality_scores IS
  'Trait scores from personality-score-worker: age-of-acquisition weighted adjective-lexicon match over each person''s own text (Roivainen 2022). Deterministic, not an LLM. The worker MUST declare set_source_class(''algorithmic'') before writing, or the guard records its output as G8 "no recorded source" -- which is what happened until 20260822180000, putting 2,566 computed numbers in the curator review queue.';

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Every trait cell now reads algorithmic. Expect one row: algorithmic, ~2566.
SELECT source_label, source_grade, count(*) AS cells
  FROM public.field_provenance_current
 WHERE entity_table = 'personality_scores'
 GROUP BY source_label, source_grade ORDER BY cells DESC;

-- 2) They leave the curator queue. Expect 0.
SELECT count(*) AS scores_still_queued
  FROM public.provenance_worklist WHERE entity_table = 'personality_scores';

-- 3) Still NOT counted as verified -- labelling is not vouching. Expect verified = 0.
SELECT table_name, cells, verified, pct_verified
  FROM public.provenance_coverage WHERE table_name = 'personality_scores';

-- 4) A spot check that the claim carries a followable source_ref.
SELECT entity_column, source_label, agent_label, source_ref
  FROM public.field_provenance_current
 WHERE entity_table = 'personality_scores' LIMIT 3;

-- 5) The whole queue, after this and 20260822170000. ~6,142 - ~2,566 = ~3,576 cells that a human
--    can actually look at and judge, down from 8,099.
SELECT count(*) AS queue_size FROM public.provenance_worklist;
