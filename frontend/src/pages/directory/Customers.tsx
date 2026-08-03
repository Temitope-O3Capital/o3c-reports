import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, MONO, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DirectoryRow {
  cif:        string
  first_name: string
  last_name:  string
  phone:      string
  email:      string
  state:      string
  city:       string
  created_at: string
}

const PAGE_SIZE = 50

// ── Main component ──────────────────────────────────────────────────────────────

export default function CustomerDirectory() {
  const navigate = useNavigate()

  const [rows,    setRows]    = useState<DirectoryRow[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  const [search,   setSearch]   = useState('')
  const [debounced, setDebounced] = useState('')
  const [offset,   setOffset]   = useState(0)

  // Debounce the search box → resets to first page on query change.
  const searchRef = useRef(search)
  searchRef.current = search
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(searchRef.current); setOffset(0) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (debounced) p.set('q', debounced)
      const res = await apiFetch<{ data: DirectoryRow[]; total: number }>(`/api/customer360/directory?${p}`)
      setRows(Array.isArray(res?.data) ? res.data : [])
      setTotal(res?.total ?? 0)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [debounced, offset])

  useEffect(() => { load() }, [load])

  const page      = Math.floor(offset / PAGE_SIZE) + 1
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const from      = total === 0 ? 0 : offset + 1
  const to        = Math.min(offset + PAGE_SIZE, total)

  const TH: React.CSSProperties = {
    textAlign: 'left', padding: '9px 14px', fontSize: TEXT.xs, fontWeight: FW.bold,
    color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.04em',
    background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
  }
  const TD: React.CSSProperties = {
    padding: '10px 14px', fontSize: TEXT.sm, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)',
  }

  return (
    <Page title="Customer Directory" subtitle={`${fmtNum(total)} customers`}>
      <ErrBanner error={err} onRetry={load} />

      <SectionCard
        title="All Customers"
        badge={total}
        padding={false}
        actions={
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span className="material-symbols-rounded" style={{ position: 'absolute', left: 9, fontSize: 16, color: 'var(--txt3)', pointerEvents: 'none' }}>search</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, phone, email, CIF…"
              spellCheck={false}
              style={{
                width: 280, padding: '6px 10px 6px 30px', border: '1px solid var(--input-bdr)',
                borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)',
                color: 'var(--txt)', boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
          </div>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH}>Name</th>
                <th style={TH}>Phone</th>
                <th style={TH}>Email</th>
                <th style={TH}>State</th>
                <th style={TH}>CIF</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ ...TD, textAlign: 'center', padding: SP[10] }}>
                    <div style={{ display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ ...TD, textAlign: 'center', padding: SP[10], color: 'var(--txt3)' }}>
                    No customers found.
                  </td>
                </tr>
              ) : (
                rows.map(r => (
                  <tr
                    key={r.cif}
                    onClick={() => navigate(`/customers/${encodeURIComponent(r.cif)}`)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={TD}>
                      <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>
                        {`${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '—'}
                      </div>
                      {r.city && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{r.city}</div>}
                    </td>
                    <td style={{ ...TD, fontFamily: MONO, color: 'var(--txt2)' }}>{r.phone || '—'}</td>
                    <td style={{ ...TD, color: 'var(--txt2)' }}>{r.email || '—'}</td>
                    <td style={{ ...TD, color: 'var(--txt2)' }}>{r.state || '—'}</td>
                    <td style={{ ...TD, ...NUM, color: 'var(--txt3)' }}>{r.cif}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '11px 16px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {total === 0 ? 'No results' : `${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(total)}`}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>Page {page} / {pageCount}</span>
            <button
              onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0 || loading}
              style={{
                display: 'flex', alignItems: 'center', gap: 3, padding: '5px 11px', borderRadius: RADIUS.sm,
                border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)',
                fontSize: TEXT.sm, cursor: offset === 0 || loading ? 'not-allowed' : 'pointer',
                opacity: offset === 0 || loading ? 0.5 : 1, fontFamily: 'inherit',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>chevron_left</span>Prev
            </button>
            <button
              onClick={() => setOffset(o => o + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
              style={{
                display: 'flex', alignItems: 'center', gap: 3, padding: '5px 11px', borderRadius: RADIUS.sm,
                border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)',
                fontSize: TEXT.sm, cursor: offset + PAGE_SIZE >= total || loading ? 'not-allowed' : 'pointer',
                opacity: offset + PAGE_SIZE >= total || loading ? 0.5 : 1, fontFamily: 'inherit',
              }}
            >
              Next<span className="material-symbols-rounded" style={{ fontSize: 15 }}>chevron_right</span>
            </button>
          </div>
        </div>
      </SectionCard>
    </Page>
  )
}
