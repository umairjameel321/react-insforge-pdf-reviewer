export type DocumentStatus = 'processing' | 'ready' | 'failed'

export interface PdfDocument {
  id: string
  user_id: string
  title: string
  file_name: string
  file_key: string
  file_url: string | null
  byte_size: number
  page_count: number
  char_count: number
  chunk_count: number
  summary: string | null
  status: DocumentStatus
  error: string | null
  created_at: string
  updated_at: string
}

export interface ChatSession {
  id: string
  user_id: string
  document_id: string
  title: string
  model: string
  message_count: number
  last_message_at: string | null
  created_at: string
  updated_at: string
}

/** A session row joined with the document it belongs to, for the library list. */
export interface SessionWithDocument extends ChatSession {
  documents: Pick<
    PdfDocument,
    'id' | 'title' | 'file_name' | 'page_count' | 'byte_size' | 'status' | 'error' | 'chunk_count'
  > | null
}

export interface Citation {
  chunk_index: number
  page_from: number
  page_to: number
  similarity: number
}

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  model: string | null
  citations: Citation[]
  memory_ids: string[]
  created_at: string
}

export type MemoryKind = 'factual' | 'episodic'

export interface UserMemory {
  id: string
  kind: MemoryKind
  content: string
  use_count: number
  last_used_at: string | null
  source_document_id: string | null
  created_at: string
}

export interface FreeModel {
  id: string
  name: string
  contextLength: number
}

export interface ChatTurnResult {
  answer: string
  model: string
  citations: Citation[]
  memoriesUsed: Array<{ id: string; kind: MemoryKind; content: string }>
}
