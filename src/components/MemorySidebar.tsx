import type { UserMemory } from '../lib/types'
import { Spinner } from './Spinner'

interface MemorySidebarProps {
  memories: UserMemory[]
  loading: boolean
  /** Ids injected into the most recent prompt, highlighted so the user can see them being used. */
  activeIds: string[]
  onForget: (id: string) => void
}

const kindStyles: Record<string, string> = {
  factual: 'bg-sky-100 text-sky-800',
  episodic: 'bg-amber-100 text-amber-800',
}

function MemoryGroup({
  title,
  hint,
  memories,
  activeIds,
  onForget,
}: {
  title: string
  hint: string
  memories: UserMemory[]
  activeIds: string[]
  onForget: (id: string) => void
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{title}</h3>
      <p className="mt-0.5 text-[11px] leading-snug text-stone-400">{hint}</p>

      {memories.length === 0 ? (
        <p className="mt-2 text-xs text-stone-400">Nothing yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {memories.map((memory) => {
            const isActive = activeIds.includes(memory.id)
            return (
              <li
                key={memory.id}
                className={`group rounded-lg border px-2.5 py-2 text-xs transition-colors ${
                  isActive ? 'border-stone-400 bg-stone-100' : 'border-stone-200 bg-white'
                }`}
              >
                <div className="flex items-start gap-2">
                  <p className="flex-1 leading-relaxed text-stone-700">{memory.content}</p>
                  <button
                    type="button"
                    onClick={() => onForget(memory.id)}
                    title="Forget this"
                    aria-label={`Forget: ${memory.content}`}
                    className="shrink-0 rounded px-1 text-stone-300 opacity-0 transition-opacity
                               hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[10px] text-stone-400">
                  <span className={`chip ${kindStyles[memory.kind] ?? 'bg-stone-100 text-stone-600'}`}>
                    {memory.kind}
                  </span>
                  {memory.use_count > 0 ? <span>used {memory.use_count}×</span> : null}
                  {isActive ? <span className="font-medium text-stone-600">in this answer</span> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function MemorySidebar({ memories, loading, activeIds, onForget }: MemorySidebarProps) {
  const factual = memories.filter((memory) => memory.kind === 'factual')
  const episodic = memories.filter((memory) => memory.kind === 'episodic')

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-stone-200 bg-stone-50">
      <header className="border-b border-stone-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-stone-800">Memory</h2>
        <p className="mt-0.5 text-[11px] leading-snug text-stone-500">
          Extracted across all your documents and injected into relevant questions.
        </p>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {loading && memories.length === 0 ? (
          <Spinner label="Loading memory" />
        ) : (
          <>
            <MemoryGroup
              title="Factual"
              hint="Stable things about you."
              memories={factual}
              activeIds={activeIds}
              onForget={onForget}
            />
            <MemoryGroup
              title="Episodic"
              hint="What happened in past sessions."
              memories={episodic}
              activeIds={activeIds}
              onForget={onForget}
            />
          </>
        )}
      </div>
    </aside>
  )
}
