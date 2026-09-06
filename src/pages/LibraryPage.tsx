import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Banner } from '../components/Banner'
import { Spinner } from '../components/Spinner'
import { ApiError, deleteSession, listSessions, uploadPdf, type UploadProgress } from '../lib/api'
import { useAuth } from '../lib/auth'
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from '../lib/insforge'
import type { SessionWithDocument } from '../lib/types'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return `${date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

const statusStyles: Record<string, string> = {
  ready: 'bg-emerald-100 text-emerald-800',
  processing: 'bg-amber-100 text-amber-800',
  failed: 'bg-red-100 text-red-800',
}

export default function LibraryPage() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)

  const [sessions, setSessions] = useState<SessionWithDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [dragging, setDragging] = useState(false)

  const load = useCallback(async () => {
    try {
      setSessions(await listSessions())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your sessions.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      setProgress({ stage: 'reading', detail: 'Reading the document' })

      try {
        const { sessionId } = await uploadPdf(file, setProgress)
        navigate(`/c/${sessionId}`)
      } catch (err) {
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : 'Something went wrong while adding that PDF.',
        )
        void load()
      } finally {
        setProgress(null)
        if (fileInput.current) fileInput.current.value = ''
      }
    },
    [navigate, load],
  )

  const handleDelete = async (session: SessionWithDocument) => {
    if (!session.documents) return
    if (!window.confirm(`Delete "${session.title}" and its conversation? This cannot be undone.`)) {
      return
    }

    const previous = sessions
    setSessions((current) => current.filter((item) => item.id !== session.id))

    try {
      await deleteSession(session.document_id, `${user?.id}/${session.document_id}.pdf`)
    } catch (err) {
      setSessions(previous)
      setError(err instanceof Error ? err.message : 'Deleting failed.')
    }
  }

  const busy = progress !== null

  return (
    <div className="mx-auto min-h-full w-full max-w-4xl px-5 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Your documents</h1>
          <p className="mt-1 text-sm text-stone-500">
            {user?.profile?.name ? `Signed in as ${user.profile.name}` : user?.email}
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      {error ? (
        <div className="mt-6">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {/* Upload */}
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files?.[0]
          if (file && !busy) void handleFile(file)
        }}
        className={`mt-6 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
          dragging ? 'border-stone-500 bg-stone-100' : 'border-stone-300 bg-white'
        }`}
      >
        {busy ? (
          <div className="flex flex-col items-center gap-3">
            <Spinner label={progress?.detail} />
            <p className="text-xs text-stone-400">
              {progress?.stage === 'indexing'
                ? 'This takes a few seconds — embedding the text and writing the first review.'
                : 'Keep this tab open.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-stone-800">Drop a PDF here</p>
            <p className="mt-1 text-xs text-stone-500">
              Up to {MAX_PDF_BYTES / 1024 / 1024} MB and {MAX_PDF_PAGES} pages. Needs selectable
              text — scanned PDFs will not work.
            </p>
            <button
              type="button"
              className="btn-primary mt-4"
              onClick={() => fileInput.current?.click()}
            >
              Choose a file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
              }}
            />
          </>
        )}
      </div>

      {/* Sessions */}
      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Chat sessions
        </h2>

        {loading ? (
          <div className="mt-4">
            <Spinner label="Loading" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="mt-4 text-sm text-stone-500">
            No documents yet. Upload a PDF to start your first conversation.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sessions.map((session) => {
              const document = session.documents
              const status = document?.status ?? 'processing'

              return (
                <li key={session.id} className="card animate-fade-up hover:border-stone-300">
                  <div className="flex items-center gap-4 px-4 py-3">
                    <Link to={`/c/${session.id}`} className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-stone-900">
                          {session.title}
                        </p>
                        <span className={`chip ${statusStyles[status]}`}>{status}</span>
                      </div>

                      <p className="mt-1 truncate text-xs text-stone-500">
                        {document?.file_name ?? 'file removed'}
                        {document ? ` · ${document.page_count} pages · ${formatBytes(document.byte_size)}` : ''}
                      </p>

                      <p className="mt-1 text-xs text-stone-400">
                        Added {formatWhen(session.created_at)}
                        {session.last_message_at
                          ? ` · last message ${formatWhen(session.last_message_at)}`
                          : ''}
                        {` · ${session.message_count} ${session.message_count === 1 ? 'message' : 'messages'}`}
                      </p>

                      {status === 'failed' && document?.error ? (
                        <p className="mt-1.5 text-xs text-red-700">{document.error}</p>
                      ) : null}
                    </Link>

                    <button
                      type="button"
                      onClick={() => void handleDelete(session)}
                      className="shrink-0 rounded-lg px-2 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
