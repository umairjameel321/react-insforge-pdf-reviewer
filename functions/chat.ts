// Edge function: chat
//
// One turn of the playground. Assembles the prompt from three sources:
//   1. RAG   - nearest PDF chunks for this document only (pgvector)
//   2. STM   - recent messages from this document's single session
//   3. LTM   - semantically relevant long-term user memories (pgvector)
// then answers with a free model and appends both messages to the session.

import { createClient } from 'npm:@insforge/sdk'

const EMBEDDING_MODEL = 'liquid/lfm-2.5-embedding-350m:free'
const EMBEDDING_DIMS = 1024

const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
const FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m2.7:free',
  'nvidia/nemotron-3.5-lightning:free',
  'openrouter/free',
]

const RAG_CHUNKS = 6
const MEMORY_MATCHES = 5
const HISTORY_TURNS = 12
const MAX_MESSAGE_CHARS = 4000

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

async function embedOne(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: [text] }),
  })

  if (!res.ok) {
    throw new Error(`embedding request failed (${res.status})`)
  }

  const embedding = (await res.json())?.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) {
    throw new Error(`expected ${EMBEDDING_DIMS}-dimension embeddings`)
  }
  return embedding
}

// Tries the requested model first, then the remaining free models. Anything
// that is rate-limited or errors just moves down the list.
async function chatWithFallback(
  preferred: string,
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
): Promise<{ content: string; model: string }> {
  const order = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)]
  const failures: string[] = []

  for (const model of order) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: 1600, temperature: 0.2 }),
      })

      if (!res.ok) {
        failures.push(`${model}: HTTP ${res.status}`)
        continue
      }

      const payload = await res.json()
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.trim()) {
        return { content: content.trim(), model: payload.model ?? model }
      }
      failures.push(`${model}: empty response`)
    } catch (err) {
      failures.push(`${model}: ${err instanceof Error ? err.message : 'request failed'}`)
    }
  }

  throw new Error(`all free models failed. ${failures.join('; ')}`)
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405)
  }

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    return json({ error: 'OPENROUTER_API_KEY is not configured on the backend' }, 500)
  }

  const accessToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? null
  if (!accessToken) {
    return json({ error: 'unauthorized' }, 401)
  }

  const client = createClient({
    baseUrl: Deno.env.get('INSFORGE_BASE_URL'),
    accessToken,
  })

  const { data: userData } = await client.auth.getCurrentUser()
  const userId = userData?.user?.id
  if (!userId) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: { sessionId?: string; message?: string; model?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const sessionId = body.sessionId
  const question = String(body.message ?? '').trim().slice(0, MAX_MESSAGE_CHARS)
  const requestedModel =
    typeof body.model === 'string' && body.model.endsWith(':free') ? body.model : DEFAULT_MODEL

  if (!sessionId || !question) {
    return json({ error: 'sessionId and message are required' }, 400)
  }

  // RLS scopes this to the caller's own sessions.
  const { data: session, error: sessionError } = await client.database
    .from('chat_sessions')
    .select('id, document_id, title')
    .eq('id', sessionId)
    .maybeSingle()

  if (sessionError || !session) {
    return json({ error: 'session not found' }, 404)
  }

  const { data: doc } = await client.database
    .from('documents')
    .select('id, title, page_count, status, summary')
    .eq('id', session.document_id)
    .maybeSingle()

  if (!doc) {
    return json({ error: 'document not found' }, 404)
  }
  if (doc.status !== 'ready') {
    return json({ error: `document is still ${doc.status}` }, 409)
  }

  try {
    const queryEmbedding = await embedOne(question, apiKey)

    const [chunkResult, memoryResult, historyResult] = await Promise.all([
      client.database.rpc('match_doc_chunks', {
        query_embedding: queryEmbedding,
        p_document_id: session.document_id,
        match_count: RAG_CHUNKS,
        match_threshold: 0.1,
      }),
      client.database.rpc('match_user_memories', {
        query_embedding: queryEmbedding,
        match_count: MEMORY_MATCHES,
        match_threshold: 0.18,
      }),
      client.database
        .from('messages')
        .select('role, content, created_at')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(HISTORY_TURNS),
    ])

    const chunks = (chunkResult.data ?? []) as Array<{
      id: string
      chunk_index: number
      page_from: number
      page_to: number
      content: string
      similarity: number
    }>

    const memories = (memoryResult.data ?? []) as Array<{
      id: string
      kind: string
      content: string
      similarity: number
    }>

    // Oldest-first for the model; the query above fetched newest-first.
    const history = ((historyResult.data ?? []) as Array<{ role: string; content: string }>)
      .slice()
      .reverse()

    const contextBlock = chunks.length
      ? chunks
          .map(
            (chunk) =>
              `[excerpt ${chunk.chunk_index} | pages ${chunk.page_from}-${chunk.page_to}]\n${chunk.content}`,
          )
          .join('\n\n')
      : '(no matching passage was found in this document)'

    const memoryBlock = memories.length
      ? memories.map((memory) => `- (${memory.kind}) ${memory.content}`).join('\n')
      : '(nothing remembered about this user yet)'

    const systemPrompt = [
      `You are a PDF reviewer answering questions about one document: "${doc.title}" (${doc.page_count} pages).`,
      '',
      'Ground every factual claim in the excerpts below. If they do not contain the answer, say so',
      'plainly instead of guessing, then suggest what part of the document might help.',
      'Cite pages inline like (p. 4) when you use an excerpt.',
      'Use the remembered user context only to tailor tone, depth, and focus. Never treat it as',
      'a fact about the document, and do not mention that you have stored memories.',
      'Format the answer as short paragraphs and "- " bullets; **bold** is fine for key terms.',
      'Never use markdown headings, tables or code fences.',
      '',
      'What you remember about this user:',
      memoryBlock,
      '',
      'Excerpts retrieved from the document:',
      contextBlock,
    ].join('\n')

    const { content: answer, model: usedModel } = await chatWithFallback(
      requestedModel,
      [
        { role: 'system', content: systemPrompt },
        ...history.map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: question },
      ],
      apiKey,
    )

    const citations = chunks.map((chunk) => ({
      chunk_index: chunk.chunk_index,
      page_from: chunk.page_from,
      page_to: chunk.page_to,
      similarity: Number(chunk.similarity.toFixed(4)),
    }))

    const memoryIds = memories.map((memory) => memory.id)

    // Both rows must carry the same keys: a multi-row PostgREST insert unions
    // the columns across rows and fills any gap with NULL instead of falling
    // back to the column default, which would trip the NOT NULL constraints.
    const { error: writeError } = await client.database.from('messages').insert([
      {
        user_id: userId,
        session_id: sessionId,
        role: 'user',
        content: question,
        model: null,
        citations: [],
        memory_ids: [],
      },
      {
        user_id: userId,
        session_id: sessionId,
        role: 'assistant',
        content: answer,
        model: usedModel,
        citations,
        memory_ids: memoryIds,
      },
    ])

    if (writeError) {
      return json({ error: `saving the message failed: ${writeError.message}` }, 500)
    }

    if (memoryIds.length) {
      await client.database.rpc('bump_memory_usage', { p_ids: memoryIds })
    }

    return json({
      answer,
      model: usedModel,
      citations,
      memoriesUsed: memories.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
      })),
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'chat failed' }, 500)
  }
}
