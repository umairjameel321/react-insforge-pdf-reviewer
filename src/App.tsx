import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { Spinner } from './components/Spinner'
import { useAuth } from './lib/auth'
import AuthPage from './pages/AuthPage'
import ChatPage from './pages/ChatPage'
import LibraryPage from './pages/LibraryPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  // Never redirect while the session is still rehydrating, or an OAuth return
  // would bounce the user straight back to the sign-in page.
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Restoring your session" />
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />
  }

  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <LibraryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/c/:sessionId"
        element={
          <RequireAuth>
            <ChatPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
