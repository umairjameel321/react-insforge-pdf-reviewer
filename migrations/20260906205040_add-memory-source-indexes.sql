-- Both source columns are ON DELETE SET NULL foreign keys. Without an index,
-- deleting a document or session forces a sequential scan of user_memories to
-- find the rows to null out, which gets slower as memory accumulates.
-- Flagged by `insforge diagnose advisor` as missing-fk-index.

CREATE INDEX user_memories_source_document_idx
  ON public.user_memories (source_document_id)
  WHERE source_document_id IS NOT NULL;

CREATE INDEX user_memories_source_session_idx
  ON public.user_memories (source_session_id)
  WHERE source_session_id IS NOT NULL;
