import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { insforge } from './insforge'

interface AuthUser {
  id: string
  email?: string
  profile?: { name?: string; avatar_url?: string } | null
}

interface AuthState {
  user: AuthUser | null
  /** True until the cold-load session refresh settles. Gate UI on this. */
  loading: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const { data, error } = await insforge.auth.getCurrentUser()
    setUser(error ? null : ((data?.user as AuthUser) ?? null))
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function hydrate() {
      // On a cold load the access token lives only in memory, so the SDK has to
      // round-trip the httpOnly refresh cookie before a user is known.
      const { data, error } = await insforge.auth.getCurrentUser()
      if (cancelled) return
      setUser(error ? null : ((data?.user as AuthUser) ?? null))
      setLoading(false)
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [])

  const signOut = useCallback(async () => {
    await insforge.auth.signOut()
    setUser(null)
  }, [])

  const value = useMemo(() => ({ user, loading, refresh, signOut }), [user, loading, refresh, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
