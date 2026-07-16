import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER } from '../../lib/design'

interface CCStatement {
  id: number
  customer_name: string
  account_number: string
  statement_date: string
  payment_due_date?: string
  line_of_credit_kobo?: number
  closing_balance_kobo: number
  total_debit_kobo: number
  total_credit_kobo: number
  min_payment_kobo?: number
  source: 'upload' | 'db'
  source_filename?: string
  created_at: string
  created_by_name?: string
  txn_count: number
}

const SOURCE_META = {
  upload: { label: 'File Upload', icon: 'upload_file', color: '#1D4ED8' },
  db:     { label: 'From DB',     icon: 'storage',      color: '#7C3AED' },
}

function SourceBadge({ source }: { source: 'upload' | 'db' }) {
  const m = SOURCE_META[source] ?? SOURCE_META.upload
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 600, borderRadius: 12,
      padding: '2px 8px',
      background: m.color + '18', color: m.color,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{m.icon}</span>
      {m.label}
    </span>
  )
}

export default function CCStatements() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<CCStatement[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('account_number', search)
    if (sourceFilter) params.set('source', sourceFilter)
    apiFetch(`/api/cc-statements?${params}`)
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d?.data) ? d.data : []))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [search, sourceFilter]) // eslint-disable-line

  const overLimit = (s: CCStatement) =>
    s.line_of_credit_kobo && s.closing_balance_kobo > s.line_of_credit_kobo

  return (
    <Page
      title="Credit Card Statements"
      subtitle="Parsed from file uploads or synthesised from transaction records"
      actions={
        <button
          onClick={() => navigate('/statements/credit-cards/new')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: RED, color: '#fff', border: 'none', borderRadius: 6,
            padding: '8px 16px', fontWeight: 600, fontSize: 13, cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>add</span>
          New Statement
        </button>
      }
    >
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 220px' }}>
          <span className="material-symbols-rounded" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: '#94A3B8' }}>search</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Account number…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px 9px 32px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, outline: 'none' }}
          />
        </div>
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value)}
          style={{ padding: '9px 12px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, background: '#fff', color: NAVY }}
        >
          <option value="">All sources</option>
          <option value="upload">File Upload</option>
          <option value="db">From DB</option>
        </select>
      </div>

      <SectionCard>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#94A3B8', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 40, color: '#CBD5E1', display: 'block', marginBottom: 12 }}>receipt_long</span>
            <div style={{ fontSize: 14, color: '#64748B' }}>No statements yet</div>
            <button
              onClick={() => navigate('/statements/credit-cards/new')}
              style={{ marginTop: 16, padding: '8px 18px', background: RED, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              Add first statement
            </button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Customer', 'Account', 'Statement Date', 'Closing Balance', 'Debits', 'Credits', 'Txns', 'Source', 'Added'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(s => (
                  <tr
                    key={s.id}
                    onClick={() => navigate(`/statements/credit-cards/${s.id}`)}
                    style={{ borderBottom: '1px solid #F1F5F9', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                  >
                    <td style={{ padding: '12px 14px', fontWeight: 500, color: NAVY }}>{s.customer_name}</td>
                    <td style={{ padding: '12px 14px', fontFamily: 'DM Mono, monospace', fontSize: 12 }}>{s.account_number}</td>
                    <td style={{ padding: '12px 14px' }}>{fmtDate(s.statement_date)}</td>
                    <td style={{ padding: '12px 14px', fontFamily: 'DM Mono, monospace', fontWeight: 600, color: overLimit(s) ? RED : NAVY }}>
                      {fmtKobo(s.closing_balance_kobo)}
                      {overLimit(s) && (
                        <span title="Over credit limit" style={{ marginLeft: 6 }}>
                          <span className="material-symbols-rounded" style={{ fontSize: 13, color: RED, verticalAlign: 'middle' }}>warning</span>
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '12px 14px', fontFamily: 'DM Mono, monospace', color: RED }}>{fmtKobo(s.total_debit_kobo)}</td>
                    <td style={{ padding: '12px 14px', fontFamily: 'DM Mono, monospace', color: GREEN }}>{fmtKobo(s.total_credit_kobo)}</td>
                    <td style={{ padding: '12px 14px', textAlign: 'center' }}>{s.txn_count}</td>
                    <td style={{ padding: '12px 14px' }}><SourceBadge source={s.source} /></td>
                    <td style={{ padding: '12px 14px', color: '#94A3B8', fontSize: 12 }}>{fmtDate(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
