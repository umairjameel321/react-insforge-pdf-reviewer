-- PDF Reviewer schema: documents, one chat session per document, append-only
-- messages (short-term memory), pgvector PDF chunks (RAG) and long-term user
-- memories (factual + episodic).
--
-- Embeddings: liquid/lfm-2.5-embedding-350m:free -> 1024 dimensions.
-- 1024 keeps us under pgvector's 2000-dimension HNSW index ceiling.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Shared guard: ownership columns must never be reassigned after insert.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
CREATE TABLE public.documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  file_name     TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 300),
  file_key      TEXT NOT NULL,
  file_url      TEXT,
  -- Hard cap: 10 MiB. Keeps token spend low so free models stay viable.
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  page_count    INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0 AND page_count <= 120),
  char_count    INTEGER NOT NULL DEFAULT 0 CHECK (char_count >= 0),
  chunk_count   INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  summary       TEXT,
  status        TEXT NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing', 'ready', 'failed')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_select_own ON public.documents
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY documents_insert_own ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY documents_update_own ON public.documents
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY documents_delete_own ON public.documents
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The stored file identity and declared size are set once at upload time.
REVOKE UPDATE ON public.documents FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.documents TO authenticated;
GRANT UPDATE (title, page_count, char_count, chunk_count, summary, status, error, updated_at)
  ON public.documents TO authenticated;

CREATE INDEX documents_user_created_idx
  ON public.documents (user_id, created_at DESC);

CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

CREATE TRIGGER documents_owner_immutable
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();

-- ---------------------------------------------------------------------------
-- chat_sessions -- exactly one session per document
-- ---------------------------------------------------------------------------
CREATE TABLE public.chat_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL UNIQUE REFERENCES public.documents(id) ON DELETE CASCADE,
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  model           TEXT NOT NULL DEFAULT 'nvidia/nemotron-3-super-120b-a12b:free',
  message_count   INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_sessions_select_own ON public.chat_sessions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY chat_sessions_insert_own ON public.chat_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY chat_sessions_update_own ON public.chat_sessions
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY chat_sessions_delete_own ON public.chat_sessions
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Counters are maintained by trigger, not by the client.
REVOKE UPDATE ON public.chat_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.chat_sessions TO authenticated;
GRANT UPDATE (title, model, updated_at) ON public.chat_sessions TO authenticated;

CREATE INDEX chat_sessions_user_recent_idx
  ON public.chat_sessions (user_id, last_message_at DESC NULLS LAST, created_at DESC);

CREATE TRIGGER chat_sessions_updated_at
  BEFORE UPDATE ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

CREATE TRIGGER chat_sessions_owner_immutable
  BEFORE UPDATE ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();

-- ---------------------------------------------------------------------------
-- messages -- append-only short-term memory, scoped to one session
-- ---------------------------------------------------------------------------
CREATE TABLE public.messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 60000),
  model       TEXT,
  -- [{ chunk_index, page_from, page_to, similarity }]
  citations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- ids of long-term memories injected into this turn's prompt
  memory_ids  UUID[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_select_own ON public.messages
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- A message may only be written into a session the caller owns.
CREATE POLICY messages_insert_own ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.chat_sessions s
      WHERE s.id = session_id AND s.user_id = (SELECT auth.uid())
    )
  );

-- Append-only: no UPDATE, no direct DELETE. Removing a session cascades.
REVOKE UPDATE, DELETE ON public.messages FROM anon, authenticated;
GRANT SELECT, INSERT ON public.messages TO authenticated;

CREATE INDEX messages_session_created_idx
  ON public.messages (session_id, created_at);
CREATE INDEX messages_user_idx ON public.messages (user_id);

-- Keep session counters correct server-side.
CREATE OR REPLACE FUNCTION public.bump_session_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.chat_sessions
     SET message_count   = message_count + 1,
         last_message_at = NEW.created_at,
         updated_at      = NOW()
   WHERE id = NEW.session_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER messages_bump_session
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_session_activity();

-- ---------------------------------------------------------------------------
-- doc_chunks -- vector store for PDF retrieval
-- ---------------------------------------------------------------------------
CREATE TABLE public.doc_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL CHECK (chunk_index >= 0),
  page_from       INTEGER NOT NULL CHECK (page_from >= 1),
  page_to         INTEGER NOT NULL CHECK (page_to >= 1),
  content         TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 8000),
  embedding       vector(1024) NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT 'liquid/lfm-2.5-embedding-350m:free',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

ALTER TABLE public.doc_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY doc_chunks_select_own ON public.doc_chunks
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY doc_chunks_insert_own ON public.doc_chunks
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND d.user_id = (SELECT auth.uid())
    )
  );

-- Immutable once written; removed by cascade when the document is deleted.
REVOKE UPDATE, DELETE ON public.doc_chunks FROM anon, authenticated;
GRANT SELECT, INSERT ON public.doc_chunks TO authenticated;

CREATE INDEX doc_chunks_document_idx ON public.doc_chunks (document_id, chunk_index);
CREATE INDEX doc_chunks_user_idx ON public.doc_chunks (user_id);
CREATE INDEX doc_chunks_embedding_hnsw_idx
  ON public.doc_chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- user_memories -- long-term memory (factual + episodic), vector-searchable
-- ---------------------------------------------------------------------------
CREATE TABLE public.user_memories (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('factual', 'episodic')),
  content            TEXT NOT NULL CHECK (char_length(content) BETWEEN 3 AND 600),
  -- Dedupe key: same normalized sentence for the same user is one memory.
  content_hash       TEXT GENERATED ALWAYS AS (md5(lower(btrim(content)))) STORED,
  embedding          vector(1024) NOT NULL,
  embedding_model    TEXT NOT NULL DEFAULT 'liquid/lfm-2.5-embedding-350m:free',
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  source_session_id  UUID REFERENCES public.chat_sessions(id) ON DELETE SET NULL,
  use_count          INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  last_used_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, content_hash)
);

ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_memories_select_own ON public.user_memories
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY user_memories_insert_own ON public.user_memories
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY user_memories_update_own ON public.user_memories
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Users may forget a memory; the kind/vector are written by the extractor.
CREATE POLICY user_memories_delete_own ON public.user_memories
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE UPDATE ON public.user_memories FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.user_memories TO authenticated;
GRANT UPDATE (content, embedding, kind, use_count, last_used_at, updated_at)
  ON public.user_memories TO authenticated;

CREATE INDEX user_memories_user_idx ON public.user_memories (user_id, created_at DESC);
CREATE INDEX user_memories_embedding_hnsw_idx
  ON public.user_memories USING hnsw (embedding vector_cosine_ops);

CREATE TRIGGER user_memories_updated_at
  BEFORE UPDATE ON public.user_memories
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

CREATE TRIGGER user_memories_owner_immutable
  BEFORE UPDATE ON public.user_memories
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();

-- ---------------------------------------------------------------------------
-- Retrieval RPCs
--
-- SECURITY INVOKER: these run as the caller, so the owner-only RLS policies
-- above still decide which rows are visible. document scoping is an extra
-- filter on top of that, never a substitute for it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_doc_chunks(
  query_embedding vector(1024),
  p_document_id   UUID,
  match_count     INT DEFAULT 6,
  match_threshold DOUBLE PRECISION DEFAULT 0.15
)
RETURNS TABLE (
  id          UUID,
  chunk_index INTEGER,
  page_from   INTEGER,
  page_to     INTEGER,
  content     TEXT,
  similarity  DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.id,
         c.chunk_index,
         c.page_from,
         c.page_to,
         c.content,
         1 - (c.embedding <=> query_embedding) AS similarity
    FROM public.doc_chunks c
   WHERE c.document_id = p_document_id
     AND 1 - (c.embedding <=> query_embedding) >= match_threshold
   ORDER BY c.embedding <=> query_embedding
   LIMIT LEAST(GREATEST(match_count, 1), 20);
$$;

GRANT EXECUTE ON FUNCTION public.match_doc_chunks(vector, UUID, INT, DOUBLE PRECISION)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.match_user_memories(
  query_embedding vector(1024),
  match_count     INT DEFAULT 5,
  match_threshold DOUBLE PRECISION DEFAULT 0.20
)
RETURNS TABLE (
  id         UUID,
  kind       TEXT,
  content    TEXT,
  similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id,
         m.kind,
         m.content,
         1 - (m.embedding <=> query_embedding) AS similarity
    FROM public.user_memories m
   WHERE 1 - (m.embedding <=> query_embedding) >= match_threshold
   ORDER BY m.embedding <=> query_embedding
   LIMIT LEAST(GREATEST(match_count, 1), 20);
$$;

GRANT EXECUTE ON FUNCTION public.match_user_memories(vector, INT, DOUBLE PRECISION)
  TO authenticated;

-- Idempotent memory write: re-learning a known fact refreshes it instead of
-- creating a duplicate row. Owner is always taken from the session, never the
-- caller's payload.
CREATE OR REPLACE FUNCTION public.upsert_user_memory(
  p_kind        TEXT,
  p_content     TEXT,
  p_embedding   vector(1024),
  p_document_id UUID DEFAULT NULL,
  p_session_id  UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  INSERT INTO public.user_memories
    (user_id, kind, content, embedding, source_document_id, source_session_id)
  VALUES
    (v_uid, p_kind, p_content, p_embedding, p_document_id, p_session_id)
  ON CONFLICT (user_id, content_hash) DO UPDATE
    SET kind       = EXCLUDED.kind,
        embedding  = EXCLUDED.embedding,
        updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_user_memory(TEXT, TEXT, vector, UUID, UUID)
  TO authenticated;

-- Records that a memory was actually injected into a prompt.
CREATE OR REPLACE FUNCTION public.bump_memory_usage(p_ids UUID[])
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.user_memories
     SET use_count    = use_count + 1,
         last_used_at = NOW(),
         updated_at   = NOW()
   WHERE id = ANY(p_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bump_memory_usage(UUID[]) TO authenticated;

GRANT USAGE ON SCHEMA public TO authenticated;
