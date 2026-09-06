import { DEFAULT_MODEL, MAX_PDF_BYTES, PDF_BUCKET, insforge } from './insforge'
import { PdfExtractionError, extractPdf } from './pdf'
import type {
  ChatMessage,
  ChatSession,
  ChatTurnResult,
  FreeModel,
  PdfDocument,
  SessionWithDocument,
  UserMemory,
} from './types'

export class ApiError extends Error {}

/**
 * InsForge surfaces failures as `{ message }` in some paths and `{ error }` in
 * others (edge-function non-2xx responses), so read whichever is present.
 */
function reason(error: unknown): string {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  const candidate = error as { message?: string; error?: string }
  return candidate.message || candidate.error || 'unknown error'
}

function unwrap<T>(result: { data: T | null; error: unknown }, what: string): T {
  if (result.error) throw new ApiError(`${what}: ${reason(result.error)}`)
  if (result.data === null || result.data === undefined) throw new ApiError(`${what}: no data`)
  return result.data
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/** One row per uploaded PDF — a new PDF always means a new session. */
export async function listSessions(): Promise<SessionWithDocument[]> {
  const result = await insforge.database
    .from('chat_sessions')
    .select(
      'id, user_id, document_id, title, model, message_count, last_message_at, created_at, updated_at, ' +
        'documents(id, title, file_name, page_count, byte_size, status, error, chunk_count)',
    )
    .order('created_at', { ascending: false })
    .limit(100)

  return unwrap(result, 'Loading your sessions failed') as unknown as SessionWithDocument[]
}

export async function getSession(
  sessionId: string,
): Promise<{ session: ChatSession; document: PdfDocument }> {
  const session = unwrap(
    await insforge.database
      .from('chat_sessions')
      .select('id, user_id, document_id, title, model, message_count, last_message_at, created_at, updated_at')
      .eq('id', sessionId)
      .maybeSingle(),
    'Loading the session failed',
  ) as ChatSession

  const document = unwrap(
    await insforge.database
      .from('documents')
      .select(
        'id, user_id, title, file_name, file_key, file_url, byte_size, page_count, char_count, ' +
          'chunk_count, summary, status, error, created_at, updated_at',
      )
      .eq('id', session.document_id)
      .maybeSingle(),
    'Loading the document failed',
  ) as PdfDocument

  return { session, document }
}

export async function setSessionModel(sessionId: string, model: string): Promise<void> {
  const { error } = await insforge.database
    .from('chat_sessions')
    .update({ model })
    .eq('id', sessionId)

  if (error) throw new ApiError(`Switching model failed: ${reason(error)}`)
}

/**
 * Deleting the document cascades to its session, chunks and messages, so the
 * stored file is the only thing left to clean up by hand.
 */
export async function deleteSession(documentId: string, fileKey: string): Promise<void> {
  const { error } = await insforge.database.from('documents').delete().eq('id', documentId)
  if (error) throw new ApiError(`Deleting failed: ${reason(error)}`)

  await insforge.storage.from(PDF_BUCKET).remove(fileKey)
}

/* -------------------------------------------------------------------------- */
/* Upload + ingestion                                                          */
/* -------------------------------------------------------------------------- */

export interface UploadProgress {
  stage: 'reading' | 'uploading' | 'indexing'
  detail: string
}

export async function uploadPdf(
  file: File,
  onProgress: (progress: UploadProgress) => void,
): Promise<{ sessionId: string }> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new ApiError('Only PDF files can be uploaded.')
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new ApiError(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_PDF_BYTES / 1024 / 1024} MB so free models stay within budget.`,
    )
  }

  const { data: userData } = await insforge.auth.getCurrentUser()
  const userId = userData?.user?.id
  if (!userId) throw new ApiError('Your session expired. Sign in again.')

  // Parse first: a PDF with no selectable text should fail before it costs an upload.
  onProgress({ stage: 'reading', detail: 'Reading the document' })
  let extraction
  try {
    extraction = await extractPdf(file)
  } catch (err) {
    if (err instanceof PdfExtractionError) throw new ApiError(err.message)
    throw err
  }

  const documentId = crypto.randomUUID()
  // First path segment is the owner claim enforced by the storage RLS policy.
  const fileKey = `${userId}/${documentId}.pdf`
  const title = file.name.replace(/\.pdf$/i, '').slice(0, 300) || 'Untitled document'

  onProgress({ stage: 'uploading', detail: 'Uploading to storage' })
  const upload = await insforge.storage.from(PDF_BUCKET).upload(fileKey, file)
  if (upload.error) throw new ApiError(`Upload failed: ${reason(upload.error)}`)

  const cleanupFile = async () => {
    await insforge.storage.from(PDF_BUCKET).remove(fileKey)
  }

  const documentInsert = await insforge.database
    .from('documents')
    .insert([
      {
        id: documentId,
        user_id: userId,
        title,
        file_name: file.name.slice(0, 300),
        file_key: fileKey,
        file_url: upload.data?.url ?? null,
        byte_size: file.size,
        page_count: extraction.pageCount,
        char_count: extraction.charCount,
        status: 'processing',
      },
    ])
    .select()

  if (documentInsert.error) {
    await cleanupFile()
    throw new ApiError(`Saving the document failed: ${reason(documentInsert.error)}`)
  }

  const sessionInsert = await insforge.database
    .from('chat_sessions')
    .insert([{ user_id: userId, document_id: documentId, title, model: DEFAULT_MODEL }])
    .select()

  if (sessionInsert.error) {
    await insforge.database.from('documents').delete().eq('id', documentId)
    await cleanupFile()
    throw new ApiError(`Creating the chat session failed: ${reason(sessionInsert.error)}`)
  }

  const session = (Array.isArray(sessionInsert.data) ? sessionInsert.data[0] : sessionInsert.data) as ChatSession

  onProgress({
    stage: 'indexing',
    detail: `Embedding ${extraction.chunks.length} passages and writing the review`,
  })

  const ingest = await insforge.functions.invoke<{ error?: string; chunkCount?: number }>(
    'ingest-pdf',
    { body: { documentId, sessionId: session.id, chunks: extraction.chunks } },
  )

  if (ingest.error || ingest.data?.error) {
    throw new ApiError(
      `Indexing failed: ${ingest.data?.error ?? reason(ingest.error)}`,
    )
  }

  return { sessionId: session.id }
}

/* -------------------------------------------------------------------------- */
/* Chat                                                                        */
/* -------------------------------------------------------------------------- */

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const result = await insforge.database
    .from('messages')
    .select('id, session_id, role, content, model, citations, memory_ids, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(200)

  return unwrap(result, 'Loading the conversation failed') as ChatMessage[]
}

export async function sendMessage(
  sessionId: string,
  message: string,
  model: string,
): Promise<ChatTurnResult> {
  const { data, error } = await insforge.functions.invoke<ChatTurnResult & { error?: string }>(
    'chat',
    { body: { sessionId, message, model } },
  )

  if (error || data?.error || !data?.answer) {
    throw new ApiError(data?.error ?? reason(error))
  }

  return data
}

/** Best-effort and intentionally not awaited by the chat flow. */
export async function extractMemory(sessionId: string): Promise<void> {
  await insforge.functions.invoke('extract-memory', { body: { sessionId } })
}

/* -------------------------------------------------------------------------- */
/* Long-term memory                                                            */
/* -------------------------------------------------------------------------- */

export async function listMemories(): Promise<UserMemory[]> {
  const result = await insforge.database
    .from('user_memories')
    .select('id, kind, content, use_count, last_used_at, source_document_id, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  return unwrap(result, 'Loading memories failed') as UserMemory[]
}

export async function deleteMemory(id: string): Promise<void> {
  const { error } = await insforge.database.from('user_memories').delete().eq('id', id)
  if (error) throw new ApiError(`Forgetting that memory failed: ${reason(error)}`)
}

/* -------------------------------------------------------------------------- */
/* Models + file access                                                        */
/* -------------------------------------------------------------------------- */

export async function listFreeModels(): Promise<FreeModel[]> {
  const { data } = await insforge.functions.invoke<{ models?: FreeModel[] }>('list-models', {
    body: {},
  })

  const models = data?.models ?? []
  return models.length ? models : [{ id: DEFAULT_MODEL, name: 'Nemotron 3 Super 120B', contextLength: 262144 }]
}

/** Private bucket, so the file is pulled through the SDK with the user's session. */
export async function getPdfBlob(fileKey: string): Promise<Blob> {
  const { data, error } = await insforge.storage.from(PDF_BUCKET).download(fileKey)
  if (error || !data) throw new ApiError(`Opening the PDF failed: ${reason(error)}`)
  return data
}
