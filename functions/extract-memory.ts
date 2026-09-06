// Edge function: extract-memory
//
// Looks at the latest exchange in a session and distills durable long-term
// memories about the *user* (not about the PDF):
//   factual  - stable traits, role, preferences, goals, constraints
//   episodic - what happened in this session, tied to a time and a document
//
// Called fire-and-forget by the client after an answer arrives, so chat latency
// is unaffected. Writes go through upsert_user_memory, which is idempotent on
// (user_id, normalized content) — re-learning a fact refreshes it.

import { createClient } from 'npm:@insforge/sdk'

const EMBEDDING_MODEL = 'liquid/lfm-2.5-embedding-350m:free'
const EMBEDDING_DIMS = 1024

const EXTRACTION_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m2.7:free',
  'openrouter/free',
]

const MAX_NEW_MEMORIES = 4

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

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  })

  if (!res.ok) {
    throw new Error(`embedding request failed (${res.status})`)
  }

  const rows = (await res.json())?.data
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

// Free models are inconsistent about honouring json_schema, so the JSON object
// is also recovered by hand from the raw text when needed.
function parseMemories(raw: string): Array<{ kind: string; content: string }> {
  let text = raw.trim()

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) text = fenced[1].trim()

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }

  const items = (parsed as { memories?: unknown })?.memories
  if (!Array.isArray(items)) return []

  return items
    .map((item) => ({
      kind: String((item as { kind?: string })?.kind ?? '').toLowerCase().trim(),
      content: String((item as { content?: string })?.content ?? '').trim(),
    }))
    .filter(
      (item) =>
        (item.kind === 'factual' || item.kind === 'episodic') &&
        item.content.length >= 3 &&
        item.content.length <= 600,
    )
    .slice(0, MAX_NEW_MEMORIES)
}

async function extract(
  prompt: string,
  apiKey: string,
): Promise<Array<{ kind: string; content: string }>> {
  for (const model of EXTRACTION_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 700,
          messages: [
            {
              role: 'system',
              content:
                'You extract durable long-term memories about a USER from one exchange with a ' +
                'document assistant. Return JSON only: {"memories":[{"kind":"factual|episodic",' +
                '"content":"..."}]}\n\n' +
                'THE TWO KINDS ARE NOT INTERCHANGEABLE:\n\n' +
                '"factual" = a property of the person that is still true next month: their role, ' +
                'employer, domain, expertise level, language, stated preference, standing goal, or ' +
                'a constraint they work under. A question is NEVER factual.\n' +
                '  good: "User is a procurement lead."\n' +
                '  good: "User prefers short answers with clause references."\n' +
                '  bad:  "User wants to know the termination notice period." <- that is a question\n\n' +
                '"episodic" = one thing that happened in this session, anchored to its subject ' +
                'matter. Every question the user asks becomes episodic, not factual.\n' +
                '  good: "Asked about the termination notice period in the Acme cloud agreement."\n' +
                '  good: "Reviewed the liability cap while preparing for renewal."\n\n' +
                'RULES: one short third-person sentence each. Facts about the DOCUMENT are never ' +
                'memories — only facts about the person. Never store the assistant\'s answer. ' +
                'Never store a greeting or small talk. At most 3 memories. Return ' +
                '{"memories":[]} when the exchange reveals nothing durable. JSON only, no prose.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      })

      if (!res.ok) continue

      const content = (await res.json())?.choices?.[0]?.message?.content
      if (typeof content !== 'string') continue

      const memories = parseMemories(content)
      if (memories.length) return memories

      // A valid, genuinely empty extraction is a real answer — stop here.
      if (/"memories"\s*:\s*\[\s*\]/.test(content)) return []
    } catch {
      // try the next free model
    }
  }
  return []
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
  if (!userData?.user?.id) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: { sessionId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  if (!body.sessionId) {
    return json({ error: 'sessionId is required' }, 400)
  }

  const { data: session } = await client.database
    .from('chat_sessions')
    .select('id, document_id, title')
    .eq('id', body.sessionId)
    .maybeSingle()

  if (!session) {
    return json({ error: 'session not found' }, 404)
  }

  const { data: recent } = await client.database
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', body.sessionId)
    .order('created_at', { ascending: false })
    .limit(2)

  const exchange = ((recent ?? []) as Array<{ role: string; content: string }>).slice().reverse()
  const lastUserMessage = exchange.find((message) => message.role === 'user')

  // Nothing the user said means nothing to learn about them.
  if (!lastUserMessage) {
    return json({ ok: true, created: [] })
  }

  try {
    const prompt = exchange
      .map(
        (message) =>
          `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(0, 2500)}`,
      )
      .join('\n\n')

    const candidates = await extract(
      `Document being discussed: "${session.title}"\n\n${prompt}`,
      apiKey,
    )

    if (!candidates.length) {
      return json({ ok: true, created: [] })
    }

    const vectors = await embedBatch(
      candidates.map((candidate) => candidate.content),
      apiKey,
    )

    const created: Array<{ kind: string; content: string }> = []
    for (let i = 0; i < candidates.length; i++) {
      const { error } = await client.database.rpc('upsert_user_memory', {
        p_kind: candidates[i].kind,
        p_content: candidates[i].content,
        p_embedding: vectors[i],
        p_document_id: session.document_id,
        p_session_id: session.id,
      })
      if (!error) created.push(candidates[i])
    }

    return json({ ok: true, created })
  } catch (err) {
    // Memory extraction is best-effort; never surface it as a chat failure.
    return json({ ok: false, created: [], error: err instanceof Error ? err.message : 'failed' })
  }
}
