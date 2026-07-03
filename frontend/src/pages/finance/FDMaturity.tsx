import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, filterInputStyle, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtPct, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, INTER, SORA } from '../../lib/design'
import { toast } from 'sonner'

void today

// ── Types ─────────────────────────────────────────────────────────────────────

interface FDRecord {
  id: number
  transaction_date: string
  customer_name: string
  transaction_type: string
  principal: number
  interest_paid: number
  ngn_amount: number
  usd_amount: number
  currency: string
  location: string
  account_officer: string
  maturity_date: string
  tenor_days: number
  rate: number
  notes: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysToMaturity(maturityDate: string): number {
  const diff = new Date(maturityDate).getTime() - Date.now()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

function daysColor(days: number): string {
  if (days < 0) return RED
  if (days <= 7) return '#C00000'
  if (days <= 30) return AMBER
  return GREEN
}

function horizonLabel(h: string): string {
  const map: Record<string, string> = { '30': 'Next 30 days', '60': 'Next 60 days', '90': 'Next 90 days', '0': 'All active' }
  return map[h] ?? h
}

// ── Rollover / Liquidate actions ──────────────────────────────────────────────

function ActionButtons({ fd, onDone }: { fd: FDRecord; onDone: () => void }) {
  const [confirming, setConfirming] = useState<'rollover' | 'liquidate' | null>(null)
  const [busy, setBusy] = useState(false)

  async function execute(action: 'rollover' | 'liquidate') {
    setBusy(true)
    try {
      await apiFetch(`/api/fixed-deposit/transactions/${fd.id}/${action}`, { method: 'POST' })
      toast.success(`FD ${action === 'rollover' ? 'rolled over' : 'liquidated'} successfully`)
      onDone()
    } catch (e: any) {
      toast.error(e.message ?? `${action} failed`)
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  if (confirming) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11.5, color: 'var(--txt2)' }}>Confirm {confirming}?</span>
        <button onClick={() => execute(confirming)} disabled={busy} style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: confirming === 'rollover' ? 'rgba(22,163,74,.12)' : 'rgba(192,0,0,.08)', color: confirming === 'rollover' ? GREEN : RED, fontSize: 11.5, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? '…' : 'Yes'}</button>
        <button onClick={() => setConfirming(null)} disabled={busy} style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt2)', fontSize: 11.5, cursor: 'pointer' }}>No</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button onClick={e => { e.stopPropagation(); setConfirming('rollover') }} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(22,163,74,.1)', color: GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Rollover</button>
      <button onClick={e => { e.stopPropagation(); setConfirming('liquidate') }} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(192,0,0,.07)', color: RED, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Liquidate</button>
      <EarlyWithdrawalButton fd={fd} onDone={onDone} />
    </div>
  )
}

function EarlyWithdrawalButton({ fd, onDone }: { fd: FDRecord; onDone: () => void }) {
  const [saving, setSaving] = useState(false)

  async function request(e: React.MouseEvent) {
    e.stopPropagation()
    setSaving(true)
    try {
      const res = await apiPost<{ penalty_kobo: number; net_payout_kobo: number }>(
        `/api/fixed-deposit/transactions/${fd.id}/early-withdrawal-request`, {}
      )
      const penalty = res ? `Penalty: ₦${(res.penalty_kobo / 100).toLocaleString()} · Net: ₦${(res.net_payout_kobo / 100).toLocaleString()}` : ''
      toast.success(`Early withdrawal requested. ${penalty}`)
      onDone()
    } catch (e: any) {
      toast.error(e.message ?? 'Request failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      onClick={request}
      disabled={saving}
      style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(14,40,65,.07)', color: 'var(--txt2)', fontSize: 11.5, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}
    >
      {saving ? '…' : 'Early W/D'}
    </button>
  )
}

// ── Columns ───────────────────────────────────────────────────────────────────

function makeCols(onDone: () => void): TableCol<FDRecord>[] { return [
  { key: 'id', label: 'FD#', width: 90,
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>FD-{String(r.id).padStart(5, '0')}</span> },
  { key: 'customer_name', label: 'Investor', sortable: true,
    render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.customer_name || '—'}</span> },
  { key: 'principal', label: 'Amount', align: 'right', render: r => (
    <span style={{ ...NUM, fontWeight: 600 }}>
      {r.currency === 'USD' ? `$${(r.usd_amount / 100).toLocaleString()}` : fmtKobo(r.ngn_amount || r.principal)}
    </span>
  )},
  { key: 'rate', label: 'Rate', align: 'right', render: r => <span style={NUM}>{fmtPct(r.rate)}</span> },
  { key: 'maturity_date', label: 'Maturity', sortable: true, width: 100,
    render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
  { key: '_days', label: 'Days to Mat.', align: 'right', render: r => {
    const d = daysToMaturity(r.maturity_date)
    return (
      <span style={{ ...NUM, fontWeight: 700, color: daysColor(d) }}>
        {d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? 'TODAY' : `${d}d`}
      </span>
    )
  }},
  { key: 'location', label: 'Location',
    render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.location || '—'}</span> },
  { key: 'account_officer', label: 'Officer',
    render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.account_officer || '—'}</span> },
  { key: '_crosssell', label: '', width: 36, render: r => {
    const amountKobo = r.ngn_amount || r.principal * 100
    if (amountKobo < 50_000_000) return null // below ₦500k
    return (
      <span
        title="Cross-sell: FD ≥ ₦500k — offer credit card"
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: 'rgba(192,0,0,.1)', cursor: 'default' }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 13, color: RED }}>credit_card</span>
      </span>
    )
  }},
  { key: '_actions', label: '', render: r => <ActionButtons fd={r} onDone={onDone} /> },
]}

// ── Main page ─────────────────────────────────────────────────────────────────


function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: 6,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? RED : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span> : children}
    </button>
  )
}

const PER_PAGE = 25

export default function FinanceFDMaturity() {
  const [rows, setRows] = useState<FDRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [horizon, setHorizon] = useState('30')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch all active FD inflows; filter client-side by maturity horizon
      const res = await apiFetch<{ data: FDRecord[] }>('/api/fixed-deposit/transactions?transaction_type=inflow')
      const data: FDRecord[] = res?.data ?? []
      // Filter to inflow records maturing within horizon (or all if horizon='0')
      const now = Date.now()
      const horizonMs = Number(horizon) * 24 * 60 * 60 * 1000
      const filtered = data.filter(r => {
        if (r.transaction_type !== 'inflow') return false
        const maturityMs = new Date(r.maturity_date).getTime()
        if (horizon === '0') return maturityMs > now // all active
        return maturityMs > now && maturityMs <= now + horizonMs
      })
      // Sort soonest maturity first
      filtered.sort((a, b) => new Date(a.maturity_date).getTime() - new Date(b.maturity_date).getTime())
      setRows(filtered)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [horizon])

  useEffect(() => { load() }, [load])

  const displayed = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      r.customer_name.toLowerCase().includes(q) ||
      (r.account_officer || '').toLowerCase().includes(q) ||
      (r.location || '').toLowerCase().includes(q)
    )
  }, [rows, search])

  useEffect(() => { setPage(1) }, [search, horizon])

  const totalPages = Math.max(1, Math.ceil(displayed.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = displayed.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart  = displayed.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd    = Math.min(safePage * PER_PAGE, displayed.length)

  // Summary stats
  const totalPrincipal = rows.reduce((s, r) => s + (r.ngn_amount || r.principal), 0)
  const maturingThisWeek = rows.filter(r => daysToMaturity(r.maturity_date) <= 7).length

  function exportFDCsv(data: FDRecord[]) {
    const header = ['Customer', 'Currency', 'Amount ₦', 'Rate %', 'Start Date', 'Maturity Date', 'Tenor (days)', 'Account Officer', 'Location']
    const lines = data.map(r => [
      `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
      r.currency ?? '',
      ((r.ngn_amount || r.principal) / 100).toFixed(2),
      r.rate != null ? r.rate.toFixed(2) : '',
      r.transaction_date ?? '',
      r.maturity_date ?? '',
      r.tenor_days ?? '',
      `"${String(r.account_officer ?? '').replace(/"/g, '""')}"`,
      `"${String(r.location ?? '').replace(/"/g, '""')}"`,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `fd-maturity-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="FD Maturity Calendar"
      subtitle={`${rows.length} FDs maturing · ${horizonLabel(horizon)} · Total: ${fmtKobo(totalPrincipal)}`}
      actions={
        <select value={horizon} onChange={e => setHorizon(e.target.value)} style={filterInputStyle}>
          <option value="30">Next 30 days</option>
          <option value="60">Next 60 days</option>
          <option value="90">Next 90 days</option>
          <option value="0">All active</option>
        </select>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 6 }}>Maturing This Week</div>
          <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: maturingThisWeek > 0 ? RED : 'var(--txt)' }}>{maturingThisWeek}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 6 }}>Total Count</div>
          <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>{rows.length}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 6 }}>Total Principal</div>
          <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: 'var(--txt)', letterSpacing: '-0.6px' }}>{fmtKobo(totalPrincipal)}</div>
        </div>
      </div>

      {/* Colour legend */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 14 }}>
        {[
          { color: RED, label: 'Overdue' },
          { color: '#C00000', label: '≤7 days' },
          { color: AMBER, label: '8–30 days' },
          { color: GREEN, label: '>30 days' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
            <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{label}</span>
          </div>
        ))}
      </div>

      <SectionCard title="Maturing FDs" badge={displayed.length} padding={false}>

        {/* Search bar */}
        <div style={{
          padding: '12px 18px', borderBottom: '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
            {displayed.length} of {rows.length}
          </div>
        </div>

        <DataTable
          cols={makeCols(load)}
          rows={pageRows}
          keyFn={r => r.id}
          loading={loading}
          emptyText={`No FDs maturing in the ${horizonLabel(horizon).toLowerCase()}`}
          onExport={() => exportFDCsv(displayed)}
        />

        {/* Pagination footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
            {displayed.length === 0
              ? 'No FDs found'
              : `Showing ${showStart}–${showEnd} of ${displayed.length} FDs`}
          </span>
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <PageBtn icon="chevron_left" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} />
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pg: number
                if (totalPages <= 7) pg = i + 1
                else if (safePage <= 4) pg = i + 1
                else if (safePage >= totalPages - 3) pg = totalPages - 6 + i
                else pg = safePage - 3 + i
                return <PageBtn key={pg} active={pg === safePage} onClick={() => setPage(pg)}>{pg}</PageBtn>
              })}
              <PageBtn icon="chevron_right" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} />
            </div>
          )}
        </div>

      </SectionCard>
    </Page>
  )
}
