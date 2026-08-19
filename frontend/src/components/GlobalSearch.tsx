import { useState, useEffect, useRef, useCallback } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { SORA, MONO } from '../lib/design'
import { apiFetch } from '../lib/api'

interface SearchResult {
  type:  'contact' | 'application' | 'ticket' | 'customer'
  id:    string
  label: string
  sub:   string
  url:   string
}

const MODULE_SHORTCUTS = [
  { label: 'Collections: today\'s queue', url: '/collections', kbd: 'G C' },
  { label: 'Mail: inbox',                 url: '/mail/inbox',  kbd: 'G M' },
  { label: 'Overview: dashboard',         url: '/',            kbd: 'G O' },
  { label: 'Reports & BI',                 url: '/reports',     kbd: 'G R' },
]

// Result groups, in the order the palette lists them. The backend tags every hit with
// one of these types; each group renders only when it has matches.
const GROUPS: { type: SearchResult['type']; label: string }[] = [
  { type: 'customer',    label: 'Customers' },
  { type: 'ticket',      label: 'Tickets' },
  { type: 'application', label: 'Applications' },
  { type: 'contact',     label: 'Contacts' },
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
  const seq       = useRef(0)

  useEffect(() => {
    if (open) {
      setQuery(''); setResults([])
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback((q: string) => {
    if (debounce.current) clearTimeout(debounce.current)
    if (q.trim().length < 2) { setResults([]); setLoading(false); return }
    setLoading(true)
    const mySeq = ++seq.current
    debounce.current = setTimeout(async () => {
      try {
        // Backend wraps the array in { data: [...] }; tolerate a bare array too.
        const data = await apiFetch<SearchResult[] | { data?: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q.trim())}`)
        if (mySeq !== seq.current) return   // a newer keystroke already superseded this
        setResults(Array.isArray(data) ? data : (data?.data ?? []))
      } catch {
        if (mySeq === seq.current) setResults([])
      } finally {
        if (mySeq === seq.current) setLoading(false)
      }
    }, 200)
  }, [])

  function go(url: string) { navigate(url); onClose() }

  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [query, results])

  if (!open) return null

  const showModules = !query
  const showCustomers = results.length > 0
  const noResults = query.length >= 2 && !loading && results.length === 0

  // Flat, ordered list of every navigable row in the exact order they render, so the
  // arrow keys and Enter can move a highlight through modules (empty query) or grouped
  // results (active query). A row's index is its position in this array.
  const targets: string[] = showModules
    ? [...MODULE_SHORTCUTS.map(m => m.url), '/mail/compose']
    : GROUPS.flatMap(({ type }) => results.filter(r => r.type === type).slice(0, 6).map(r => r.url))

  function onKey(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown')     { e.preventDefault(); setActive(a => Math.min(a + 1, targets.length - 1)) }
    else if (e.key === 'ArrowUp')  { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter')    { e.preventDefault(); if (targets[active]) go(targets[active]) }
  }

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
          onKeyDown={onKey}
          placeholder="Search customers, tickets, CIF, phone…"
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
                  onMouseEnter={() => setActive(targets.indexOf(m.url))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 18px', cursor: 'pointer',
                    fontSize: 12.5, color: 'var(--txt)',
                    fontFamily: SORA,
                    transition: 'background .1s',
                    background: targets[active] === m.url ? 'var(--row-hvr)' : 'transparent',
                  }}
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

          {showCustomers && GROUPS.map(({ type, label }) => {
            const rows = results.filter(r => r.type === type).slice(0, 6)
            if (rows.length === 0) return null
            return (
              <div key={type}>
                <div style={{
                  fontSize: 9.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase',
                  color: 'var(--txt3)', padding: '8px 18px 4px', fontFamily: MONO,
                }}>
                  {label}
                </div>
                {rows.map(r => (
                  <div
                    key={`${r.type}-${r.id}`}
                    onClick={() => go(r.url)}
                    onMouseEnter={() => setActive(targets.indexOf(r.url))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 18px', cursor: 'pointer',
                      fontSize: 12.5, color: 'var(--txt)',
                      fontFamily: SORA,
                      transition: 'background .1s',
                      background: targets[active] === r.url ? 'var(--row-hvr)' : 'transparent',
                    }}
                  >
                    <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
                    {r.sub && <span style={{ fontSize: 11, color: 'var(--txt3)', flexShrink: 0, maxWidth: '55%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sub}</span>}
                  </div>
                ))}
              </div>
            )
          })}

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
                onMouseEnter={() => setActive(targets.indexOf('/mail/compose'))}
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '8px 18px', cursor: 'pointer',
                  fontSize: 12.5, color: 'var(--txt)',
                  fontFamily: SORA,
                  transition: 'background .1s',
                  background: targets[active] === '/mail/compose' ? 'var(--row-hvr)' : 'transparent',
                }}
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
