import { useEffect, useRef, useState } from 'react'

import { renderPdfPages } from '../lib/pdf'
import { Banner } from './Banner'
import { Spinner } from './Spinner'

/**
 * Renders the PDF with pdf.js into canvases rather than handing a blob URL to
 * an <iframe>. An iframe depends on the host browser shipping a PDF plugin,
 * which not every embedded/webview browser does; canvas rendering always works
 * and reuses the pdf.js bundle the uploader already needs.
 */
export function PdfPane({ blob, title }: { blob: Blob | null; title: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!blob) return

    const container = containerRef.current
    if (!container) return

    let cancelled = false
    setLoading(true)
    setError(null)
    container.replaceChildren()

    void (async () => {
      try {
        await renderPdfPages(blob, container, () => cancelled)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not render this PDF.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [blob])

  return (
    <div className="flex h-full flex-col bg-stone-200">
      <div className="flex-1 overflow-y-auto p-3">
        {error ? (
          <Banner tone="error">{error}</Banner>
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label="Rendering the PDF" />
          </div>
        ) : null}

        <div ref={containerRef} className="space-y-3" aria-label={`${title} pages`} />
      </div>
    </div>
  )
}
