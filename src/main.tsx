import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { applyTheme, savedTheme } from './theme'
import { UpdateBanner } from './update'

applyTheme(savedTheme())

// After a new version ships, a phone still running the old page asks for code files that no longer exist
// (catalog/invoice PDFs, the scanner, Production/Nursery). Reload once to get the new version instead of failing.
window.addEventListener('vite:preloadError', e => {
  let last = 0
  try { last = Number(sessionStorage.getItem('fm.reloadedAt') ?? 0) } catch { /* private */ }
  if (Date.now() - last < 30000) return            // already tried; let the error show
  e.preventDefault()
  try { sessionStorage.setItem('fm.reloadedAt', String(Date.now())) } catch { /* private */ }
  location.reload()
})

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div className="center">
        <h2>Something went wrong</h2>
        <p className="muted">{this.state.err.message}</p>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
    <UpdateBanner />
  </React.StrictMode>,
)
