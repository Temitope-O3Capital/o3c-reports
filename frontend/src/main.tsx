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
      return (
        <div style={{ fontFamily: 'monospace', padding: 32, background: '#fff', minHeight: '100vh' }}>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 20, maxWidth: 800 }}>
            <p style={{ color: '#b91c1c', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
              Render error — {e.name}
            </p>
            <pre style={{ color: '#7f1d1d', fontSize: 13, whiteSpace: 'pre-wrap', margin: 0 }}>{e.message}</pre>
            {e.stack && (
              <pre style={{ color: '#991b1b', fontSize: 11, marginTop: 12, whiteSpace: 'pre-wrap', opacity: 0.7 }}>
                {e.stack}
              </pre>
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
