import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { NAVY, INTER } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchResult {
  type:  'contact' | 'application' | 'ticket' | 'customer'
  id:    string
  label: string
  sub:   string
  url:   string
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const TYPE_ICON: Record<string, string> = {
  contact:     'contacts',
  application: 'description',
  ticket:      'confirmation_number',
  customer:    'person',
}

const TYPE_LABEL: Record<string, string> = {
  contact:     'Contact',
  application: 'Application',
  ticket:      'Ticket',
  customer:    'Customer',
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  open:    boolean
  onClose: () => void
}

export default function GlobalSearch({ open, onClose }: Props) {
  const navigate  = useNavigate()
  const inputRef  = useRef<HTMLInputElement>(null)
  const listRef   = useRef<HTMLDivElement>(null)

  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [active,  setActive]  = useState(0)
  const debounce  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery(''); setResults([]); setActive(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Debounced search
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
        setActive(0)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 220)
  }, [])

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value
    setQuery(q)
    search(q)
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape')      { onClose(); return }
    if (e.key === 'ArrowDown')   { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); return }
    if (e.key === 'ArrowUp')     { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return }
    if (e.key === 'Enter' && results[active]) {
      go(results[active])
    }
  }

  function go(r: SearchResult) {
    navigate(r.url)
    onClose()
  }

  // Keep active item scrolled into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '10vh',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 560,
          background: 'var(--card)',
          border: '1px solid var(--bdr)',
          borderRadius: 14,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          overflow: 'hidden',
          fontFamily: INTER,
        }}
      >
        {/* Search input row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--bdr)' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: 'var(--txt3)', flexShrink: 0 }}>search</span>
          <input
            ref={inputRef}
            value={query}
            onChange={handleInput}
            onKeyDown={handleKey}
            placeholder="Search customers, applications, tickets…"
            style={{
              flex: 1, border: 'none', outline: 'none',
              background: 'transparent',
              fontSize: 14, color: 'var(--txt)',
              fontFamily: INTER,
            }}
          />
          {loading && (
            <span style={{ fontSize: 12, color: 'var(--txt3)', flexShrink: 0 }}>…</span>
          )}
          <kbd style={{
            flexShrink: 0, padding: '2px 6px',
            border: '1px solid var(--bdr)', borderRadius: 5,
            fontSize: 11, color: 'var(--txt3)',
            fontFamily: INTER,
          }}>Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} style={{ maxHeight: 360, overflowY: 'auto' }}>
          {results.length === 0 && query.length >= 2 && !loading && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              No results for "{query}"
            </div>
          )}
          {results.length === 0 && query.length < 2 && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              Type at least 2 characters to search
            </div>
          )}
          {results.map((r, i) => (
            <div
              key={`${r.type}-${r.id}`}
              data-idx={i}
              onClick={() => go(r)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 16px',
                cursor: 'pointer',
                background: i === active ? `${NAVY}10` : 'transparent',
                borderLeft: i === active ? `3px solid ${NAVY}` : '3px solid transparent',
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span
                className="material-symbols-rounded"
                style={{ fontSize: 18, color: i === active ? NAVY : 'var(--txt3)', flexShrink: 0 }}
              >
                {TYPE_ICON[r.type] ?? 'circle'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.label}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.sub}
                </div>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                color: i === active ? NAVY : 'var(--txt3)',
                flexShrink: 0,
              }}>
                {TYPE_LABEL[r.type] ?? r.type}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--bdr)',
          display: 'flex', gap: 16,
          fontSize: 11, color: 'var(--txt3)',
          fontFamily: INTER,
        }}>
          <span><kbd style={{ padding: '1px 5px', border: '1px solid var(--bdr)', borderRadius: 4, fontSize: 11 }}>↑↓</kbd> navigate</span>
          <span><kbd style={{ padding: '1px 5px', border: '1px solid var(--bdr)', borderRadius: 4, fontSize: 11 }}>↵</kbd> open</span>
          <span><kbd style={{ padding: '1px 5px', border: '1px solid var(--bdr)', borderRadius: 4, fontSize: 11 }}>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
