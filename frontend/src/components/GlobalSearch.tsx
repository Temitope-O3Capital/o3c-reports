import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { SORA, MONO } from '../lib/design'

interface SearchResult {
  type:  'contact' | 'application' | 'ticket' | 'customer'
  id:    string
  label: string
  sub:   string
  url:   string
}

const MODULE_SHORTCUTS = [
  { label: 'Collections — today\'s queue', url: '/collections', kbd: 'G C' },
  { label: 'Mail — inbox',                 url: '/mail/inbox',  kbd: 'G M' },
  { label: 'Overview — dashboard',         url: '/',            kbd: 'G O' },
  { label: 'Reports & BI',                 url: '/reports',     kbd: 'G R' },
]

interface Props {
  open:    boolean
  onClose: () => void
}

export default function GlobalSearch({ open, onClose }: Props) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const debounce  = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) {
      setQuery(''); setResults([])
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback((q: string) => {
    if (debounce.current) clearTimeout(debounce.current)
    if (q.length < 2) { setResults([]); setLoading(false); return }
    setLoading(true)
    debounce.current = setTimeout(async () => {
      try {
        const token = localStorage.getItem('token') ?? ''
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error()
        const data: SearchResult[] = await res.json()
        setResults(data)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 220)
  }, [])

  function go(url: string) { navigate(url); onClose() }

  if (!open) return null

  const showModules = !query
  const showCustomers = results.length > 0
  const noResults = query.length >= 2 && !loading && results.length === 0

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(14,40,65,.4)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '14vh',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '92vw', maxWidth: 520,
          background: 'var(--card)',
          borderRadius: 6,
          boxShadow: '0 20px 60px rgba(0,0,0,.35)',
          overflow: 'hidden',
        }}
      >
        {/* Input */}
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); search(e.target.value) }}
          onKeyDown={e => e.key === 'Escape' && onClose()}
          placeholder="Search modules, customers, CIF numbers…"
          style={{
            width: '100%', border: 'none', outline: 'none',
            background: 'none', color: 'var(--txt)',
            fontFamily: SORA, fontSize: 14,
            padding: '15px 18px',
            borderBottom: '1px solid var(--bdr)',
            boxSizing: 'border-box',
          }}
        />

        {/* List */}
        <div style={{ maxHeight: 300, overflowY: 'auto', padding: '6px 0' }}>
          {/* Modules group */}
          {showModules && (
            <>
              <div style={{
                fontSize: 9.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase',
                color: 'var(--txt3)', padding: '8px 18px 4px', fontFamily: MONO,
              }}>
                Modules
              </div>
              {MODULE_SHORTCUTS.map(m => (
                <div
                  key={m.url}
                  onClick={() => go(m.url)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 18px', cursor: 'pointer',
                    fontSize: 12.5, color: 'var(--txt)',
                    fontFamily: SORA,
                    transition: 'background .1s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <span style={{ flex: 1 }}>{m.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--txt3)' }}>{m.kbd}</span>
                </div>
              ))}
            </>
          )}

          {/* Customer search results */}
          {loading && (
            <div style={{ padding: '16px 18px', fontSize: 12.5, color: 'var(--txt3)', fontFamily: SORA }}>
              Searching…
            </div>
          )}

          {noResults && (
            <div style={{ padding: '16px 18px', fontSize: 12.5, color: 'var(--txt3)', fontFamily: SORA }}>
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {showCustomers && (
            <>
              <div style={{
                fontSize: 9.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase',
                color: 'var(--txt3)', padding: '8px 18px 4px', fontFamily: MONO,
              }}>
                Customers
              </div>
              {results.slice(0, 5).map(r => (
                <div
                  key={`${r.type}-${r.id}`}
                  onClick={() => go(r.url)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 18px', cursor: 'pointer',
                    fontSize: 12.5, color: 'var(--txt)',
                    fontFamily: SORA,
                    transition: 'background .1s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <span style={{ fontSize: 11, color: 'var(--txt3)', fontFamily: MONO, flexShrink: 0 }}>{r.id}</span>
                  <span style={{ flex: 1 }}>{r.label}</span>
                  {r.sub && <span style={{ fontSize: 11, color: 'var(--txt3)' }}>{r.sub}</span>}
                </div>
              ))}
            </>
          )}

          {/* Actions group — always visible when no query */}
          {showModules && (
            <>
              <div style={{
                fontSize: 9.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase',
                color: 'var(--txt3)', padding: '8px 18px 4px', fontFamily: MONO,
              }}>
                Actions
              </div>
              <div
                onClick={() => go('/mail/compose')}
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '8px 18px', cursor: 'pointer',
                  fontSize: 12.5, color: 'var(--txt)',
                  fontFamily: SORA,
                  transition: 'background .1s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                Compose a message
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
