import { createClient } from '@insforge/sdk'

const baseUrl = import.meta.env.VITE_INSFORGE_URL
const anonKey = import.meta.env.VITE_INSFORGE_ANON_KEY

if (!baseUrl || !anonKey) {
  throw new Error(
    'Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY. Copy .env.example to .env and fill both in.',
  )
}

export const insforge = createClient({ baseUrl, anonKey })

export const PDF_BUCKET = 'pdfs'

/** Mirrors the CHECK constraint on documents.byte_size. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024

/** Mirrors the CHECK constraint on documents.page_count. */
export const MAX_PDF_PAGES = 120

export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
