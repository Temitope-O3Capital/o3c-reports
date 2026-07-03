import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, SearchInput } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, INTER, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BillingCycle {
  id: number
  product: string
  cycle_start: string
  cycle_end: string
  accounts_count: number
  total_balance_kobo: number
  statements_generated: number
  status: string
}

// ── Status config ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  open:       { bg: 'rgba(22,163,74,.1)',   txt: GREEN },
  processing: { bg: 'rgba(217,119,6,.12)',  txt: AMBER },
  closed:     { bg: 'rgba(107,114,128,.1)', txt: '#6B7280' },
  pending:    { bg: 'rgba(14,40,65,.08)',   txt: NAVY },
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: c.bg, color: c.txt, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{status}</span>
  )
}

// ── Expand panel ──────────────────────────────────────────────────────────────

function ExpandPanel({ cycle }: { cycle: BillingCycle }) {
  const sentPct = cycle.accounts_count > 0
    ? Math.round((cycle.statements_generated / cycle.accounts_count) * 100)
    : 0

  return (
    <div style={{ background: '#F8FAFC', borderTop: '1px solid var(--bdr)', padding: '16px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
          {cycle.product} — {fmtDate(cycle.cycle_start)} to {fmtDate(cycle.cycle_end)}
        </span>
        <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
          {cycle.statements_generated} / {cycle.accounts_count} statements sent
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bdr)', overflow: 'hidden' }}>
          <div style={{ width: `${sentPct}%`, height: '100%', background: sentPct === 100 ? GREEN : AMBER, borderRadius: 4, transition: 'width .3s' }} />
        </div>
        <span style={{ ...NUM, fontSize: 12, fontWeight: 700, color: sentPct === 100 ? GREEN : AMBER, minWidth: 36 }}>{sentPct}%</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        {[
          { label: 'Accounts', value: fmtNum(cycle.accounts_count) },
          { label: 'Total Balance', value: fmtKobo(Number(cycle.total_balance_kobo)) },
          { label: 'Statements Sent', value: fmtNum(cycle.statements_generated) },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 4 }}>{label}</div>
            <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Cycle row ─────────────────────────────────────────────────────────────────

function CycleRow({ cycle, expanded, onToggle }: { cycle: BillingCycle; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ borderBottom: expanded ? 'none' : '1px solid var(--bdr)', cursor: 'pointer' }}
        className="table-row-hover"
      >
        <td style={{ padding: '12px 18px' }}>
          <span className="material-symbols-rounded" style={{
            fontSize: 16, color: 'var(--txt3)', verticalAlign: 'middle', marginRight: 6,
            transition: 'transform .15s', transform: expanded ? 'rotate(90deg)' : 'none', display: 'inline-block',
          }}>chevron_right</span>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{cycle.product}</span>
        </td>
        <td style={{ padding: '12px 18px', fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(cycle.cycle_start)}</td>
        <td style={{ padding: '12px 18px', fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(cycle.cycle_end)}</td>
        <td style={{ padding: '12px 18px', textAlign: 'right', ...NUM }}>{fmtNum(Number(cycle.accounts_count))}</td>
        <td style={{ padding: '12px 18px', textAlign: 'right', ...NUM, fontWeight: 600 }}>{fmtKobo(Number(cycle.total_balance_kobo))}</td>
        <td style={{ padding: '12px 18px', textAlign: 'right', ...NUM, color: cycle.statements_generated === cycle.accounts_count && cycle.accounts_count > 0 ? GREEN : 'var(--txt2)' }}>
          {fmtNum(Number(cycle.statements_generated))} / {fmtNum(Number(cycle.accounts_count))}
        </td>
        <td style={{ padding: '12px 18px' }}><StatusPill status={cycle.status} /></td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ padding: 0, borderBottom: '1px solid var(--bdr)' }}>
            <ExpandPanel cycle={cycle} />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CardsBilling() {
  const [rows,      setRows]      = useState<BillingCycle[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [search,    setSearch]    = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<BillingCycle[]>('/api/cards/billing')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function generateCycles() {
    setGenerating(true)
    try {
      await apiFetch('/api/cards/billing/generate', { method: 'POST' })
      toast.success('Billing cycles generated for current month')
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const displayed = useMemo(() => rows.filter(c => {
    if (statusFilter && c.status !== statusFilter) return false
    if (search && !c.product.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [rows, search, statusFilter])

  const openCycles        = rows.filter(c => c.status === 'open').length
  const pendingStatements = rows.reduce((s, c) => s + (Number(c.accounts_count) - Number(c.statements_generated)), 0)
  const products          = new Set(rows.map(c => c.product)).size

  return (
    <Page
      title="Billing Cycles"
      subtitle="Monthly billing periods and statement generation"
      actions={
        <button
          onClick={generateCycles}
          disabled={generating}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9,
            border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700,
            cursor: generating ? 'default' : 'pointer', fontFamily: INTER, opacity: generating ? .7 : 1,
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span>
          {generating ? 'Generating…' : 'Generate Current Month'}
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Open Cycles',         value: openCycles, color: GREEN },
          { label: 'Statements Pending',  value: pendingStatements.toLocaleString(), color: pendingStatements > 0 ? AMBER : 'var(--txt)' },
          { label: 'Products',            value: products, color: 'var(--txt)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 6 }}>{label}</div>
            <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="Billing Cycles" badge={displayed.length} padding={false}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="processing">Processing</option>
            <option value="closed">Closed</option>
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{displayed.length} cycles</span>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--th-bg)' }}>
              {['Product', 'Cycle Start', 'Cycle End', 'Accounts', 'Total Balance', 'Statements', 'Status'].map(h => (
                <th key={h} style={{
                  padding: '10px 18px',
                  textAlign: ['Accounts', 'Total Balance', 'Statements'].includes(h) ? 'right' : 'left',
                  fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase',
                  letterSpacing: '.4px', borderBottom: '1px solid var(--bdr)',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--txt3)' }}>Loading…</td></tr>
            ) : displayed.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: 48, textAlign: 'center', color: 'var(--txt3)', fontSize: 13 }}>
                  <div style={{ marginBottom: 12 }}>No billing cycles yet.</div>
                  <button onClick={generateCycles} disabled={generating} style={{
                    padding: '8px 18px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff',
                    fontSize: 13, fontWeight: 700, cursor: generating ? 'default' : 'pointer', fontFamily: INTER,
                  }}>Generate Current Month Cycles</button>
                </td>
              </tr>
            ) : displayed.map(c => (
              <CycleRow
                key={c.id}
                cycle={c}
                expanded={expandedId === c.id}
                onToggle={() => setExpandedId(id => id === c.id ? null : c.id)}
              />
            ))}
          </tbody>
        </table>
      </SectionCard>
    </Page>
  )
}

void RED
