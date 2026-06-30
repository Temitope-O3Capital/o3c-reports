import { StrictMode, Component, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(e: Error) { return { error: e } }
  render() {
    if (this.state.error) {
      const e = this.state.error as Error
      const isDev = import.meta.env.DEV
      return (
        <div style={{ fontFamily: 'system-ui, sans-serif', padding: 32, background: '#fff', minHeight: '100vh' }}>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 20, maxWidth: 600 }}>
            <p style={{ color: '#b91c1c', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
              Something went wrong
            </p>
            <p style={{ color: '#7f1d1d', fontSize: 14, marginBottom: 12 }}>
              Please reload the page. If this keeps happening, contact IT support.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{ background: '#0E2841', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 13, cursor: 'pointer' }}>
              Reload page
            </button>
            {isDev && (
              <details style={{ marginTop: 16 }}>
                <summary style={{ color: '#991b1b', fontSize: 12, cursor: 'pointer' }}>{e.name}: {e.message}</summary>
                <pre style={{ color: '#991b1b', fontSize: 11, marginTop: 8, whiteSpace: 'pre-wrap', opacity: 0.8 }}>{e.stack}</pre>
              </details>
            )}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const root = document.getElementById('root')
if (!root) {
  document.body.innerHTML = '<pre style="color:red;padding:32px">FATAL: #root element not found</pre>'
} else {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}
