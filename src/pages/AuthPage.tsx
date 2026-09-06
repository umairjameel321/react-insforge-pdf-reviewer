import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { Banner } from '../components/Banner'
import { Spinner } from '../components/Spinner'
import { useAuth } from '../lib/auth'
import { insforge } from '../lib/insforge'

type Mode = 'signin' | 'signup' | 'verify'

// Mirrors the applied insforge.toml password policy.
const PASSWORD_RULE = 'At least 10 characters, with an uppercase letter, a lowercase letter and a number.'

const OAUTH_PROVIDERS: Array<{ id: 'google' | 'github'; label: string }> = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
]

export default function AuthPage() {
  const { user, loading, refresh } = useAuth()
  const navigate = useNavigate()

  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setError(null)
    setNotice(null)
  }, [mode])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Checking your session" />
      </div>
    )
  }

  if (user) return <Navigate to="/" replace />

  const handleSignIn = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const { error: signInError } = await insforge.auth.signInWithPassword({ email, password })

    if (signInError) {
      // 403 means the account exists but has not confirmed its email yet.
      if (signInError.statusCode === 403) {
        setMode('verify')
        setNotice('This email is not verified yet. We sent you a new 6-digit code.')
        await insforge.auth.resendVerificationEmail({ email })
      } else {
        setError(signInError.message)
      }
      setBusy(false)
      return
    }

    await refresh()
    navigate('/', { replace: true })
  }

  const handleSignUp = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const { data, error: signUpError } = await insforge.auth.signUp({ email, password, name })

    if (signUpError) {
      setError(signUpError.message)
      setBusy(false)
      return
    }

    if (data?.requireEmailVerification) {
      // Backend is configured for `code`, so collect the digits on this page.
      setMode('verify')
      setNotice(`We sent a 6-digit code to ${email}.`)
      setBusy(false)
      return
    }

    await refresh()
    navigate('/', { replace: true })
  }

  const handleVerify = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    // On the code flow this also saves the session, so no second sign-in.
    const { error: verifyError } = await insforge.auth.verifyEmail({ email, otp: otp.trim() })

    if (verifyError) {
      setError(
        verifyError.statusCode === 400
          ? 'That code is invalid or expired. Request a new one.'
          : verifyError.message,
      )
      setBusy(false)
      return
    }

    await refresh()
    navigate('/', { replace: true })
  }

  const handleOAuth = async (provider: 'google' | 'github') => {
    setError(null)
    const { error: oauthError } = await insforge.auth.signInWithOAuth(provider, {
      redirectTo: `${window.location.origin}/`,
    })
    if (oauthError) setError(oauthError.message)
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">PDF Reviewer</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-500">
            Upload a PDF and interrogate it with free models. Each document gets its own
            conversation, and what you care about is remembered across them.
          </p>
        </div>

        <div className="card p-5">
          {error ? (
            <div className="mb-4">
              <Banner tone="error" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            </div>
          ) : null}
          {notice ? (
            <div className="mb-4">
              <Banner tone="info">{notice}</Banner>
            </div>
          ) : null}

          {mode === 'verify' ? (
            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label htmlFor="otp" className="mb-1 block text-sm font-medium text-stone-700">
                  Verification code
                </label>
                <input
                  id="otp"
                  className="field text-center text-lg tracking-[0.4em]"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </div>

              <button type="submit" className="btn-primary w-full" disabled={busy || otp.length < 6}>
                {busy ? 'Verifying…' : 'Verify and continue'}
              </button>

              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  className="text-stone-500 underline-offset-2 hover:underline"
                  onClick={async () => {
                    await insforge.auth.resendVerificationEmail({ email })
                    setNotice('A new code is on its way.')
                  }}
                >
                  Resend code
                </button>
                <button
                  type="button"
                  className="text-stone-500 underline-offset-2 hover:underline"
                  onClick={() => setMode('signin')}
                >
                  Use a different email
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={mode === 'signin' ? handleSignIn : handleSignUp} className="space-y-4">
              {mode === 'signup' ? (
                <div>
                  <label htmlFor="name" className="mb-1 block text-sm font-medium text-stone-700">
                    Name
                  </label>
                  <input
                    id="name"
                    className="field"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Ada Lovelace"
                    autoComplete="name"
                  />
                </div>
              ) : null}

              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-stone-700">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  className="field"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </div>

              <div>
                <label htmlFor="password" className="mb-1 block text-sm font-medium text-stone-700">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  className="field"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  required
                />
                {mode === 'signup' ? (
                  <p className="mt-1.5 text-[11px] leading-snug text-stone-400">{PASSWORD_RULE}</p>
                ) : null}
              </div>

              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>
          )}

          {mode !== 'verify' ? (
            <>
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-stone-200" />
                <span className="text-[11px] uppercase tracking-wide text-stone-400">or</span>
                <span className="h-px flex-1 bg-stone-200" />
              </div>

              <div className="grid grid-cols-2 gap-2">
                {OAUTH_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className="btn-ghost"
                    onClick={() => handleOAuth(provider.id)}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        {mode !== 'verify' ? (
          <p className="mt-5 text-center text-sm text-stone-500">
            {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              className="font-medium text-stone-800 underline underline-offset-2"
              onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            >
              {mode === 'signin' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        ) : null}
      </div>
    </div>
  )
}
