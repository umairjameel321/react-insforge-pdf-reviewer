// Edge function: list-models
//
// Returns the currently available *free* text models from the InsForge model
// gateway, so the playground's picker never offers a paid model or a model ID
// that has since disappeared. Cached in memory for an hour per instance.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const CACHE_TTL_MS = 60 * 60 * 1000

// Ordered best-first; anything else free is appended after these.
const PREFERRED = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m2.7:free',
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
  'dots-studio/dots-3-note-preview:free',
  'openrouter/free',
]

interface FreeModel {
  id: string
  name: string
  contextLength: number
}

let cache: { at: number; models: FreeModel[] } | null = null

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    return json({ error: 'OPENROUTER_API_KEY is not configured on the backend' }, 500)
  }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return json({ models: cache.models, cached: true })
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      throw new Error(`model list request failed (${res.status})`)
    }

    const all = (await res.json())?.data
    if (!Array.isArray(all)) {
      throw new Error('unexpected model list response')
    }

    const free: FreeModel[] = all
      .filter((model: Record<string, any>) => {
        const isFree =
          Number(model?.pricing?.prompt ?? 0) === 0 && Number(model?.pricing?.completion ?? 0) === 0
        const outputs: string[] =
          model?.output_modalities ?? model?.architecture?.output_modalities ?? []
        return isFree && outputs.includes('text') && String(model.id).endsWith(':free')
      })
      .map((model: Record<string, any>) => ({
        id: String(model.id),
        name: String(model.name ?? model.id).replace(/\s*\(free\)\s*$/i, ''),
        contextLength: Number(model.context_length ?? 0),
      }))

    const rank = (id: string) => {
      const index = PREFERRED.indexOf(id)
      return index === -1 ? PREFERRED.length : index
    }
    free.sort((a, b) => rank(a.id) - rank(b.id) || b.contextLength - a.contextLength)

    cache = { at: Date.now(), models: free }
    return json({ models: free, cached: false })
  } catch (err) {
    // Never break the picker: fall back to the verified defaults.
    return json({
      models: PREFERRED.map((id) => ({ id, name: id.replace(':free', ''), contextLength: 0 })),
      cached: false,
      degraded: true,
      error: err instanceof Error ? err.message : 'model list unavailable',
    })
  }
}
