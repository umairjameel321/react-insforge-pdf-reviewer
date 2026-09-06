import type { FreeModel } from '../lib/types'

interface ModelPickerProps {
  models: FreeModel[]
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}

function formatContext(length: number): string {
  if (!length) return ''
  if (length >= 1_000_000) return `${Math.round(length / 1_000_000)}M ctx`
  return `${Math.round(length / 1000)}k ctx`
}

export function ModelPicker({ models, value, onChange, disabled }: ModelPickerProps) {
  // The chosen model may not be in the live list (e.g. temporarily withdrawn),
  // so keep it selectable rather than silently switching the user's choice.
  const options = models.some((model) => model.id === value)
    ? models
    : [{ id: value, name: value.replace(':free', ''), contextLength: 0 }, ...models]

  return (
    <label className="flex items-center gap-2 text-xs text-stone-500">
      <span className="hidden sm:inline">Model</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[15rem] truncate rounded-lg border border-stone-300 bg-white px-2 py-1.5
                   text-xs text-stone-800 focus:border-stone-500 focus:outline-none
                   focus:ring-2 focus:ring-stone-200 disabled:opacity-50"
      >
        {options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
            {model.contextLength ? ` · ${formatContext(model.contextLength)}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
