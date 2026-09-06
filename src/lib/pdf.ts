import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { MAX_PDF_PAGES } from './insforge'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Chunk sizing. ~1400 characters is roughly 350 tokens, so a 6-chunk retrieval
 * stays near 2k tokens of context — small enough for free models to handle
 * comfortably while still covering a full argument or table.
 */
const CHUNK_CHARS = 1400
const CHUNK_OVERLAP = 180
const MAX_TOTAL_CHARS = 400_000

export interface ExtractedChunk {
  index: number
  pageFrom: number
  pageTo: number
  content: string
}

export interface ExtractionResult {
  pageCount: number
  charCount: number
  chunks: ExtractedChunk[]
}

export class PdfExtractionError extends Error {}

interface PageText {
  page: number
  text: string
}

function normalize(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Last ~limit characters of text, trimmed forward to a word boundary. */
function tailWords(text: string, limit: number): string {
  if (text.length <= limit) return text
  const tail = text.slice(-limit)
  const boundary = tail.indexOf(' ')
  return boundary === -1 ? tail : tail.slice(boundary + 1)
}

/**
 * Packs page texts into overlapping chunks while tracking which pages each
 * chunk spans, so answers can cite real page numbers.
 *
 * Splits land on word boundaries — a chunk cut mid-word embeds poorly and
 * produces retrieval misses on exactly the term the user searched for.
 */
function buildChunks(pages: PageText[]): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = []
  // Below this, the remaining room is too small to hold a useful passage.
  const MIN_ROOM = 240

  let buffer = ''
  let bufferFrom = pages[0]?.page ?? 1
  let bufferTo = bufferFrom

  const push = () => {
    const content = normalize(buffer)
    if (content.length > 0) {
      chunks.push({ index: chunks.length, pageFrom: bufferFrom, pageTo: bufferTo, content })
    }
  }

  for (const page of pages) {
    if (!page.text) continue

    if (buffer.length === 0) {
      bufferFrom = page.page
      bufferTo = page.page
    }

    let remaining = page.text

    while (remaining.length > 0) {
      const room = CHUNK_CHARS - buffer.length

      if (room < MIN_ROOM) {
        push()
        // Carry a tail forward so a sentence spanning the split stays findable.
        buffer = tailWords(buffer, CHUNK_OVERLAP)
        bufferFrom = page.page
        bufferTo = page.page
        continue
      }

      let take = Math.min(room, remaining.length)
      if (take < remaining.length) {
        const boundary = remaining.lastIndexOf(' ', take)
        // Only back off if it does not shrink the chunk drastically.
        if (boundary > take / 2) take = boundary
      }

      const slice = remaining.slice(0, take).trim()
      if (slice.length > 0) {
        buffer = buffer.length > 0 ? `${buffer} ${slice}` : slice
        bufferTo = page.page
      }
      remaining = remaining.slice(take).trimStart()
    }
  }

  push()
  return chunks
}

/**
 * Renders every page of a PDF into the container as a canvas. `isCancelled` is
 * polled between pages so navigating away stops the work instead of drawing
 * into a detached node.
 */
export async function renderPdfPages(
  blob: Blob,
  container: HTMLElement,
  isCancelled: () => boolean,
): Promise<void> {
  const buffer = await blob.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise

  try {
    // Cap the backing resolution so large pages stay legible without ballooning memory.
    const scale = Math.min(2, Math.max(1, (container.clientWidth || 700) / 700)) * 1.5

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (isCancelled()) return

      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.className = 'w-full rounded border border-stone-300 bg-white shadow-sm'
      canvas.setAttribute('aria-label', `Page ${pageNumber}`)

      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser could not provide a 2D canvas.')

      await page.render({ canvasContext: context, viewport }).promise
      page.cleanup()

      if (isCancelled()) return
      container.appendChild(canvas)
    }
  } finally {
    void pdf.destroy()
  }
}

export async function extractPdf(file: File): Promise<ExtractionResult> {
  const buffer = await file.arrayBuffer()

  let pdf: pdfjs.PDFDocumentProxy
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  } catch {
    throw new PdfExtractionError('This file could not be opened as a PDF.')
  }

  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new PdfExtractionError(
        `This PDF has ${pdf.numPages} pages. The limit is ${MAX_PDF_PAGES} pages so free models stay within budget.`,
      )
    }

    const pages: PageText[] = []
    let charCount = 0

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()

      const text = normalize(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' '),
      )

      page.cleanup()

      if (text) {
        pages.push({ page: pageNumber, text })
        charCount += text.length
      }

      if (charCount > MAX_TOTAL_CHARS) {
        throw new PdfExtractionError(
          'This PDF contains too much text to review on the free tier. Try a shorter document.',
        )
      }
    }

    if (pages.length === 0) {
      throw new PdfExtractionError(
        'No selectable text found. This looks like a scanned PDF, which needs OCR before it can be reviewed.',
      )
    }

    return { pageCount: pdf.numPages, charCount, chunks: buildChunks(pages) }
  } finally {
    void pdf.destroy()
  }
}
