import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Button, Input, Select, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate, monthStart, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, BLUE, PURPLE, MONO, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

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
  upload: { label: 'File Upload', icon: 'upload_file', color: BLUE },
  db:     { label: 'From DB',     icon: 'storage',      color: PURPLE },
}

function SourceBadge({ source }: { source: 'upload' | 'db' }) {
  const m = SOURCE_META[source] ?? SOURCE_META.upload
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: TEXT.xs, fontWeight: FW.semibold, borderRadius: RADIUS.xl,
      padding: '2px 8px',
      background: m.color + '18', color: m.color,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>{m.icon}</span>
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
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('account_number', search)
    if (sourceFilter) params.set('source', sourceFilter)
    if (dateFrom) params.set('from', dateFrom)
    if (dateTo)   params.set('to', dateTo)
    apiFetch<any>(`/api/cc-statements?${params}`)
      .then(d => setRows(Array.isArray(d?.data) ? d.data : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [search, sourceFilter, dateFrom, dateTo]) // eslint-disable-line

  const overLimit = (s: CCStatement) =>
    s.line_of_credit_kobo && s.closing_balance_kobo > s.line_of_credit_kobo

  return (
    <Page
      title="Credit Card Statements"
      subtitle="Parsed from file uploads or synthesised from transaction records"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <Button variant="danger" icon="add" onClick={() => navigate('/statements/credit-cards/new')}>
            New Statement
          </Button>
        </div>
      }
    >
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: SP[5], flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Account number…"
            prefix="search"
          />
        </div>
        <Select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="">All sources</option>
          <option value="upload">File Upload</option>
          <option value="db">From DB</option>
        </Select>
      </div>

      <SectionCard>
        {loading ? (
          <div style={{ textAlign: 'center', padding: SP[12], color: 'var(--txt3)', fontSize: TEXT.base }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: SP[12] }}>
            <span className="material-symbols-rounded" style={{ fontSize: 40, color: 'var(--txt3)', display: 'block', marginBottom: SP[3] }}>receipt_long</span>
            <div style={{ fontSize: TEXT.md, color: 'var(--txt2)' }}>No statements yet</div>
            <Button
              variant="danger"
              onClick={() => navigate('/statements/credit-cards/new')}
              style={{ marginTop: SP[4] }}
            >
              Add first statement
            </Button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Customer', 'Account', 'Statement Date', 'Closing Balance', 'Debits', 'Credits', 'Txns', 'Source', 'Added'].map(h => (
                    <th key={h} style={{ padding: `${SP[2]} ${SP[4]}`, textAlign: 'left', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
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
                    style={{ borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                  >
                    <td style={{ padding: `${SP[3]} ${SP[4]}`, fontWeight: FW.medium, color: NAVY }}>{s.customer_name}</td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}`, ...NUM, fontSize: TEXT.sm }}>{s.account_number}</td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}` }}>{fmtDate(s.statement_date)}</td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}`, ...NUM, fontWeight: FW.semibold, color: overLimit(s) ? RED : NAVY }}>
                      {fmtKobo(s.closing_balance_kobo)}
                      {overLimit(s) && (
                        <span title="Over credit limit" style={{ marginLeft: 6 }}>
                          <span className="material-symbols-rounded" style={{ fontSize: TEXT.base, color: RED, verticalAlign: 'middle' }}>warning</span>
                        </span>
                      )}
                    </td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}`, ...NUM, color: RED }}>{fmtKobo(s.total_debit_kobo)}</td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}`, ...NUM, color: GREEN }}>{fmtKobo(s.total_credit_kobo)}</td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}`, textAlign: 'center' }}>{s.txn_count}</td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}` }}><SourceBadge source={s.source} /></td>
                    <td style={{ padding: `${SP[3]} ${SP[4]}`, color: 'var(--txt3)', fontSize: TEXT.sm }}>{fmtDate(s.created_at)}</td>
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
