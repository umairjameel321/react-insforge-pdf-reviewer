export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-stone-500">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-700"
        role="status"
        aria-label={label ?? 'Loading'}
      />
      {label ? <span>{label}</span> : null}
    </div>
  )
}
