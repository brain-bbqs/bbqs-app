-- knowledge_embeddings upserts use ON CONFLICT (source_id) (embed-knowledge + discovery-chat's
-- lazy write-back), but there was NO unique index on source_id, so every upsert failed with
-- "no unique or exclusion constraint matching the ON CONFLICT specification". Dedupe (keep one
-- row per source_id) then add the unique index. Run in the KG SQL editor.
DELETE FROM public.knowledge_embeddings a
USING public.knowledge_embeddings b
WHERE a.source_id = b.source_id AND a.ctid < b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_embeddings_source_id_key
  ON public.knowledge_embeddings (source_id);
