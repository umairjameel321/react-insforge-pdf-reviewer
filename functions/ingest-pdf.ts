// Edge function: ingest-pdf
//
// Receives page-aware text chunks extracted in the browser, embeds them into
// pgvector, then has a free model write the opening review of the document.
// Runs as the calling user, so every write is filtered by the owner-only RLS
// policies on documents / doc_chunks / messages.

import { createClient } from 'npm:@insforge/sdk'

const EMBEDDING_MODEL = 'liquid/lfm-2.5-embedding-350m:free'
const EMBEDDING_DIMS = 1024
const EMBED_BATCH = 24
const MAX_CHUNKS = 400

const FREE_CHAT_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m2.7:free',
  'nvidia/nemotron-3.5-lightning:free',
  'openrouter/free',
]

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

interface IncomingChunk {
  index: number
  pageFrom: number
  pageTo: number
  content: string
}

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  })

  if (!res.ok) {
    throw new Error(`embedding request failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }

  const payload = await res.json()
  const rows = payload?.data
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error('embedding response did not match the number of inputs')
  }

  return rows
    .slice()
    .sort((a: { index?: number }, b: { index?: number }) => (a.index ?? 0) - (b.index ?? 0))
    .map((row: { embedding: number[] }) => {
      if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIMS) {
        throw new Error(`expected ${EMBEDDING_DIMS}-dimension embeddings`)
      }
      return row.embedding
    })
}

// Walks the free-model list so one rate-limited provider cannot fail the request.
async function chatWithFallback(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  maxTokens: number,
): Promise<{ content: string; model: string } | null> {
  for (const model of FREE_CHAT_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
      })

      if (!res.ok) continue

      const payload = await res.json()
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.trim()) {
        return { content: content.trim(), model: payload.model ?? model }
      }
    } catch {
      // try the next free model
    }
  }
  return null
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

  let body: { documentId?: string; sessionId?: string; chunks?: IncomingChunk[] }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const { documentId, sessionId } = body
  const chunks = Array.isArray(body.chunks) ? body.chunks : []

  if (!documentId || !sessionId) {
    return json({ error: 'documentId and sessionId are required' }, 400)
  }
  if (chunks.length === 0) {
    return json({ error: 'no extractable text found in this PDF' }, 400)
  }
  if (chunks.length > MAX_CHUNKS) {
    return json({ error: `this PDF produced too many chunks (${chunks.length} > ${MAX_CHUNKS})` }, 400)
  }

  // RLS makes this read owner-scoped, so a foreign documentId simply misses.
  const { data: doc, error: docError } = await client.database
    .from('documents')
    .select('id, title, file_name, page_count, status')
    .eq('id', documentId)
    .maybeSingle()

  if (docError || !doc) {
    return json({ error: 'document not found' }, 404)
  }

  const markFailed = async (message: string) => {
    await client.database
      .from('documents')
      .update({ status: 'failed', error: message.slice(0, 500) })
      .eq('id', documentId)
  }

  try {
    const clean = chunks
      .map((chunk) => ({
        index: Number(chunk.index),
        pageFrom: Math.max(1, Number(chunk.pageFrom) || 1),
        pageTo: Math.max(1, Number(chunk.pageTo) || 1),
        content: String(chunk.content ?? '').trim().slice(0, 8000),
      }))
      .filter((chunk) => chunk.content.length > 0 && Number.isFinite(chunk.index))

    if (clean.length === 0) {
      throw new Error('no extractable text found in this PDF')
    }

    let inserted = 0
    for (let start = 0; start < clean.length; start += EMBED_BATCH) {
      const batch = clean.slice(start, start + EMBED_BATCH)
      const vectors = await embedBatch(
        batch.map((chunk) => chunk.content),
        apiKey,
      )

      const rows = batch.map((chunk, i) => ({
        user_id: userId,
        document_id: documentId,
        chunk_index: chunk.index,
        page_from: chunk.pageFrom,
        page_to: chunk.pageTo,
        content: chunk.content,
        embedding: vectors[i],
        embedding_model: EMBEDDING_MODEL,
      }))

      const { error: insertError } = await client.database.from('doc_chunks').insert(rows)
      if (insertError) {
        throw new Error(`storing chunks failed: ${insertError.message}`)
      }
      inserted += rows.length
    }

    // Opening review, built from the head of the document.
    let excerpt = ''
    for (const chunk of clean) {
      if (excerpt.length > 12000) break
      excerpt += `\n[pages ${chunk.pageFrom}-${chunk.pageTo}]\n${chunk.content}\n`
    }

    const review = await chatWithFallback(
      [
        {
          role: 'system',
          content:
            'You review PDFs. Given an excerpt, write a brief orientation for the reader. ' +
            'Use short paragraphs and "- " bullets, never markdown headings, tables or code fences. ' +
            'Structure: one sentence on what the document is, then 3-5 key points as bullets, ' +
            'then a line starting "Try asking:" with three specific questions the document can answer. ' +
            'Only use information present in the excerpt. Keep it under 220 words.',
        },
        {
          role: 'user',
          content: `Document title: ${doc.title}\nPages: ${doc.page_count}\n\nExcerpt:\n${excerpt}`,
        },
      ],
      apiKey,
      900,
    )

    const summary = review?.content ?? null

    const { error: updateError } = await client.database
      .from('documents')
      .update({
        status: 'ready',
        chunk_count: inserted,
        summary,
        error: null,
      })
      .eq('id', documentId)

    if (updateError) {
      throw new Error(`finalizing document failed: ${updateError.message}`)
    }

    if (summary) {
      await client.database.from('messages').insert([
        {
          user_id: userId,
          session_id: sessionId,
          role: 'assistant',
          content: summary,
          model: review?.model ?? null,
          citations: [],
          memory_ids: [],
        },
      ])
    }

    return json({
      ok: true,
      documentId,
      chunkCount: inserted,
      summary,
      model: review?.model ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ingestion failed'
    await markFailed(message)
    return json({ error: message }, 500)
  }
}
