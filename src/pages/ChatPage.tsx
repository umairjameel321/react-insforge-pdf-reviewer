import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { Banner } from '../components/Banner'
import { MemorySidebar } from '../components/MemorySidebar'
import { ModelPicker } from '../components/ModelPicker'
import { PdfPane } from '../components/PdfPane'
import { RichText } from '../components/RichText'
import { Spinner } from '../components/Spinner'
import {
  deleteMemory,
  extractMemory,
  getMessages,
  getPdfBlob,
  getSession,
  listFreeModels,
  listMemories,
  sendMessage,
  setSessionModel,
} from '../lib/api'
import { DEFAULT_MODEL } from '../lib/insforge'
import type { ChatMessage, FreeModel, PdfDocument, UserMemory } from '../lib/types'

function Citations({ message }: { message: ChatMessage }) {
  if (!message.citations?.length) return null

  // Collapse overlapping excerpts into a readable set of page references.
  const pages = Array.from(
    new Set(
      message.citations.flatMap((citation) =>
        citation.page_from === citation.page_to
          ? [`${citation.page_from}`]
          : [`${citation.page_from}–${citation.page_to}`],
      ),
    ),
  )

  return (
    <p className="mt-2 text-[11px] text-stone-400">
      Retrieved from {pages.length === 1 ? 'page' : 'pages'} {pages.join(', ')}
    </p>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'

  return (
    <div className={`animate-fade-up flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[46rem] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? 'bg-stone-900 text-stone-50'
            : 'border border-stone-200 bg-white text-stone-800'
        }`}
      >
        <RichText content={message.content} />
        {!isUser ? (
          <>
            <Citations message={message} />
            {message.model ? (
              <p className="mt-1 text-[11px] text-stone-400">{message.model.replace(':free', '')}</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>()

  const [document, setDocument] = useState<PdfDocument | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [memories, setMemories] = useState<UserMemory[]>([])
  const [models, setModels] = useState<FreeModel[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [memoryLoading, setMemoryLoading] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeMemoryIds, setActiveMemoryIds] = useState<string[]>([])

  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null)
  const [showPdf, setShowPdf] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)

  const refreshMemories = useCallback(async () => {
    try {
      setMemories(await listMemories())
    } catch {
      // The sidebar is auxiliary; a failure here must not break the chat.
    } finally {
      setMemoryLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    async function load() {
      try {
        const [{ session, document: doc }, history] = await Promise.all([
          getSession(sessionId!),
          getMessages(sessionId!),
        ])
        if (cancelled) return

        setDocument(doc)
        setMessages(history)
        setModel(session.model || DEFAULT_MODEL)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not open this session.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    void refreshMemories()
    void listFreeModels().then((list) => {
      if (!cancelled) setModels(list)
    })

    return () => {
      cancelled = true
    }
  }, [sessionId, refreshMemories])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, thinking])

  const handleModelChange = async (next: string) => {
    setModel(next)
    if (!sessionId) return
    try {
      await setSessionModel(sessionId, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that model choice.')
    }
  }

  const togglePdf = async () => {
    if (showPdf) {
      setShowPdf(false)
      return
    }
    setShowPdf(true)
    if (!pdfBlob && document) {
      try {
        setPdfBlob(await getPdfBlob(document.file_key))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open the PDF.')
        setShowPdf(false)
      }
    }
  }

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault()
    const question = input.trim()
    if (!question || !sessionId || thinking) return

    setInput('')
    setError(null)
    setThinking(true)

    // Optimistic user message; replaced by the server's copy on reload.
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      session_id: sessionId,
      role: 'user',
      content: question,
      model: null,
      citations: [],
      memory_ids: [],
      created_at: new Date().toISOString(),
    }
    setMessages((current) => [...current, optimistic])

    try {
      const result = await sendMessage(sessionId, question, model)

      setActiveMemoryIds(result.memoriesUsed.map((memory) => memory.id))
      setMessages(await getMessages(sessionId))

      // Memory extraction is deliberately not awaited before the answer shows.
      void extractMemory(sessionId).then(refreshMemories)
    } catch (err) {
      setMessages((current) => current.filter((message) => message.id !== optimistic.id))
      setInput(question)
      setError(err instanceof Error ? err.message : 'The model could not answer that.')
    } finally {
      setThinking(false)
    }
  }

  const handleForget = async (id: string) => {
    const previous = memories
    setMemories((current) => current.filter((memory) => memory.id !== id))
    try {
      await deleteMemory(id)
    } catch (err) {
      setMemories(previous)
      setError(err instanceof Error ? err.message : 'Could not forget that memory.')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Opening the document" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5">
        <Link
          to="/"
          className="shrink-0 rounded-lg px-2 py-1 text-sm text-stone-500 hover:bg-stone-100"
        >
          ← All documents
        </Link>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-stone-900">
            {document?.title ?? 'Document'}
          </p>
          <p className="truncate text-[11px] text-stone-400">
            {document
              ? `${document.page_count} ${document.page_count === 1 ? 'page' : 'pages'} · ` +
                `${document.chunk_count} indexed ${document.chunk_count === 1 ? 'passage' : 'passages'}`
              : ''}
          </p>
        </div>

        <button type="button" className="btn-ghost shrink-0 px-3 py-1.5 text-xs" onClick={togglePdf}>
          {showPdf ? 'Hide PDF' : 'View PDF'}
        </button>

        <ModelPicker models={models} value={model} onChange={handleModelChange} disabled={thinking} />
      </header>

      <div className="flex min-h-0 flex-1">
        {showPdf ? (
          <div className="hidden w-2/5 shrink-0 border-r border-stone-200 lg:block">
            <PdfPane blob={pdfBlob} title={document?.title ?? 'PDF'} />
          </div>
        ) : null}

        {/* Conversation */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6">
            {document?.status === 'failed' ? (
              <Banner tone="error">
                This document could not be indexed{document.error ? `: ${document.error}` : '.'} Delete
                it and try uploading again.
              </Banner>
            ) : null}

            {messages.length === 0 && document?.status === 'ready' ? (
              <p className="text-sm text-stone-400">
                Ask anything about this document. Answers are grounded in its text and cite pages.
              </p>
            ) : null}

            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {thinking ? (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-stone-200 bg-white px-4 py-3">
                  <Spinner label="Searching the document" />
                </div>
              </div>
            ) : null}

            <div ref={bottomRef} />
          </div>

          {error ? (
            <div className="px-4 pb-2">
              <Banner tone="error" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            </div>
          ) : null}

          <form onSubmit={handleSend} className="shrink-0 border-t border-stone-200 bg-white px-4 py-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void handleSend(event)
                  }
                }}
                rows={1}
                placeholder={
                  document?.status === 'ready'
                    ? 'Ask about this document…'
                    : 'This document is not ready yet'
                }
                disabled={thinking || document?.status !== 'ready'}
                className="field max-h-40 min-h-[2.5rem] flex-1 resize-y disabled:bg-stone-100"
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={thinking || !input.trim() || document?.status !== 'ready'}
              >
                Send
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-stone-400">
              Enter to send, Shift+Enter for a new line. Free models only.
            </p>
          </form>
        </div>

        <div className="hidden w-72 shrink-0 xl:block">
          <MemorySidebar
            memories={memories}
            loading={memoryLoading}
            activeIds={activeMemoryIds}
            onForget={handleForget}
          />
        </div>
      </div>
    </div>
  )
}
