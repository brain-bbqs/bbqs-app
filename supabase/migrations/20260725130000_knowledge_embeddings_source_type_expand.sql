-- The unified index (feature 008) embeds all entity types, but the source_type CHECK only
-- allowed project/investigator/publication (+ legacy workflow/chat_interaction), so resource/
-- organization/announcement upserts failed the check. Widen the allowlist. Run in KG SQL editor.
ALTER TABLE public.knowledge_embeddings DROP CONSTRAINT IF EXISTS knowledge_embeddings_source_type_check;
ALTER TABLE public.knowledge_embeddings ADD CONSTRAINT knowledge_embeddings_source_type_check
  CHECK (source_type IN (
    'project','investigator','publication','resource','organization','announcement',
    'grant','workflow','chat_interaction'
  ));
