interface BannerProps {
  tone?: 'error' | 'info' | 'success'
  children: React.ReactNode
  onDismiss?: () => void
}

const tones = {
  error: 'border-red-200 bg-red-50 text-red-800',
  info: 'border-stone-200 bg-stone-100 text-stone-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
}

export function Banner({ tone = 'info', children, onDismiss }: BannerProps) {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      <div className="flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="text-current opacity-60 hover:opacity-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
